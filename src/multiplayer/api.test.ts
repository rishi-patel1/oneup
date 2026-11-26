import assert from 'node:assert/strict';
import test from 'node:test';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createCompetitionApi, explainError, isRoomExpiredError, isRoomRemovedError, isRoomUnavailableError } from './api';

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
  await assert.rejects(api.getSpectatorState('ABC123', targetId, spectatorPuzzle), /Finish or give up your race before watching/);
  mock.failWith({ code: '42501', message: 'Finish or give up your puzzle before watching another player.' });
  await assert.rejects(api.getSpectatorState('ABC123', targetId, spectatorPuzzle), /Finish or give up your race before watching/);
  mock.failWith({ code: '42501', message: 'Join this room before spectating.' });
  await assert.rejects(api.getSpectatorState('ABC123', targetId, spectatorPuzzle), /don’t have access/);
  mock.failWith({ code: '42501', message: 'That player is not in this room.' });
  await assert.rejects(api.getSpectatorState('ABC123', targetId, spectatorPuzzle), /not available to watch/);
  mock.failWith({ code: '22023', message: 'Choose another player in this room to watch.' });
  await assert.rejects(api.getSpectatorState('ABC123', targetId, spectatorPuzzle), /Choose another player to watch/);
});

test('a rematch sends only the current room and round to the trusted generator', async () => {
  const mock = mockClient(); const api = createCompetitionApi(mock.service);
  const next = await api.rematchRoom(' abc123 ', roomId.toUpperCase());
  assert.equal(next.room.code, 'ABC123');
  assert.deepEqual(mock.functionCalls, [['numora-rematch-room', { body: { code: 'ABC123', round_id: roomId } }]]);
  assert.deepEqual(mock.rpcCalls[0], { name: 'numora_get_room', args: { p_code: 'ABC123' } });
  assert.equal(mock.counts().signups, 1);
  const invalid = mockClient(); const invalidApi = createCompetitionApi(invalid.service);
  await assert.rejects(invalidApi.rematchRoom('ABC123', 'bad-round'));
  assert.equal(invalid.counts().sessionReads, 0);
  assert.equal(invalid.functionCalls.length, 0);
});

test('grid votes send the exact round and phase, can be replaced or cleared, and trust the server response', async () => {
  const mock = mockClient(), api = createCompetitionApi(mock.service);
  await api.voteRoomGrid(' abc123 ', roomId.toUpperCase(), 'lobby', { size: 8, difficulty: 'Hard' });
  await api.voteRoomGrid('ABC123', roomId, 'finished', { size: 6, difficulty: 'Medium' });
  await api.voteRoomGrid('ABC123', roomId, 'finished', null);
  assert.deepEqual(mock.rpcCalls, [
    { name: 'numora_vote_grid', args: { p_code: 'ABC123', p_round_id: roomId, p_phase: 'lobby', p_size: 8, p_difficulty: 'Hard' } },
    { name: 'numora_vote_grid', args: { p_code: 'ABC123', p_round_id: roomId, p_phase: 'finished', p_size: 6, p_difficulty: 'Medium' } },
    { name: 'numora_vote_grid', args: { p_code: 'ABC123', p_round_id: roomId, p_phase: 'finished', p_size: null, p_difficulty: null } },
  ]);
  mock.failWith({ code: '22023', message: 'The grid voting phase has changed.' });
  await assert.rejects(api.voteRoomGrid('ABC123', roomId, 'lobby', null), /voting has changed/);
});

test('host grid choices send validated settings and expected phase to server generation', async () => {
  const mock = mockClient(), api = createCompetitionApi(mock.service);
  await api.rematchRoom(' abc123 ', roomId.toUpperCase(), { size: 8, difficulty: 'Hard', phase: 'lobby' });
  await api.rematchRoom('ABC123', roomId, { size: 5, difficulty: 'Easy', phase: 'finished' });
  assert.deepEqual(mock.functionCalls, [
    ['numora-rematch-room', { body: { code: 'ABC123', round_id: roomId, size: 8, difficulty: 'Hard', phase: 'lobby' } }],
    ['numora-rematch-room', { body: { code: 'ABC123', round_id: roomId, size: 5, difficulty: 'Easy', phase: 'finished' } }],
  ]);
  assert.ok(mock.rpcCalls.every(call => call.name === 'numora_get_room'));
});

