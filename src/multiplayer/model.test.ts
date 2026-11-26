import assert from 'node:assert/strict';
import test from 'node:test';
import { createRoomSnapshotGate, getRoomTiming, isPlayerDone, normalizeChatMessage, normalizeNickname, normalizeProgress, normalizeRoomCode, parseRoomChat, parseRoomState, parseSpectatorState, RoomDataError, type PreviousRound } from './model';

const host = '11111111-1111-4111-8111-111111111111';
const guest = '22222222-2222-4222-8222-222222222222';
const roomId = '33333333-3333-4333-8333-333333333333';
const now = '2026-11-19T12:00:00.000Z';

function state() {
  return {
    room: { id: roomId, code: 'ABC123', host_id: host, status: 'racing', size: 5, difficulty: 'Easy', starts_at: now, created_at: now },
    players: [host, guest].map((user_id, index) => ({ user_id, nickname: index ? 'Guest' : 'Host', ready: true, progress_count: 0, finished_at: null, elapsed_ms: null, joined_at: now })),
    self: { values: [1, ...Array<number>(24).fill(0)], notes: Array.from({ length: 25 }, () => [] as number[]) },
    puzzle: { id: `match-${roomId}`, title: 'A shared challenge', description: 'Every cell counts.', size: 5, difficulty: 'Easy' as const, givens: [1, ...Array<number>(24).fill(0)], rightWalls: Array<boolean>(25).fill(true), bottomWalls: Array<boolean>(25).fill(true) },
    server_now: '2026-11-19T12:00:01.000Z',
  };
}

function previousRound(): PreviousRound {
  return {
    round_id: '99999999-9999-4999-8999-999999999999', size: 6, difficulty: 'Medium',
    starts_at: '2026-11-19T11:55:00.000Z', finished_at: '2026-11-19T11:59:00.000Z',
    results: [
      { user_id: host, nickname: 'Host', finished_at: '2026-11-19T11:57:00.000Z', given_up_at: null, elapsed_ms: 120000 },
      { user_id: guest, nickname: 'Guest', finished_at: null, given_up_at: '2026-11-19T11:59:00.000Z', elapsed_ms: null },
      { user_id: '44444444-4444-4444-8444-444444444444', nickname: 'Removed Goose', finished_at: null, given_up_at: null, elapsed_ms: null },
    ],
  };
}

test('room codes and nicknames normalize input without accepting malformed invitations', () => {
  assert.equal(normalizeRoomCode(' abC123 '), 'ABC123');
  for (const bad of ['', 'ABC', 'ABC1234', '<ABC12', 'AB C12']) assert.throws(() => normalizeRoomCode(bad));
  assert.equal(normalizeNickname('  Café   Player '), 'Café Player');
  assert.equal(normalizeNickname('😀😀'), '😀😀');
  for (const bad of ['', 'A', 'x'.repeat(25), 'a\u0000b']) assert.throws(() => normalizeNickname(bad));
});

test('the room model validates public boards and makes independent snapshots', () => {
  const raw = state();
  const parsed = parseRoomState(raw);
  assert.equal(parsed.puzzle?.id, `match-${roomId}`);
  parsed.self!.values[1] = 1;
  parsed.puzzle!.rightWalls[0] = false;
  assert.equal(raw.self.values[1], 0);
  assert.equal(raw.puzzle.rightWalls[0], true);
  assert.equal('solution' in parsed.puzzle!, false);
});

test('spectator and away flags use server state with safe defaults for older responses', () => {
  const initial = parseRoomState(state());
  assert.equal(initial.players[0].is_spectator, false);
  assert.equal(initial.players[0].is_away, false);
  const left = state(); Object.assign(left.players[1], { active: false });
  assert.equal(parseRoomState(left).players[1].is_away, true);
  Object.assign(left.players[1], { active: true, is_away: true });
  assert.equal(parseRoomState(left).players[1].is_away, true);
  for (const field of ['is_spectator', 'is_away']) for (const value of [null, 0, 1, 'true']) {
    const bad = state(); Object.assign(bad.players[1], { [field]: value });
    assert.throws(() => parseRoomState(bad), RoomDataError);
  }
});

