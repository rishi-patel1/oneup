import assert from 'node:assert/strict';
import test from 'node:test';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createCompetitionApi, explainError } from './api';

const userId = '11111111-1111-4111-8111-111111111111';
const roomId = '33333333-3333-4333-8333-333333333333';
const targetId = 'abcdef12-abcd-4abc-8abc-abcdef123456';
const now = '2026-11-19T12:00:00.000Z';
const spectatorPuzzle = {
  id: `match-${roomId}`, title: 'A shared challenge', description: 'Every cell counts.', size: 5,
  difficulty: 'Easy' as const, givens: [1, ...Array<number>(24).fill(0)],
  rightWalls: Array<boolean>(25).fill(true), bottomWalls: Array<boolean>(25).fill(true),
};

function mockClient() {
  let signedIn = false;
  let blocked = false;
  let signups = 0;
  let sessionReads = 0;
  let removed = 0;
  let channels = 0;
  const rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
  const functionCalls: unknown[] = [];
  const signals: AbortSignal[] = [];
  const handlers: { type: string; callback: () => void }[] = [];
  const lobby = {
    room: { id: roomId, code: 'ABC123', host_id: userId, status: 'lobby', size: 5, difficulty: 'Easy', starts_at: null, created_at: now },
    players: [{ user_id: userId, nickname: 'Player', ready: false, progress_count: 0, finished_at: null, elapsed_ms: null, joined_at: now }],
    puzzle: null, self: null, server_now: now,
  };
  let rpcData: unknown = lobby;
  let rpcError: unknown = null;
  const channel = {
    on(type: string, _filter: unknown, callback: () => void) { handlers.push({ type, callback }); return channel; },
    subscribe(callback: (status: string) => void) { callback('SUBSCRIBED'); return channel; },
    track: async () => 'ok',
    presenceState: () => ({ current: [{ user_id: userId }, { user_id: userId }] }),
  };
  const service = {
    auth: {
      getSession: async () => { sessionReads++; return { data: { session: signedIn ? { user: { id: userId } } : null }, error: null }; },
      signInAnonymously: async () => {
        signups++;
        await Promise.resolve();
        if (blocked) return { data: { user: null }, error: { code: 'anonymous_provider_disabled', message: 'Anonymous sign-ins are disabled' } };
        signedIn = true;
        return { data: { user: { id: userId } }, error: null };
      },
    },
    rpc: (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      const response = Promise.resolve({ data: rpcData, error: rpcError });
      return Object.assign(response, { abortSignal: (signal: AbortSignal) => { signals.push(signal); return response; } });
    },
    functions: { invoke: async (...args: unknown[]) => { functionCalls.push(args); return { data: { code: 'ABC123' }, error: null }; } },
    channel: () => { channels++; return channel; },
    removeChannel: async () => { removed++; return 'ok'; },
  };
  return {
    service: service as unknown as SupabaseClient, handlers, rpcCalls, functionCalls, signals,
    block: (value: boolean) => { blocked = value; },
    respondWith: (value: unknown) => { rpcData = value; },
    failWith: (value: unknown) => { rpcError = value; },
    counts: () => ({ signups, sessionReads, removed, channels }),
  };
}

test('guest authentication is lazy, single-flight, and reuses its saved session', async () => {
  const mock = mockClient();
  const api = createCompetitionApi(mock.service);
  assert.deepEqual(mock.counts(), { signups: 0, sessionReads: 0, removed: 0, channels: 0 });
  assert.deepEqual(await Promise.all([api.getUserId(), api.getUserId(), api.getUserId()]), [userId, userId, userId]);
  assert.equal(mock.counts().signups, 1);
  assert.equal(mock.counts().sessionReads, 1);
  await api.getUserId();
  assert.equal(mock.counts().signups, 1);
});

test('a failed guest sign-in can be retried without caching its rejected promise', async () => {
  const mock = mockClient(); mock.block(true);
  const api = createCompetitionApi(mock.service);
  await assert.rejects(api.getUserId(), /Guest joining is not available/);
  mock.block(false);
  assert.equal(await api.getUserId(), userId);
  assert.equal(mock.counts().signups, 2);
});

test('room creation sends only settings and nickname, never a client puzzle or time', async () => {
  const mock = mockClient();
  const api = createCompetitionApi(mock.service);
  const room = await api.createRoom({ nickname: ' Player ', size: 5, difficulty: 'Easy' });
  assert.equal(room.room.code, 'ABC123');
  assert.deepEqual(mock.functionCalls, [['numora-create-room', { body: { nickname: 'Player', size: 5, difficulty: 'Easy' } }]]);
  assert.deepEqual(mock.rpcCalls[0], { name: 'numora_get_room', args: { p_code: 'ABC123' } });
});