test('bad grid settings, missing current rounds, and in-race phases fail before authentication', async () => {
  const mock = mockClient(), api = createCompetitionApi(mock.service);
  for (const choice of [{ size: 4, difficulty: 'Easy' }, { size: 9, difficulty: 'Easy' }, { size: 5.5, difficulty: 'Easy' }, { size: 5, difficulty: 'Expert' }]) {
    assert.throws(() => api.voteRoomGrid('ABC123', roomId, 'lobby', choice as never), /grid size/);
    await assert.rejects(api.rematchRoom('ABC123', roomId, { ...choice, phase: 'finished' } as never), /grid size/);
  }
  assert.throws(() => api.voteRoomGrid('ABC123', roomId, 'racing' as never, null), /when grid voting is open/);
  assert.throws(() => api.voteRoomGrid('ABC123', undefined as never, 'lobby', null), /current round/);
  await assert.rejects(api.rematchRoom('ABC123', roomId, { size: 5, difficulty: 'Easy', phase: 'racing' as never }), /when grid voting is open/);
  assert.equal(mock.counts().sessionReads, 0);
  assert.equal(mock.rpcCalls.length, 0);
  assert.equal(mock.functionCalls.length, 0);
});

test('grid voting and host-choice errors keep safe, specific feedback', () => {
  assert.match(explainError({ message: 'The grid voting phase has changed. Reconnect.' }), /voting has changed/);
  assert.match(explainError({ message: 'Only the room host can apply a grid choice.' }), /Only the room host can apply/);
  assert.match(explainError({ message: 'Choose a grid size from 5 through 8 and a difficulty.' }), /grid size from 5 through 8/);
  assert.match(explainError({ code: '42501', message: 'Join this room before voting for a grid.' }), /Rejoin this room before voting/);
  assert.match(explainError({ code: '42501', message: 'Only the room host can choose the final grid.' }), /Only the room host can apply/);
  assert.match(explainError({ code: '22023', message: 'Grid voting has moved to a different phase. Refresh the room and try again.' }), /voting has changed/);
  assert.match(explainError({ code: '22023', message: 'Grid choice has moved to a different phase. Refresh the room and try again.' }), /voting has changed/);
  assert.match(explainError({ code: '22023', message: 'Choose a grid size from 5 to 8 and Easy, Medium, or Hard.' }), /grid size from 5 through 8/);
});

test('round-aware requests bind readiness, start, progress, finish, give up, leave, and spectating to one round', async () => {
  const mock = mockClient(); const api = createCompetitionApi(mock.service);
  const round = '44444444-4444-4444-8444-444444444444';
  const values = [...spectatorPuzzle.givens], notes = Array.from({ length: 25 }, () => [] as number[]);
  await api.setReady('ABC123', true, round);
  await api.startRoom('ABC123', round);
  await api.saveProgress('ABC123', values, notes, round);
  await api.submitSolution('ABC123', values, notes, round);
  await api.giveUpRoom('abc123', round.toUpperCase());
  await api.leaveRoom('ABC123', round);
  mock.respondWith({room_id: roomId, player_id: targetId, values, notes, updated_at: now, server_now: now});
  await api.getSpectatorState('ABC123', targetId, spectatorPuzzle, undefined, round);
  assert.deepEqual(mock.rpcCalls.map(call => call.name), [
    'numora_set_ready', 'numora_start_room', 'numora_save_progress', 'numora_submit_solution', 'numora_give_up_room', 'numora_leave_room', 'numora_spectate_player',
  ]);
  for (const call of mock.rpcCalls) assert.equal(call.args.p_round_id, round);
  const invalid = mockClient(); const invalidApi = createCompetitionApi(invalid.service);
  assert.throws(() => invalidApi.setReady('ABC123', true, 'bad-round'));
  await assert.rejects(invalidApi.leaveRoom('ABC123', 'bad-round'));
  assert.equal(invalid.counts().sessionReads, 0);
});

test('give up sends only normalized room and round identity and returns the authoritative player state', async () => {
  const mock = mockClient(); const api = createCompetitionApi(mock.service);
  mock.respondWith({
    room: { id: roomId, round_id: roomId, code: 'ABC123', host_id: userId, status: 'finished', size: 5, difficulty: 'Easy', starts_at: now, created_at: now },
    players: [{ user_id: userId, nickname: 'Player', ready: true, progress_count: 0, finished_at: null, given_up_at: now, elapsed_ms: null, joined_at: now }],
    puzzle: spectatorPuzzle,
    self: { values: [...spectatorPuzzle.givens], notes: Array.from({ length: 25 }, () => []) },
    server_now: now,
  });
  const next = await api.giveUpRoom(' abc123 ', roomId.toUpperCase());
  assert.deepEqual(mock.rpcCalls, [{ name: 'numora_give_up_room', args: { p_code: 'ABC123', p_round_id: roomId } }]);
  assert.equal(next.players[0].given_up_at, now);
  assert.equal(next.players[0].elapsed_ms, null);
  mock.failWith({ message: 'The room has already moved to another round. Reconnect to continue.' });
  await assert.rejects(api.giveUpRoom('ABC123', roomId), /moved to a new round/);
});