test('late spectators receive public clues but no own race entry or solved outcome', () => {
  const raw = state();
  Object.assign(raw.players[1], { is_spectator: true, ready: false });
  // The participant still receives their own private progress when others spectate.
  assert.ok(parseRoomState(raw, host).self);
  assert.throws(() => parseRoomState(raw, guest), RoomDataError);
  Object.assign(raw, { self: null });
  const observer = parseRoomState(raw, guest);
  assert.equal(observer.self, null);
  assert.equal(observer.players[1].is_spectator, true);
  assert.equal(isPlayerDone(observer.players[1]), false);
  assert.ok(observer.puzzle);
  Object.assign(raw.room, { status: 'finished' });
  Object.assign(raw.players[1], { grid_vote: { size: 6, difficulty: 'Medium' } });
  assert.deepEqual(parseRoomState(raw, guest).players[1].grid_vote, { size: 6, difficulty: 'Medium' });
  assert.throws(() => parseRoomState(raw, 'not-a-user'), RoomDataError);
  assert.throws(() => parseRoomState(raw, '44444444-4444-4444-8444-444444444444'), RoomDataError);
});

test('spectators cannot carry race progress, readiness, scores, or a lobby participant role', () => {
  for (const patch of [
    { ready: true }, { resume_ready: true }, { progress_count: 1 },
    { finished_at: now, elapsed_ms: 1000 }, { given_up_at: now },
  ]) {
    const raw = state();
    Object.assign(raw, { self: null });
    Object.assign(raw.players[1], { is_spectator: true, ready: false }, patch);
    assert.throws(() => parseRoomState(raw, guest), RoomDataError);
  }
  const lobby = state();
  Object.assign(lobby.room, { status: 'lobby', starts_at: null });
  Object.assign(lobby, { self: null, puzzle: null });
  Object.assign(lobby.players[1], { is_spectator: true, ready: false });
  assert.throws(() => parseRoomState(lobby, guest), RoomDataError);
  Object.assign(lobby.players[1], { is_spectator: false });
  assert.equal(parseRoomState(lobby, guest).players[1].is_spectator, false);
});

test('removed participant receipts preserve solved scores and unscored withdrawals separately from live membership', () => {
  assert.deepEqual(parseRoomState(state()).removed_results, []);
  const raw = state();
  const removed = '44444444-4444-4444-8444-444444444444';
  const gaveUp = '55555555-5555-4555-8555-555555555555';
  const results = [
    { user_id: removed, nickname: 'Finished Goose', finished_at: now, given_up_at: null, elapsed_ms: 1234, removed_at: raw.server_now },
    { user_id: gaveUp, nickname: 'Away Otter', finished_at: null, given_up_at: raw.server_now, elapsed_ms: null, removed_at: raw.server_now },
  ];
  Object.assign(raw, { removed_results: results });
  const parsed = parseRoomState(raw);
  assert.deepEqual(parsed.removed_results, results);
  assert.equal(parsed.players.length, 2);
  parsed.removed_results[0].nickname = 'Changed';
  assert.equal(results[0].nickname, 'Finished Goose');
});

test('removed result receipts reject identities, outcome conflicts, future dates, and private payloads', () => {
  const receipt = {
    user_id: '44444444-4444-4444-8444-444444444444', nickname: 'Removed Goose',
    finished_at: now, given_up_at: null, elapsed_ms: 1234, removed_at: state().server_now,
  };
  for (const patch of [
    { user_id: host }, { user_id: 'invalid' }, { nickname: 'A' },
    { elapsed_ms: -1 }, { finished_at: null, elapsed_ms: null }, { given_up_at: now },
    { removed_at: null }, { removed_at: '2026-11-19T12:00:02.000Z' }, { removed_at: '2026-11-19T11:59:59.000Z' },
    { values: [1] }, { notes: [[]] }, { solution: [1] }, { metadata: { seed: 'secret' } },
  ]) {
    const raw = state(); Object.assign(raw, { removed_results: [{ ...receipt, ...patch }] });
    assert.throws(() => parseRoomState(raw), RoomDataError);
  }
  for (const removed_results of [null, {}, [receipt, receipt], Array(9).fill(receipt)]) {
    const raw = state(); Object.assign(raw, { removed_results });
    assert.throws(() => parseRoomState(raw), RoomDataError);
  }
});

