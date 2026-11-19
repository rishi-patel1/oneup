import assert from 'node:assert/strict';
import test from 'node:test';
import type { Puzzle } from './engine';
import { createSession, restoreSession, serializeSession, sessionReducer, type Session } from './session';

const puzzle: Puzzle = {
  id: 'session-test',
  title: 'Session test',
  size: 3,
  difficulty: 'Easy',
  description: 'A small Latin square for session behavior.',
  givens: [1, 0, 0, 0, 3, 0, 0, 0, 2],
  solution: [1, 2, 3, 2, 3, 1, 3, 1, 2],
  rightWalls: [false, false, true, false, false, true, false, false, true],
  bottomWalls: [false, false, false, false, false, false, true, true, true],
};

function entered(state: Session, index: number, value: number): Session {
  return sessionReducer(state, { type: 'set-value', index, value, puzzle });
}

test('a move is immutable, clears notes, and restores as one undo step', () => {
  const initial = createSession(puzzle);
  const noted = sessionReducer(initial, { type: 'toggle-note', index: 1, value: 3, puzzle });
  const twoNotes = sessionReducer(noted, { type: 'toggle-note', index: 1, value: 2, puzzle });
  const filled = entered(twoNotes, 1, 2);
  assert.deepEqual(initial.values, puzzle.givens);
  assert.deepEqual(initial.notes[1], []);
  assert.deepEqual(twoNotes.notes[1], [2, 3]);
  assert.equal(filled.values[1], 2);
  assert.deepEqual(filled.notes[1], []);
  const undone = sessionReducer(filled, { type: 'undo' });
  assert.equal(undone.values[1], 0);
  assert.deepEqual(undone.notes[1], [2, 3]);
  const redone = sessionReducer(undone, { type: 'redo' });
  assert.equal(redone.values[1], 2);
  assert.deepEqual(redone.notes[1], []);
});

test('new edits after undo drop the redo branch; clear-cell is undoable', () => {
  let state = entered(createSession(puzzle), 1, 2);
  state = entered(state, 2, 3);
  state = sessionReducer(state, { type: 'undo' });
  assert.equal(state.future.length, 1);
  state = entered(state, 3, 2);
  assert.equal(state.future.length, 0);
  state = sessionReducer(state, { type: 'clear-cell', index: 1, puzzle });
  assert.equal(state.values[1], 0);
  state = sessionReducer(state, { type: 'undo' });
  assert.equal(state.values[1], 2);
});

test('givens, invalid cells, out-of-range digits, and foreign puzzle actions cannot edit a session', () => {
  const state = createSession(puzzle);
  for (const index of [0, -1, 9, 1.5, NaN]) {
    assert.equal(entered(state, index, 2), state);
    assert.equal(sessionReducer(state, { type: 'clear-cell', index, puzzle }), state);
    assert.equal(sessionReducer(state, { type: 'hint', index, puzzle }), state);
    assert.equal(sessionReducer(state, { type: 'toggle-note', index, value: 2, puzzle }), state);
  }
  for (const value of [-1, 4, 1.5, NaN]) assert.equal(entered(state, 1, value), state);
  assert.equal(sessionReducer(state, { type: 'toggle-note', index: 1, value: 0, puzzle }), state);
  assert.equal(sessionReducer(state, { type: 'set-value', index: 1, value: 2, puzzle: { ...puzzle, id: 'other' } }), state);
});

test('hints replace mistakes and assistance counts survive undo', () => {
  let state = entered(createSession(puzzle), 1, 3);
  state = sessionReducer(state, { type: 'hint', index: 1, puzzle });
  assert.equal(state.values[1], 2);
  assert.equal(state.hintsUsed, 1);
  assert.equal(sessionReducer(state, { type: 'hint', index: 1, puzzle }), state);
  state = sessionReducer(state, { type: 'check' });
  state = sessionReducer(state, { type: 'undo' });
  assert.equal(state.values[1], 3);
  assert.equal(state.hintsUsed, 1);
  assert.equal(state.checksUsed, 1);
});

test('paused and completed sessions freeze time and editing', () => {
  let state = sessionReducer(createSession(puzzle), { type: 'tick', deltaMs: 1245.5 });
  assert.equal(state.elapsedMs, 1245.5);
  state = sessionReducer(state, { type: 'pause' });
  assert.equal(sessionReducer(state, { type: 'tick', deltaMs: 5000 }), state);
  assert.equal(entered(state, 1, 2), state);
  assert.equal(sessionReducer(state, { type: 'check' }), state);
  state = sessionReducer(state, { type: 'resume' });
  state = sessionReducer(state, { type: 'tick', deltaMs: 1000 });
  assert.equal(state.elapsedMs, 2245.5);
  for (const deltaMs of [0, -1, NaN, Infinity]) assert.equal(sessionReducer(state, { type: 'tick', deltaMs }), state);
  state = sessionReducer(state, { type: 'complete' });
  assert.equal(entered(state, 1, 2), state);
  assert.equal(sessionReducer(state, { type: 'undo' }), state);
  assert.equal(sessionReducer(state, { type: 'tick', deltaMs: 1000 }), state);
  assert.deepEqual(sessionReducer(state, { type: 'reset', puzzle }), createSession(puzzle));
});

test('history is bounded and serialized saves roundtrip without shared mutable arrays', () => {
  let state = createSession(puzzle);
  for (let move = 0; move < 150; move += 1) state = entered(state, 1, move % 2 === 0 ? 2 : 3);
  assert.equal(state.history.length, 100);
  state = sessionReducer(state, { type: 'tick', deltaMs: 12500 });
  state = sessionReducer(state, { type: 'pause' });
  const serialized = serializeSession(state);
  const restored = restoreSession(puzzle, JSON.parse(JSON.stringify(serialized)));
  assert.deepEqual(restored, state);
  assert.notEqual(restored?.values, state.values);
  assert.notEqual(restored?.notes[1], state.notes[1]);
  assert.notEqual(restored?.history[0].values, state.history[0].values);
});

test('restoration rejects malformed saves, changed givens and invalid undo snapshots', () => {
  const state = entered(createSession(puzzle), 1, 2);
  const base = JSON.parse(JSON.stringify(serializeSession(state)));
  const malformed: unknown[] = [
    null, [], {},
    { ...base, version: 9 },
    { ...base, puzzleId: 'old-puzzle' },
    { ...base, values: [1] },
    { ...base, notes: [] },
    { ...base, values: [2, ...base.values.slice(1)] },
    { ...base, notes: base.notes.map((notes: number[], index: number) => index === 2 ? [1, 1] : notes) },
    { ...base, notes: base.notes.map((notes: number[], index: number) => index === 2 ? [4] : notes) },
    { ...base, elapsedMs: -1 },
    { ...base, hintsUsed: 1.5 },
    { ...base, checksUsed: '2' },
    { ...base, history: Array.from({ length: 101 }, () => base.history[0]) },
    { ...base, history: [{ values: [2, ...base.values.slice(1)], notes: base.notes }] },
    { ...base, status: 'completed' },
  ];
  for (const raw of malformed) assert.equal(restoreSession(puzzle, raw), null);
});

test('only a truly solved board restores as completed', () => {
  const saved = serializeSession({ ...createSession(puzzle), values: [...puzzle.solution], status: 'completed', elapsedMs: 42000 });
  const restored = restoreSession(puzzle, saved);
  assert.equal(restored?.status, 'completed');
  assert.equal(restored?.elapsedMs, 42000);
});