test('give up rejects missing or malformed routing before authentication', () => {
  const mock = mockClient(); const api = createCompetitionApi(mock.service);
  assert.throws(() => api.giveUpRoom('ABC', roomId), /six-character/);
  assert.throws(() => api.giveUpRoom('ABC123', 'bad-round'), /current round/);
  assert.throws(() => api.giveUpRoom('ABC123', undefined as unknown as string), /current round/);
  assert.equal(mock.counts().sessionReads, 0);
  assert.equal(mock.rpcCalls.length, 0);
});

test('host removal sends only normalized room, target, and current round for server authorization', async () => {
  const mock = mockClient(), api = createCompetitionApi(mock.service);
  const next = await api.kickRoomPlayer(' abc123 ', ` ${targetId.toUpperCase()} `, roomId.toUpperCase());
  assert.equal(next.room.code, 'ABC123');
  assert.deepEqual(mock.rpcCalls, [{ name: 'numora_kick_player', args: { p_code: 'ABC123', p_player_id: targetId, p_round_id: roomId } }]);
  mock.failWith({ code: 'P0001', message: 'This player is still connected. Only away players can be removed.' });
  await assert.rejects(api.kickRoomPlayer('ABC123', targetId, roomId), /still connected/);
  mock.failWith({ code: '22023', message: 'This round has changed. Refresh the room and try again.' });
  await assert.rejects(api.kickRoomPlayer('ABC123', targetId, roomId), /moved to a new round/);
});

test('malformed removal routing fails before authentication or a network request', () => {
  const mock = mockClient(), api = createCompetitionApi(mock.service);
  for (const [code, target, round] of [
    ['ABC', targetId, roomId], ['ABC123', 'not-a-player', roomId], ['ABC123', undefined, roomId],
    ['ABC123', targetId, 'bad-round'], ['ABC123', targetId, undefined],
  ]) assert.throws(() => api.kickRoomPlayer(code!, target!, round!));
  assert.equal(mock.counts().sessionReads, 0);
  assert.equal(mock.rpcCalls.length, 0);
});

test('removed-room errors remain distinct after RPC and successful-transaction join decoding', async () => {
  const message = 'You were removed from this room by the host.';
  const mock = mockClient(), api = createCompetitionApi(mock.service);
  mock.failWith({ code: '42501', message });
  await assert.rejects(api.getRoom('ABC123'), error => isRoomRemovedError(error) && explainError(error) === message);
  mock.failWith(null);
  mock.respondWith({ error: message, code: 'ROOM_REMOVED' });
  await assert.rejects(api.joinRoom('ABC123', 'Player'), error => isRoomRemovedError(error) && explainError(error) === message);
  assert.equal(isRoomRemovedError({ code: 'ROOM_REMOVED', message: 'private details should stay hidden' }), true);
  assert.equal(explainError({ code: 'ROOM_REMOVED', message: 'private details should stay hidden' }), message);
  assert.equal(isRoomRemovedError({ code: '42501', message: 'Join this room first.' }), false);
  assert.equal(isRoomRemovedError(new Error('Couldn’t reach this room.')), false);
});

test('midgame join accepts a spectator role and rejects a private playable grid for that viewer', async () => {
  const mock = mockClient(), api = createCompetitionApi(mock.service);
  const observerState = {
    room: { id: roomId, round_id: roomId, code: 'ABC123', host_id: targetId, status: 'racing', size: 5, difficulty: 'Easy', starts_at: now, created_at: now },
    players: [
      { user_id: userId, nickname: 'Observer', ready: false, active: true, is_spectator: true, is_away: false, progress_count: 0, finished_at: null, elapsed_ms: null, joined_at: now },
      { user_id: targetId, nickname: 'Host', ready: true, progress_count: 0, finished_at: null, elapsed_ms: null, joined_at: now },
    ],
    puzzle: spectatorPuzzle, self: null, server_now: now,
  };
  mock.respondWith(observerState);
  const joined = await api.joinRoom('ABC123', 'Observer');
  assert.equal(joined.players[0].is_spectator, true);
  assert.equal(joined.self, null);
  assert.deepEqual(mock.rpcCalls[0], { name: 'numora_join_room', args: { p_code: 'ABC123', p_nickname: 'Observer' } });
  mock.respondWith({ ...observerState, self: { values: [...spectatorPuzzle.givens], notes: Array.from({ length: 25 }, () => []) } });
  await assert.rejects(api.getRoom('ABC123'), /unexpected data/);
});