test('previous-round results survive roster changes with independent snapshots and legacy null defaults', () => {
  assert.equal(parseRoomState(state()).previous_round, null);
  const raw = { ...state(), previous_round: previousRound() };
  const parsed = parseRoomState(raw);
  assert.deepEqual(parsed.previous_round, raw.previous_round);
  assert.equal(parsed.previous_round!.size, 6);
  assert.equal(parsed.room.size, 5);
  // Removed participants and old unscored withdrawals remain visible as DNF.
  assert.equal(parsed.previous_round!.results[2].given_up_at, null);
  parsed.previous_round!.results[0].nickname = 'Changed';
  assert.equal(raw.previous_round.results[0].nickname, 'Host');
  Object.assign(raw, { previous_round: null });
  assert.equal(parseRoomState(raw).previous_round, null);
});

test('previous-round results reject current tokens, malformed settings and impossible archive times', () => {
  for (const patch of [
    { round_id: roomId }, { round_id: 'invalid' }, { size: 4 }, { size: 9 }, { difficulty: 'Extreme' },
    { starts_at: null }, { starts_at: 'not a date' }, { starts_at: '2026-11-19T12:00:00.000Z' },
    { finished_at: null }, { finished_at: '2026-11-19T12:00:02.000Z' }, { results: null }, { results: {} },
    { solution: [1] }, { seed: 'hidden' }, { generation: {} }, { values: [1] }, { notes: [[]] }, { chat: ['hello'] },
  ]) {
    assert.throws(() => parseRoomState({ ...state(), previous_round: { ...previousRound(), ...patch } }), RoomDataError);
  }
  for (const value of [false, 1, '', []]) assert.throws(() => parseRoomState({ ...state(), previous_round: value }), RoomDataError);
});

test('previous-round outcome rows reject identity, score, date and hidden-data corruption', () => {
  const result = previousRound().results[0];
  for (const patch of [
    { user_id: 'invalid' }, { nickname: 'A' }, { nickname: ' Host ' },
    { finished_at: 'invalid' }, { finished_at: '2026-11-19T11:54:59.000Z' }, { finished_at: '2026-11-19T11:59:01.000Z' },
    { elapsed_ms: -1 }, { elapsed_ms: 1.5 }, { elapsed_ms: Infinity }, { elapsed_ms: Number.MAX_SAFE_INTEGER + 1 }, { elapsed_ms: null },
    { given_up_at: '2026-11-19T11:59:00.000Z' }, { finished_at: null },
    { values: [1] }, { notes: [[]] }, { solution: [1] }, { metadata: { seed: 'hidden' } },
  ]) {
    assert.throws(() => parseRoomState({ ...state(), previous_round: { ...previousRound(), results: [{ ...result, ...patch }] } }), RoomDataError);
  }
  for (const given_up_at of ['invalid', '2026-11-19T11:54:59.000Z', '2026-11-19T11:59:01.000Z']) {
    assert.throws(() => parseRoomState({ ...state(), previous_round: { ...previousRound(), results: [{ ...previousRound().results[1], given_up_at }] } }), RoomDataError);
  }
  const duplicate = { ...result, user_id: host.toUpperCase() };
  assert.throws(() => parseRoomState({ ...state(), previous_round: { ...previousRound(), results: [result, duplicate] } }), RoomDataError);
  // Archive entries are separate from concurrent room capacity.
  const receipts = Array.from({ length: 9 }, (_, index) => ({ ...result, user_id: `${String(index + 1).padStart(8, '0')}-1111-4111-8111-111111111111` }));
  assert.equal(parseRoomState({ ...state(), previous_round: { ...previousRound(), results: receipts } }).previous_round!.results.length, 9);
});

test('lobbies and countdowns cannot expose board clues through either public puzzle or private progress', () => {
  const raw: Record<string, unknown> = state();
  (raw.room as Record<string, unknown>).status = 'lobby';
  (raw.room as Record<string, unknown>).starts_at = null;
  assert.throws(() => parseRoomState(raw), RoomDataError);
  raw.puzzle = null; raw.self = null;
  assert.equal(parseRoomState(raw).puzzle, null);
  (raw.room as Record<string, unknown>).status = 'racing';
  (raw.room as Record<string, unknown>).starts_at = '2026-11-19T12:00:05.000Z';
  assert.equal(parseRoomState(raw).self, null);
  raw.self = state().self;
  assert.throws(() => parseRoomState(raw), RoomDataError);
});