test('save and submit use private board snapshots without client elapsed times', async () => {
  const mock = mockClient(); const api = createCompetitionApi(mock.service);
  const values = Array<number>(25).fill(0), notes = Array.from({ length: 25 }, () => [] as number[]);
  await api.saveProgress('abc123', values, notes);
  await api.submitSolution('abc123', values, notes);
  values[0] = 5; notes[0].push(5);
  assert.equal(mock.rpcCalls[0].name, 'numora_save_progress');
  assert.equal(mock.rpcCalls[1].name, 'numora_submit_solution');
  assert.equal((mock.rpcCalls[0].args.p_values as number[])[0], 0);
  assert.deepEqual(Object.keys(mock.rpcCalls[1].args).sort(), ['p_code', 'p_notes', 'p_values']);
});

test('live watches clean up channels, deduplicate presence, and do not subscribe after early disposal', async () => {
  const mock = mockClient(); const api = createCompetitionApi(mock.service);
  let changes = 0; let online: string[] = [];
  const stop = api.watchRoom(roomId, () => { changes++; }, ids => { online = ids; });
  await api.getUserId(); await Promise.resolve();
  for (const handler of mock.handlers.filter(item => item.type === 'presence')) handler.callback();
  assert.deepEqual(online, [userId]);
  assert.equal(changes, 1);
  stop();
  assert.equal(mock.counts().removed, 1);
  for (const handler of mock.handlers.filter(item => item.type === 'postgres_changes')) handler.callback();
  assert.equal(changes, 1);
  const second = mockClient(); const secondApi = createCompetitionApi(second.service);
  secondApi.watchRoom(roomId, () => {}, () => {})();
  await secondApi.getUserId(); await Promise.resolve();
  assert.equal(second.counts().channels, 0);
});

test('missing configuration and service errors produce useful product-safe feedback', async () => {
  await assert.rejects(createCompetitionApi(null).getUserId(), /not configured/);
  assert.match(explainError({ code: 'PGRST202', message: 'function public.numora_get_room is missing' }), /setup is not ready/);
  assert.match(explainError(new TypeError('Failed to fetch')), /connection/);
  assert.match(explainError({ message: 'Only the host may start this room' }), /Only the room host/);
  assert.match(explainError({ message: 'Internal SQL error: token=do-not-display' }), /^Something went wrong/);
});

test('expected join failures are decoded from successful transactions that preserve rate limits', async () => {
  const mock = mockClient(); const api = createCompetitionApi(mock.service);
  mock.respondWith({ error: 'Room not found. Check the code and try again.', code: 'P0001' });
  await assert.rejects(api.joinRoom('ABC123', 'Player'), /room wasn’t found/);
  mock.respondWith({ error: 'That nickname is already in use in this room.', code: 'P0001' });
  await assert.rejects(api.joinRoom('ABC123', 'Player'), /nickname is already taken/);
});

test('spectator requests normalize routing, reuse the session, and send no private viewer claims', async () => {
  const mock = mockClient(); const api = createCompetitionApi(mock.service);
  mock.respondWith({
    room_id: roomId, player_id: targetId, values: [...spectatorPuzzle.givens],
    notes: Array.from({ length: 25 }, () => []), updated_at: now, server_now: now,
  });
  const controller = new AbortController();
  const snapshot = await api.getSpectatorState(' abc123 ', ` ${targetId.toUpperCase()} `, spectatorPuzzle, controller.signal);
  assert.equal(snapshot.player_id, targetId);
  assert.deepEqual(mock.rpcCalls[0], { name: 'numora_spectate_player', args: { p_code: 'ABC123', p_player_id: targetId } });
  assert.equal(mock.signals[0], controller.signal);
  await api.getSpectatorState('ABC123', targetId, spectatorPuzzle);
  assert.equal(mock.counts().sessionReads, 2);
  assert.equal(mock.counts().signups, 1);
});

test('malformed spectator routing is rejected before any authentication or room request', async () => {
  const mock = mockClient(); const api = createCompetitionApi(mock.service);
  await assert.rejects(api.getSpectatorState('ABC', targetId, spectatorPuzzle), /six-character/);
  await assert.rejects(api.getSpectatorState('ABC123', 'not-a-player', spectatorPuzzle), /another player/);
  assert.equal(mock.counts().sessionReads, 0);
  assert.equal(mock.counts().signups, 0);
  assert.equal(mock.rpcCalls.length, 0);
});

test('spectator authorization failures provide useful feedback and remain server-enforced', async () => {
  const mock = mockClient(); const api = createCompetitionApi(mock.service);
  mock.failWith({ code: '42501', message: 'Finish your puzzle before watching another player.' });
  await assert.rejects(api.getSpectatorState('ABC123', targetId, spectatorPuzzle), /Finish your race before watching/);
  mock.failWith({ code: '42501', message: 'Join this room before spectating.' });
  await assert.rejects(api.getSpectatorState('ABC123', targetId, spectatorPuzzle), /don’t have access/);
  mock.failWith({ code: '42501', message: 'That player is not in this room.' });
  await assert.rejects(api.getSpectatorState('ABC123', targetId, spectatorPuzzle), /not available to watch/);
  mock.failWith({ code: '22023', message: 'Choose another player in this room to watch.' });
  await assert.rejects(api.getSpectatorState('ABC123', targetId, spectatorPuzzle), /Choose another player to watch/);
});