test('removal and observer-gate feedback stays specific without exposing database internals', () => {
  assert.match(explainError({ code: '42501', message: 'Only the room host can remove an away player.' }), /Only the room host can remove away players/);
  assert.match(explainError({ code: '22023', message: 'The host cannot remove themselves.' }), /can’t remove yourself/);
  assert.match(explainError({ code: '22023', message: 'That player has already left this room.' }), /already left this room/);
  assert.match(explainError({ code: 'P0001', message: 'This player is still connected. Only away players can be removed.' }), /still connected/);
  assert.match(explainError({ code: '42501', message: 'You joined as a spectator. You can play in the next game.' }), /spectating this round/);
  assert.match(explainError({ code: '22023', message: 'Choose a player who is solving this round.' }), /Choose a player who is solving/);
});

test('rematch permission, unfinished race, and stale-round feedback stay actionable', () => {
  assert.match(explainError({message: 'Only the room host can prepare another round.'}), /Only the room host can create the next game/);
  assert.match(explainError({message: 'Wait until everyone has finished before starting another round.'}), /Wait for everyone to finish/);
  assert.match(explainError({message: 'Wait until every player has finished or given up before creating the next round.'}), /Wait for everyone to finish or give up/);
  assert.match(explainError({message: 'The room has already moved to another round. Reconnect to continue.'}), /moved to a new round/);
});

test('shared pause and resume votes carry round, pause cycle, and timer version without clock claims', async () => {
  const mock=mockClient(),api=createCompetitionApi(mock.service);
  const pauseId='55555555-5555-4555-8555-555555555555';
  await api.pauseRoom(' abc123 ',roomId,2);
  await api.setResumeReady('ABC123',roomId,pauseId,true);
  await api.setResumeReady('ABC123',roomId,pauseId,false);
  assert.deepEqual(mock.rpcCalls[0],{name:'numora_pause_room',args:{p_code:'ABC123',p_round_id:roomId,p_pause_version:2}});
  assert.deepEqual(mock.rpcCalls[1],{name:'numora_set_resume_ready',args:{p_code:'ABC123',p_round_id:roomId,p_pause_id:pauseId,p_ready:true}});
  assert.equal(mock.rpcCalls[2].args.p_ready,false);
  assert.throws(()=>api.pauseRoom('ABC123',roomId,-1));
  assert.throws(()=>api.setResumeReady('ABC123',roomId,'invalid',true));
  const values=[...spectatorPuzzle.givens],notes=Array.from({length:25},()=>[]);
  await api.saveProgress('ABC123',values,notes,roomId,5);
  await api.submitSolution('ABC123',values,notes,roomId,5);
  mock.respondWith({room_id:roomId,player_id:targetId,values,notes,updated_at:now,server_now:now});
  await api.getSpectatorState('ABC123',targetId,spectatorPuzzle,undefined,roomId,5);
  for(const call of mock.rpcCalls.slice(3))assert.equal(call.args.p_pause_version,5);
});

function chatResponse() {
  return {
    room_id: roomId, expires_at: '2026-11-20T12:00:00.000Z', server_now: now,
    messages: [{
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', client_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      user_id: userId, nickname: 'Player', body: 'Hello, room!', created_at: now,
    }],
  };
}

test('chat reads bind the immutable room identity and forward cancellation without round or player claims', async () => {
  const mock = mockClient(), api = createCompetitionApi(mock.service), controller = new AbortController();
  mock.respondWith(chatResponse());
  const state = await api.getRoomChat(' abc123 ', roomId.toUpperCase(), controller.signal);
  assert.equal(state.messages[0].body, 'Hello, room!');
  assert.deepEqual(mock.rpcCalls[0], { name: 'numora_get_room_chat', args: { p_code: 'ABC123', p_room_id: roomId } });
  assert.deepEqual(mock.signals, [controller.signal]);
  mock.respondWith({ ...chatResponse(), room_id: targetId });
  await assert.rejects(api.getRoomChat('ABC123', roomId), /unexpected data/);
});