test('hidden answers, embedded generation seeds, and opponents’ private boards fail closed', () => {
  for (const key of ['solution', 'seed', 'generation']) {
    const raw = state();
    Object.assign(raw.puzzle, { [key]: key === 'solution' ? Array(25).fill(1) : 'hidden' });
    assert.throws(() => parseRoomState(raw), RoomDataError);
  }
  const seededId = state(); seededId.puzzle.id = 'generated-v1-5-easy-hidden-seed';
  assert.throws(() => parseRoomState(seededId), RoomDataError);
  const opponent = state(); Object.assign(opponent.players[1], { values: Array(25).fill(1) });
  assert.throws(() => parseRoomState(opponent), RoomDataError);
});

test('private progress keeps fixed clues immutable and checks note domains without checking guesses', () => {
  const raw = state(); raw.self.values[1] = 5;
  // This guess breaks a visible single-cell rule but is valid in-progress data.
  assert.equal(parseRoomState(raw).self?.values[1], 5);
  raw.self.values[0] = 0;
  assert.throws(() => parseRoomState(raw), RoomDataError);
  for (const badNotes of [[1, 1], [6], [0]]) {
    const bad = state(); bad.self.notes[1] = badNotes;
    assert.throws(() => parseRoomState(bad), RoomDataError);
  }
  const noteOnFilled = state(); noteOnFilled.self.notes[0] = [1];
  assert.throws(() => parseRoomState(noteOnFilled), RoomDataError);
  const sparse = new Array<number[]>(25); sparse[0] = [];
  assert.throws(() => normalizeProgress(Array(25).fill(0), sparse));
});

test('duplicate identities and inconsistent finish records are rejected', () => {
  const duplicate = state(); duplicate.players[1].user_id = host;
  assert.throws(() => parseRoomState(duplicate), RoomDataError);
  const invalidFinish = state(); Object.assign(invalidFinish.players[0], { finished_at: now, elapsed_ms: -1 });
  assert.throws(() => parseRoomState(invalidFinish), RoomDataError);
  const malformedWalls = state(); malformedWalls.puzzle.rightWalls.pop();
  assert.throws(() => parseRoomState(malformedWalls), RoomDataError);
});

test('given-up players are done without receiving a solved finish time or score', () => {
  const raw = state();
  const playing = parseRoomState(raw).players[0];
  assert.equal(playing.given_up_at, null);
  assert.equal(isPlayerDone(playing), false);
  Object.assign(raw.players[0], { given_up_at: now });
  const gaveUp = parseRoomState(raw).players[0];
  assert.equal(gaveUp.given_up_at, now);
  assert.equal(gaveUp.finished_at, null);
  assert.equal(gaveUp.elapsed_ms, null);
  assert.equal(isPlayerDone(gaveUp), true);
  Object.assign(raw.players[0], { given_up_at: null, finished_at: now, elapsed_ms: 1234 });
  assert.equal(isPlayerDone(parseRoomState(raw).players[0]), true);
});

test('give-up records reject invalid timestamps and incompatible solved scores', () => {
  for (const patch of [
    { given_up_at: 'invalid' },
    { given_up_at: 1 },
    { given_up_at: now, finished_at: now, elapsed_ms: 10 },
    { given_up_at: now, elapsed_ms: 10 },
  ]) {
    const raw = state(); Object.assign(raw.players[0], patch);
    assert.throws(() => parseRoomState(raw), RoomDataError);
  }
});

test('grid votes are public settings for the current lobby or finished round, with legacy responses defaulting to no vote', () => {
  assert.equal(parseRoomState(state()).players[0].grid_vote, null);
  const raw = state();
  Object.assign(raw.room, { status: 'lobby', starts_at: null });
  Object.assign(raw, { puzzle: null, self: null });
  const choice = { size: 8, difficulty: 'Hard' };
  Object.assign(raw.players[0], { grid_vote: choice });
  const parsed = parseRoomState(raw);
  assert.deepEqual(parsed.players[0].grid_vote, choice);
  parsed.players[0].grid_vote!.size = 5;
  assert.equal(choice.size, 8);
  const finished = state();
  Object.assign(finished.room, { status: 'finished' });
  Object.assign(finished.players[1], { grid_vote: { size: 6, difficulty: 'Medium' } });
  assert.deepEqual(parseRoomState(finished).players[1].grid_vote, { size: 6, difficulty: 'Medium' });
});

