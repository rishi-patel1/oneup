import assert from 'node:assert/strict';
import test from 'node:test';
import { createRoomSnapshotGate, getRoomTiming, isPlayerDone, normalizeNickname, normalizeProgress, normalizeRoomCode, parseRoomState, parseSpectatorState, RoomDataError } from './model';

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
