import assert from 'node:assert/strict';
import test from 'node:test';
import { getMistakes, type Puzzle } from '../game/engine';
import { PUZZLES } from '../game/puzzles';
import { compareBoards } from './board-comparison';
import type { PublicPuzzle } from './model';

function publicPuzzle(puzzle: Puzzle): PublicPuzzle {
  const { solution: _, ...publicBoard } = puzzle;
  return structuredClone(publicBoard);
}

test('comparison identifies legal-but-different guesses without treating blanks or clues as wrong', () => {
  const full = PUZZLES[0], puzzle = publicPuzzle(full), live = [...puzzle.givens];
  // Both choices fit their visible segments and do not duplicate a present clue.
  live[7] = 1;
  live[8] = 3; // Correct value is 2, but this partial move is still legal.
  assert.equal(getMistakes({ ...puzzle, solution: [] }, live).size, 0);
  const result = compareBoards(puzzle, full.solution, live)!;
  assert.deepEqual([...result.matching], [7]);
  assert.deepEqual([...result.differing], [8]);
  assert.equal(result.remaining, puzzle.givens.filter(value => value === 0).length - 2);
  assert.equal(result.matching.has(0), false);
  assert.equal(result.differing.has(2), false);
});

test('visible rule conflicts remain comparable and are independent of the completed-board classification', () => {
  const full = PUZZLES[0], puzzle = publicPuzzle(full), live = [...puzzle.givens];
  live[2] = 4; // Repeats the clue in this row and exceeds this cell's vertical run.
  assert.equal(getMistakes({ ...puzzle, solution: [] }, live).has(2), true);
  const result = compareBoards(puzzle, full.solution, live)!;
  assert.deepEqual([...result.differing], [2]);
  assert.equal(result.matching.size, 0);
});

test('comparison supports every available starter size without mutating boards or retaining input arrays', () => {
  for (const full of PUZZLES) {
    const puzzle = publicPuzzle(full), reference = [...full.solution], live = [...full.solution];
    const before = structuredClone({ puzzle, reference, live });
    const result = compareBoards(puzzle, reference, live)!;
    assert.ok(result);
    assert.equal(result.matching.size, puzzle.givens.filter(value => value === 0).length);
    assert.equal(result.differing.size, 0);
    assert.equal(result.remaining, 0);
    result.matching.clear();
    assert.deepEqual({ puzzle, reference, live }, before);
  }
});

test('missing, incomplete, mismatched, clue-breaking, and rule-breaking reference boards fail closed', () => {
  const full = PUZZLES[0], puzzle = publicPuzzle(full);
  const incomplete = [...full.solution]; incomplete[2] = 0;
  const invalidClue = [...full.solution]; invalidClue[0] = 1;
  const invalidRun = [...full.solution]; invalidRun[2] = 3;
  const sparse = Array<number>(25);
  for (const completed of [null, undefined, [], full.solution.slice(1), incomplete, invalidClue, invalidRun, sparse, [...full.solution, 1]]) {
    assert.equal(compareBoards(puzzle, completed, puzzle.givens), null);
  }
  for (const invalid of [NaN, Infinity, -1, 1.5, 6]) {
    const completed = [...full.solution]; completed[2] = invalid;
    assert.equal(compareBoards(puzzle, completed, puzzle.givens), null);
  }
});

test('malformed live data or puzzle geometry cannot produce comparison marks', () => {
  const full = PUZZLES[0], puzzle = publicPuzzle(full);
  const changedClue = [...puzzle.givens]; changedClue[0] = 1;
  for (const live of [[], puzzle.givens.slice(1), changedClue, Array<number>(25)]) {
    assert.equal(compareBoards(puzzle, full.solution, live), null);
  }
  for (const invalid of [NaN, Infinity, -1, 1.5, 6]) {
    const live = [...puzzle.givens]; live[2] = invalid;
    assert.equal(compareBoards(puzzle, full.solution, live), null);
  }
  for (const patch of [{ size: 4 }, { givens: [] }, { rightWalls: [] }, { bottomWalls: [] }, { givens: Array(25).fill(-1) }, { rightWalls: Array(25).fill(0) }]) {
    assert.equal(compareBoards({ ...puzzle, ...patch } as PublicPuzzle, full.solution, puzzle.givens), null);
  }
});

test('an answer-key property is never consulted to compare the already completed reference', () => {
  const full = PUZZLES[0], puzzle = publicPuzzle(full);
  Object.defineProperty(puzzle, 'solution', { get() { throw new Error('Answer key must not be read'); }, enumerable: true });
  // Public boards never carry this property; comparison deliberately copies
  // only the visible rules so an accidental caller cannot turn it into lookup.
  const result = compareBoards(puzzle, full.solution, puzzle.givens)!;
  assert.equal(result.matching.size, 0);
  assert.equal(result.differing.size, 0);
  assert.equal(result.remaining, puzzle.givens.filter(value => value === 0).length);
});