test('chat sends normalize text and reuse the supplied retry nonce without trusting sender identity or timestamps', async () => {
  const mock = mockClient(), api = createCompetitionApi(mock.service);
  const clientId = chatResponse().messages[0].client_id;
  mock.respondWith(chatResponse());
  await api.sendRoomMessage(' abc123 ', roomId, clientId.toUpperCase(), ' cafe\u0301\n\tsoon ');
  await api.sendRoomMessage('ABC123', roomId, clientId, 'café\n\tsoon');
  assert.deepEqual(mock.rpcCalls[0], { name: 'numora_send_room_message', args: {
    p_code: 'ABC123', p_room_id: roomId, p_client_id: clientId, p_body: 'café\n\tsoon',
  } });
  assert.deepEqual(mock.rpcCalls[0], mock.rpcCalls[1]);
  assert.equal(mock.counts().signups, 1);
});

test('malformed chat routing, nonces, and text fail before authentication or sending', () => {
  const mock = mockClient(), api = createCompetitionApi(mock.service), clientId = chatResponse().messages[0].client_id;
  for (const [code, room] of [['ABC', roomId], ['ABC123', 'bad-room']]) {
    assert.throws(() => api.getRoomChat(code, room));
    assert.throws(() => api.sendRoomMessage(code, room, clientId, 'Hello'));
  }
  assert.throws(() => api.sendRoomMessage('ABC123', roomId, 'bad-client', 'Hello'));
  for (const body of ['', ' ', '🪿'.repeat(501), 'hello\u0007world']) assert.throws(() => api.sendRoomMessage('ABC123', roomId, clientId, body));
  assert.equal(mock.counts().sessionReads, 0);
  assert.equal(mock.rpcCalls.length, 0);
});

test('room expiration remains distinct through room, chat, join, and function failures', async () => {
  const message = 'This room has expired. Create or join another room.';
  const mock = mockClient(), api = createCompetitionApi(mock.service);
  mock.failWith({ code: 'P0002', message });
  for (const operation of [() => api.getRoom('ABC123'), () => api.getRoomChat('ABC123', roomId), () => api.sendRoomMessage('ABC123', roomId, chatResponse().messages[0].client_id, 'Hello')]) {
    await assert.rejects(operation(), error => isRoomExpiredError(error) && isRoomUnavailableError(error) && !isRoomRemovedError(error) && explainError(error) === message);
  }
  mock.failWith(null); mock.respondWith({ error: 'private details', code: 'ROOM_EXPIRED' });
  await assert.rejects(api.joinRoom('ABC123', 'Player'), error => isRoomExpiredError(error) && explainError(error) === message);
  mock.service.functions.invoke = async () => ({ data: null, error: { context: new Response(JSON.stringify({ code: 'ROOM_EXPIRED', error: 'private details' }), { status: 409 }) } }) as never;
  await assert.rejects(api.rematchRoom('ABC123', roomId), error => isRoomExpiredError(error) && isRoomUnavailableError(error));
  assert.equal(isRoomExpiredError({ code: 'ROOM_EXPIRED', message: 'private details' }), true);
  assert.equal(isRoomExpiredError({ code: 'P0002', message: 'Other internal lookup failed.' }), false);
  const authFailure = { status: 401, code: 'session_expired', message: 'Your session has expired.' };
  assert.equal(isRoomExpiredError(authFailure), false);
  assert.equal(isRoomUnavailableError(authFailure), false);
  assert.equal(explainError(authFailure), 'Your connection expired. Refresh the page and reconnect.');
  assert.equal(isRoomUnavailableError({ code: '42501', message: 'Join this room first.' }), false);
  assert.equal(isRoomUnavailableError({ code: 'ROOM_REMOVED' }), true);
});

test('chat validation and retry failures have useful feedback without returning server internals', () => {
  assert.equal(explainError({ code: '22023', message: 'Messages must contain 1 to 500 characters without control characters.' }), 'Write a message between 1 and 500 characters without control characters.');
  assert.equal(explainError({ code: '22023', message: 'This message retry does not match the original text.' }), 'This message changed. Send it again as a new message.');
});

test('chat broadcasts invalidate the chat cache without trusting or exposing a message payload', async () => {
  const mock = mockClient(), api = createCompetitionApi(mock.service);
  let roomChanges = 0, chatChanges = 0;
  const stop = api.watchRoom(roomId, () => { roomChanges++; }, () => {}, () => { chatChanges++; });
  await api.getUserId(); await Promise.resolve();
  const signals = mock.handlers.filter(item => item.type === 'broadcast');
  assert.equal(signals.length, 1);
  signals[0].callback(); assert.equal(chatChanges, 1); assert.equal(roomChanges, 1);
  stop(); signals[0].callback(); assert.equal(chatChanges, 1);
});
