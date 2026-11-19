import assert from 'node:assert/strict';
import test from 'node:test';
import { isSolved, type Puzzle } from './engine';
import { PUZZLES } from './puzzles';
import { analyzeDifficulty, solvePuzzle, type SolverPuzzle } from './solver';

const blankLatin: SolverPuzzle = {
  size: 3,
  givens: Array<number>(9).fill(0),
  rightWalls: Array<boolean>(9).fill(false),
  bottomWalls: Array<boolean>(9).fill(false),
};

function asPuzzle(puzzle: SolverPuzzle): Puzzle {
  return { id: 'solver-test', title: 'Test', difficulty: 'Easy', description: '', solution: [], ...puzzle };
}

test('counts all twelve 3×3 Latin solutions and returns rule-valid boards', () => {
  const result = solvePuzzle(blankLatin, { limit: 20 });
  assert.equal(result.count, 12);
  assert.equal(result.exhausted, false);
  assert.equal(new Set(result.solutions.map(solution => solution.join(','))).size, 12);
  for (const solution of result.solutions) assert.equal(isSolved(asPuzzle(blankLatin), solution), true);
});

test('a limit of two finds ambiguity without enumerating every solution', () => {
  const result = solvePuzzle(blankLatin);
  assert.equal(result.count, 2);
  assert.equal(result.solutions.length, 2);
  assert.equal(result.exhausted, false);
});

test('starter uniqueness is proved and the expected answer recovered', () => {
  for (const puzzle of PUZZLES) {
    const result = solvePuzzle(puzzle);
    assert.equal(result.count, 1, puzzle.id);
    assert.equal(result.exhausted, false, puzzle.id);
    assert.deepEqual(result.solutions[0], puzzle.solution, puzzle.id);
  }
});

test('duplicate clues and values exceeding a segment length are rejected', () => {
  assert.equal(solvePuzzle({ ...blankLatin, givens: [1, 1, ...Array<number>(7).fill(0)] }).count, 0);
  assert.equal(solvePuzzle({
    ...blankLatin,
    givens: [2, ...Array<number>(8).fill(0)],
    rightWalls: [true, ...Array<boolean>(8).fill(false)],
  }).count, 0);
});

test('malformed shapes and clue arrays fail closed without throwing', () => {
  const malformed: SolverPuzzle[] = [
    { ...blankLatin, size: 0 },
    { ...blankLatin, size: 10 },
    { ...blankLatin, givens: [1] },
    { ...blankLatin, givens: [NaN, ...Array<number>(8).fill(0)] },
    { ...blankLatin, givens: new Array<number>(9) },
    { ...blankLatin, rightWalls: [false] },
  ];
  for (const puzzle of malformed) assert.deepEqual(solvePuzzle(puzzle), {
    count: 0, solutions: [], nodes: 0, exhausted: false,
  });
});

test('a budget exhausted after finding one answer never claims a uniqueness proof', () => {
  const result = solvePuzzle(blankLatin, { maxNodes: 4 });
  assert.equal(result.count, 1);
  assert.equal(result.nodes, 4);
  assert.equal(result.exhausted, true);
  const zeroBudget = solvePuzzle(blankLatin, { maxNodes: 0 });
  assert.equal(zeroBudget.count, 0);
  assert.equal(zeroBudget.exhausted, true);
});

test('randomized construction is reproducible when the same random stream is supplied', () => {
  const deterministic = solvePuzzle(blankLatin, { limit: 1 });
  const randomA = solvePuzzle(blankLatin, { limit: 1, random: () => 0.25 });
  const randomB = solvePuzzle(blankLatin, { limit: 1, random: () => 0.25 });
  assert.deepEqual(randomA, randomB);
  assert.notDeepEqual(randomA.solutions[0], deterministic.solutions[0]);
  assert.equal(isSolved(asPuzzle(blankLatin), randomA.solutions[0]), true);
});

test('solving and rating do not mutate clue or wall arrays', () => {
  const puzzle = structuredClone(PUZZLES[0]);
  const original = structuredClone(puzzle);
  solvePuzzle(puzzle);
  analyzeDifficulty(puzzle);
  assert.deepEqual(puzzle, original);
});

test('Easy requires only naked singles, with one placement per original empty cell', () => {
  const analysis = analyzeDifficulty(PUZZLES[0]);
  assert.equal(analysis.solved, true);
  assert.equal(analysis.difficulty, 'Easy');
  assert.equal(analysis.nakedSingles, PUZZLES[0].givens.filter(value => !value).length);
  assert.equal(analysis.hiddenSingles, 0);
  assert.equal(analysis.nakedPairs, 0);
  assert.equal(analysis.guesses, 0);
});

test('Medium records hidden singles needed after naked singles stall', () => {
  const analysis = analyzeDifficulty(PUZZLES[4]);
  assert.equal(analysis.solved, true);
  assert.equal(analysis.difficulty, 'Medium');
  assert.ok(analysis.hiddenSingles > 0);
  assert.equal(analysis.guesses, 0);
  assert.equal(analysis.nakedSingles + analysis.hiddenSingles, PUZZLES[4].givens.filter(value => !value).length);
});

test('Hard records branching when the supported human techniques stall', () => {
  const analysis = analyzeDifficulty(blankLatin);
  assert.equal(analysis.solved, true);
  assert.equal(analysis.difficulty, 'Hard');
  assert.ok(analysis.guesses > 0);
  assert.ok(analysis.maxGuessDepth > 0);
});

test('ratings depend on solving steps, not stored answers, labels, board size or clue count', () => {
  const puzzle = PUZZLES[4];
  const altered = { ...puzzle, difficulty: 'Easy' as const, solution: Array<number>(49).fill(9) };
  assert.deepEqual(analyzeDifficulty(puzzle), analyzeDifficulty(altered));
  // A completed 8×8 has no logical work even though its board is larger.
  const completed = analyzeDifficulty({ ...PUZZLES[5], givens: [...PUZZLES[5].solution] });
  assert.equal(completed.difficulty, 'Easy');
  assert.equal(completed.score, 0);
  assert.equal(completed.guesses, 0);
});

test('inconsistent clues are never reported as successfully rated', () => {
  const analysis = analyzeDifficulty({ ...blankLatin, givens: [1, 1, ...Array<number>(7).fill(0)] });
  assert.equal(analysis.solved, false);
});