test('grid vote DTOs reject malformed, secret-bearing and in-race ballots', () => {
  const invalids: unknown[] = [false, [], 8, {}, { size: 4, difficulty: 'Easy' }, { size: 9, difficulty: 'Easy' },
    { size: '5', difficulty: 'Easy' }, { size: 5.5, difficulty: 'Easy' }, { size: 5, difficulty: 'Expert' },
    { size: 5, difficulty: null }, { size: 5, difficulty: 'Easy', seed: 'hidden' },
    { size: 5, difficulty: 'Easy', solution: [] }, { size: 5, difficulty: 'Easy', metadata: {} }];
  for (const grid_vote of invalids) {
    const raw = state(); Object.assign(raw.room, { status: 'finished' });
    Object.assign(raw.players[0], { grid_vote });
    assert.throws(() => parseRoomState(raw), RoomDataError);
  }
  const playing = state(); Object.assign(playing.players[0], { grid_vote: { size: 5, difficulty: 'Easy' } });
  assert.throws(() => parseRoomState(playing), RoomDataError);
});

function spectator() {
  return {
    room_id: roomId, player_id: guest,
    values: [...state().self.values], notes: state().self.notes,
    updated_at: now, server_now: '2026-11-19T12:00:01.000Z',
  };
}

test('spectator snapshots preserve private guesses and notes without changing the source', () => {
  const raw = spectator(); raw.values[1] = 5; raw.notes[2] = [5, 1];
  const parsed = parseSpectatorState(raw, guest, state().puzzle);
  // A visible rule violation remains a legitimate saved guess to observe.
  assert.equal(parsed.values[1], 5);
  assert.deepEqual(parsed.notes[2], [1, 5]);
  parsed.values[1] = 2; parsed.notes[2].push(3);
  assert.equal(raw.values[1], 5);
  assert.deepEqual(raw.notes[2], [5, 1]);
});

test('spectator responses must identify the requested player and contain consistent timestamps', () => {
  const raw = spectator();
  assert.throws(() => parseSpectatorState(raw, host, state().puzzle), RoomDataError);
  for (const patch of [
    { room_id: 'not-a-room' }, { player_id: 'not-a-player' },
    { updated_at: 'not-a-date' }, { server_now: null },
    { updated_at: '2026-11-19T12:00:02.000Z' },
  ]) assert.throws(() => parseSpectatorState({ ...raw, ...patch }, guest, state().puzzle), RoomDataError);
});

test('spectator progress rejects altered clues, invalid domains, and malformed notes', () => {
  const invalids = [
    (raw: ReturnType<typeof spectator>) => { raw.values[0] = 0; },
    (raw: ReturnType<typeof spectator>) => { raw.values[1] = 6; },
    (raw: ReturnType<typeof spectator>) => { raw.values.pop(); },
    (raw: ReturnType<typeof spectator>) => { raw.notes[0] = [1]; },
    (raw: ReturnType<typeof spectator>) => { raw.notes[1] = [1, 1]; },
    (raw: ReturnType<typeof spectator>) => { raw.notes[1] = [0]; },
    (raw: ReturnType<typeof spectator>) => { raw.notes[1] = [6]; },
    (raw: ReturnType<typeof spectator>) => { raw.notes = new Array<number[]>(25); },
  ];
  for (const invalidate of invalids) {
    const raw = spectator(); invalidate(raw);
    assert.throws(() => parseSpectatorState(raw, guest, state().puzzle), RoomDataError);
  }
  const wrongSize = { ...state().puzzle, size: 6, givens: Array<number>(36).fill(0) };
  assert.throws(() => parseSpectatorState(spectator(), guest, wrongSize), RoomDataError);
});

test('spectator payloads fail closed on answer, seed, or unexpected nested data', () => {
  for (const key of ['solution', 'seed', 'generation']) {
    assert.throws(() => parseSpectatorState({ ...spectator(), [key]: 'private' }, guest, state().puzzle), RoomDataError);
    assert.throws(() => parseSpectatorState({ ...spectator(), metadata: { [key]: 'private' } }, guest, state().puzzle), RoomDataError);
  }
  const hiddenPuzzle = { ...state().puzzle, solution: Array(25).fill(1) };
  assert.throws(() => parseSpectatorState(spectator(), guest, hiddenPuzzle), RoomDataError);
});

test('round identities distinguish rematches while legacy first rounds stay compatible', () => {
  const raw = state();
  assert.equal(parseRoomState(raw).room.round_id, roomId);
  const nextRound = '44444444-4444-4444-8444-444444444444';
  Object.assign(raw.room, { round_id: nextRound });
  assert.equal(parseRoomState(raw).room.round_id, nextRound);
  for (const round_id of ['', null, 2, 'not-a-round']) {
    Object.assign(raw.room, { round_id });
    assert.throws(() => parseRoomState(raw), RoomDataError);
  }
});

