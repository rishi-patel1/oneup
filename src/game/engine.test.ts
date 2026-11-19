import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getCandidates,
  getCellLimit,
  getConflicts,
  getMistakes,
  getSegments,
  isSolved,
  verifyPuzzle,
  type Puzzle,
} from './engine';
import { PUZZLES } from './puzzles';

const latin: Puzzle = {
  id: 'test-latin', title: 'Test', size: 3, difficulty: 'Easy', description: '',
  givens: [1, 0, 0, 0, 0, 0, 0, 0, 0],
  solution: [1, 2, 3, 2, 3, 1, 3, 1, 2],
  rightWalls: Array(9).fill(false), bottomWalls: Array(9).fill(false),
};

/** Independent all-different solver, including hidden-single propagation. Stops at 2. */
function countSolutions(puzzle: Puzzle): number {
  const { rows, columns } = getSegments(puzzle);
  const runs = [...rows, ...columns];
  const domains = puzzle.givens.map((value, index) => value ? 1 << (value - 1) :
    (1 << Math.min(...runs.filter((run) => run.includes(index)).map((run) => run.length))) - 1);
  let count = 0;
  function search(state: number[]) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const run of runs) {
        let taken = 0;
        for (const index of run) {
          const mask = state[index];
          if (mask === 0) return;
          if ((mask & (mask - 1)) === 0) {
            if (taken & mask) return;
            taken |= mask;
          }
        }
        for (const index of run) {
          const mask = state[index];
          if ((mask & (mask - 1)) !== 0) {
            const next = mask & ~taken;
            if (next === 0) return;
            if (next !== mask) { state[index] = next; changed = true; }
          }
        }
        for (let value = 0; value < run.length; value++) {
          const bit = 1 << value;
          const possible = run.filter((index) => (state[index] & bit) !== 0);
          if (possible.length === 0) return;
          if (possible.length === 1 && state[possible[0]] !== bit) {
            state[possible[0]] = bit;
            changed = true;
          }
        }
      }
    }
    const choices = state.flatMap((mask, index) => (mask & (mask - 1)) ? [index] : []);
    if (!choices.length) { count++; return; }
    const index = choices.reduce((best, current) =>
      state[current].toString(2).replaceAll('0', '').length <
      state[best].toString(2).replaceAll('0', '').length ? current : best);
    for (let value = 0; value < puzzle.size; value++) {
      const bit = 1 << value;
      if (state[index] & bit) {
        const next = [...state]; next[index] = bit; search(next);
        if (count >= 2) return;
      }
    }
  }
  search(domains);
  return count;
}

test('walls split independent horizontal and vertical segments; edges are implicit', () => {
  const puzzle = { ...latin, rightWalls: [false, true, false, ...Array(6).fill(false)],
    bottomWalls: [true, ...Array(8).fill(false)] };
  const { rows, columns } = getSegments(puzzle);
  assert.deepEqual(rows, [[0, 1], [2], [3, 4, 5], [6, 7, 8]]);
  assert.deepEqual(columns, [[0], [3, 6], [1, 4, 7], [2, 5, 8]]);
  assert.equal(getCellLimit(puzzle, 0), 1);
  assert.equal(getCellLimit(puzzle, 2), 1);
  assert.equal(getCellLimit(puzzle, 4), 3);
  assert.equal(getCellLimit(puzzle, -1), 0);
});

test('conflicts report duplicate and out-of-range values, leaving empty cells alone', () => {
  assert.deepEqual([...getConflicts(latin, [1, 1, 0, 0, 0, 0, 0, 0, 0])].sort(), [0, 1]);
  assert.deepEqual([...getConflicts(latin, [0, 0, 4, 0, 0, 0, 0, 0, 0])], [2]);
  assert.deepEqual([...getConflicts(latin, [0, -1, 0, 0, 0, 0, 0, 0, 0])], [1]);
  assert.equal(getConflicts(latin, latin.solution).size, 0);
});

test('the same value is allowed in different segments of one row or column', () => {
  const ones: Puzzle = { ...latin, givens: Array(9).fill(0), solution: Array(9).fill(1),
    rightWalls: Array(9).fill(true), bottomWalls: Array(9).fill(true) };
  assert.equal(getConflicts(ones, ones.solution).size, 0);
  assert.equal(isSolved(ones, ones.solution), true);
});

test('candidates use both segments and ignore the selected cell’s old value', () => {
  const values = [1, 2, 3, 0, 0, 0, 3, 0, 0];
  assert.deepEqual(getCandidates(latin, values, 1), [2]);
  assert.deepEqual(getCandidates(latin, values, 3), [2]);
  assert.deepEqual(getCandidates(latin, values, 50), []);
});

test('mistake checking differs from immediate rule conflict detection', () => {
  const values = [1, 3, 0, 0, 0, 0, 0, 0, 0];
  assert.equal(getConflicts(latin, values).size, 0);
  assert.deepEqual([...getMistakes(latin, values)], [1]);
});

test('completion rejects blanks, malformed values, broken clues, and invalid runs', () => {
  assert.equal(isSolved(latin, latin.solution), true);
  assert.equal(isSolved(latin, latin.givens), false);
  assert.equal(isSolved(latin, [1, 2, 3]), false);
  assert.equal(isSolved(latin, [1, 1, 3, 2, 3, 1, 3, 1, 2]), false);
  // Swapping 1 and 2 produces another valid Latin square but violates the fixed 1.
  assert.equal(isSolved(latin, [2, 1, 3, 1, 3, 2, 3, 2, 1]), false);
  assert.equal(isSolved(latin, [NaN, ...latin.solution.slice(1)]), false);
  const sparse = new Array<number>(9); sparse[0] = 1;
  assert.equal(isSolved(latin, sparse), false);
});

test('authoring validation diagnoses malformed clues and arrays', () => {
  assert.deepEqual(verifyPuzzle(latin), []);
  assert.ok(verifyPuzzle({ ...latin, solution: [1] }).some((error) => error.includes('solution')));
  assert.ok(verifyPuzzle({ ...latin, givens: [2, ...latin.givens.slice(1)] }).some((error) => error.includes('Clues')));
});

test('starter collection spans promised sizes and has stable unique IDs', () => {
  assert.equal(PUZZLES.length, 6);
  assert.equal(new Set(PUZZLES.map((puzzle) => puzzle.id)).size, PUZZLES.length);
  assert.deepEqual([...new Set(PUZZLES.map((puzzle) => puzzle.size))].sort(), [5, 6, 7, 8]);
});

for (const puzzle of PUZZLES) {
  test(`${puzzle.title}: solution is valid and clues determine exactly one answer`, () => {
    assert.deepEqual(verifyPuzzle(puzzle), []);
    assert.equal(isSolved(puzzle, puzzle.solution), true);
    assert.equal(countSolutions(puzzle), 1);
  });
}
