import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeNickname, normalizeProgress, normalizeRoomCode, parseRoomState, RoomDataError } from './model';

const host = '11111111-1111-4111-8111-111111111111';
const guest = '22222222-2222-4222-8222-222222222222';
const roomId = '33333333-3333-4333-8333-333333333333';
const now = '2026-11-19T12:00:00.000Z';

function state() {
  return {
    room: { id: roomId, code: 'ABC123', host_id: host, status: 'racing', size: 5, difficulty: 'Easy', starts_at: now, created_at: now },
    players: [host, guest].map((user_id, index) => ({ user_id, nickname: index ? 'Guest' : 'Host', ready: true, progress_count: 0, finished_at: null, elapsed_ms: null, joined_at: now })),
    self: { values: [1, ...Array<number>(24).fill(0)], notes: Array.from({ length: 25 }, () => [] as number[]) },
    puzzle: { id: `match-${roomId}`, title: 'A shared challenge', description: 'Every cell counts.', size: 5, difficulty: 'Easy', givens: [1, ...Array<number>(24).fill(0)], rightWalls: Array<boolean>(25).fill(true), bottomWalls: Array<boolean>(25).fill(true) },
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