test('delayed snapshots cannot reopen a retired round even within the same millisecond', () => {
  const accept = createRoomSnapshotGate();
  const first = parseRoomState(state());
  first.server_now = '2026-11-19T12:00:01.000100Z';
  const next = structuredClone(first);
  next.room.round_id = '44444444-4444-4444-8444-444444444444';
  next.server_now = '2026-11-19T12:00:01.000900Z';
  assert.equal(Date.parse(first.server_now), Date.parse(next.server_now));
  assert.equal(accept(first), true);
  assert.equal(accept(next), true);
  assert.equal(accept(first), false);
  first.server_now = '2026-11-19T12:00:01.001000Z';
  assert.equal(accept(first), false);
  const later = structuredClone(next);
  later.server_now = '2026-11-19T12:00:02.000Z';
  assert.equal(accept(later), true);
  assert.equal(accept(next), false);
  assert.equal(createRoomSnapshotGate()(first), true);
});

test('shared pause clocks freeze and exclude both the break and resume countdown', () => {
  const raw = state();
  Object.assign(raw.room, {paused_at:'2026-11-19T12:00:00.500Z',resumes_at:null,paused_ms:200,pause_id:guest,pause_version:1});
  const room = parseRoomState(raw).room;
  assert.equal(getRoomTiming(room,Date.parse('2026-11-19T12:00:01Z')).elapsed,300);
  assert.equal(getRoomTiming(room,Date.parse('2026-11-19T13:00:01Z')).elapsed,300);
  room.resumes_at='2026-11-19T12:00:03.500Z';
  const countdown=getRoomTiming(room,Date.parse('2026-11-19T12:00:01Z'));
  assert.equal(countdown.paused,true); assert.equal(countdown.resuming,true);assert.equal(countdown.resumeSeconds,3);
  assert.equal(countdown.elapsed,300);
  const resumed=getRoomTiming(room,Date.parse('2026-11-19T12:00:04Z'));
  assert.equal(resumed.paused,false);assert.equal(resumed.elapsed,800);
  room.paused_ms=3200;room.paused_at=null;room.resumes_at=null;
  assert.equal(getRoomTiming(room,Date.parse('2026-11-19T12:00:04Z')).elapsed,800);
});

test('pause payloads fail closed and older vote snapshots cannot undo a newer pause state', () => {
  const raw=state();const base=parseRoomState(raw);
  assert.equal(base.room.pause_version,0);assert.equal(base.room.paused_ms,0);assert.equal(base.players[0].resume_ready,false);
  for(const invalid of [{pause_version:-1},{pause_version:null},{paused_ms:-1},{paused_at:now,pause_id:null,pause_version:1},{resumes_at:now}]) {
    const bad=state();Object.assign(bad.room,invalid);assert.throws(()=>parseRoomState(bad),RoomDataError);
  }
  const accept=createRoomSnapshotGate();assert.equal(accept(base),true);
  const paused=structuredClone(base);Object.assign(paused.room,{paused_at:now,pause_id:guest,pause_version:1});
  assert.equal(accept(paused),true);assert.equal(accept(base),false);
  const voted=structuredClone(paused);voted.room.pause_version=2;voted.players[0].resume_ready=true;
  assert.equal(accept(voted),true);assert.equal(accept(paused),false);
});

function chatState() {
  return {
    room_id: roomId,
    server_now: '2026-11-19T12:00:01.000Z',
    expires_at: '2026-11-20T12:00:01.000Z',
    messages: [
      { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', client_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', user_id: host, nickname: 'Host', body: 'Hello, room!', created_at: now },
      { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', client_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', user_id: guest, nickname: 'Guest', body: 'Ready\nwhen you are.', created_at: '2026-11-19T12:00:00.100Z' },
    ],
  };
}

test('chat text normalizes Unicode and surrounding whitespace while retaining plain text and line breaks', () => {
  assert.equal(normalizeChatMessage('\u00a0cafe\u0301\n\tsoon\ufeff'), 'café\n\tsoon');
  assert.equal(normalizeChatMessage('hi\r\nthere'), 'hi\r\nthere');
  assert.equal(normalizeChatMessage('<script>alert(1)</script>'), '<script>alert(1)</script>');
  assert.equal(normalizeChatMessage('🪿'.repeat(500)), '🪿'.repeat(500));
  for (const body of ['', '\n\t ', '🪿'.repeat(501), `hello\u0000`, `hello\u0007`, `hello\u000bworld`, `hello\u007f`]) {
    assert.throws(() => normalizeChatMessage(body), /message between 1 and 500/);
  }
});

test('room chat binds its room and clones bounded server identities and plain text without membership assumptions', () => {
  const raw = chatState();
  raw.messages[0].id = raw.messages[0].id.toUpperCase();
  raw.messages[0].client_id = raw.messages[0].client_id.toUpperCase();
  raw.messages[1].body = '<b>"solution" is just a word in chat.</b>';
  const parsed = parseRoomChat(raw, roomId.toUpperCase());
  assert.equal(parsed.room_id, roomId);
  assert.equal(parsed.messages[0].id, raw.messages[0].id.toLowerCase());
  assert.equal(parsed.messages[0].client_id, raw.messages[0].client_id.toLowerCase());
  assert.equal(parsed.messages[1].user_id, guest);
  assert.equal(parsed.messages[1].body, raw.messages[1].body);
  parsed.messages[1].body = 'Changed locally';
  parsed.messages.pop();
  assert.equal(raw.messages[1].body, '<b>"solution" is just a word in chat.</b>');
  assert.equal(raw.messages.length, 2);
  assert.throws(() => parseRoomChat(raw, host), RoomDataError);
});

test('chat snapshots reject oversized, duplicate, malformed, or secret-bearing payloads', () => {
  const base = chatState();
  const invalids = [
    { ...base, room_id: 'not-a-room' }, { ...base, expires_at: null }, { ...base, server_now: 'invalid' },
    { ...base, expires_at: base.server_now }, { ...base, messages: null },
    { ...base, messages: Array.from({ length: 101 }, () => base.messages[0]) },
    { ...base, messages: [base.messages[0], base.messages[0]] },
    { ...base, solution: [] }, { ...base, metadata: { seed: 'private' } },
  ];
  for (const invalid of invalids) assert.throws(() => parseRoomChat(invalid, roomId), RoomDataError);
  for (const patch of [
    { id: 'invalid' }, { client_id: 'invalid' }, { user_id: 'invalid' }, { nickname: 'x' },
    { body: '  message  ' }, { body: 'cafe\u0301' }, { body: '' }, { body: 'x'.repeat(501) },
    { created_at: '2026-11-19T12:00:02Z' }, { body: 1 }, { nickname: 'Guest\u0007' },
    { seed: 'private' }, { values: [] }, { metadata: { solution: [] } },
  ]) {
    assert.throws(() => parseRoomChat({ ...base, messages: [{ ...base.messages[0], ...patch }] }, roomId), RoomDataError);
  }
  const duplicateNonce = { ...base.messages[1], client_id: base.messages[0].client_id, user_id: base.messages[0].user_id };
  assert.throws(() => parseRoomChat({ ...base, messages: [base.messages[0], duplicateNonce] }, roomId), RoomDataError);
  // Different senders may independently generate the same nonce without sharing an idempotency key.
  assert.doesNotThrow(() => parseRoomChat({ ...base, messages: [base.messages[0], { ...duplicateNonce, user_id: guest }] }, roomId));
});

test('chat order and time bounds preserve Postgres microseconds instead of sorting by collapsed millisecond ties', () => {
  const raw = chatState();
  raw.messages[0].created_at = '2026-11-19T12:00:00.000100+00:00';
  raw.messages[1].created_at = '2026-11-19T12:00:00.000900+00:00';
  [raw.messages[0].id, raw.messages[1].id] = [raw.messages[1].id, raw.messages[0].id];
  assert.doesNotThrow(() => parseRoomChat(raw, roomId));
  assert.throws(() => parseRoomChat({ ...raw, messages: [...raw.messages].reverse() }, roomId), RoomDataError);
  assert.throws(() => parseRoomChat({ ...raw, messages: [raw.messages[0]], server_now: '2026-11-19T12:00:00.000050Z' }, roomId), RoomDataError);
  assert.throws(() => parseRoomChat({ ...raw, expires_at: '2026-11-19T12:00:00.000050Z', server_now: '2026-11-19T12:00:00.000100Z', messages: [] }, roomId), RoomDataError);
  raw.messages[1].created_at = raw.messages[0].created_at;
  assert.throws(() => parseRoomChat(raw, roomId), RoomDataError);
});
