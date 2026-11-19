import assert from 'node:assert/strict';
import test from 'node:test';
import { generatePuzzle, GENERATOR_VERSION, getGeneratedPuzzleId, normalizeSeed } from './generator';
import { isSolved, verifyPuzzle } from './engine';
import { analyzeDifficulty, solvePuzzle } from './solver';

test('seed normalization is explicit, safe, and IDs retain seed identity', () => {
  assert.equal(normalizeSeed('  café  '), 'café');
  assert.equal(normalizeSeed('cafe\u0301'), 'café');
  for (const seed of ['', ' '.repeat(5), 'a'.repeat(65), 'a\nb', '\ud800']) {
    assert.throws(() => normalizeSeed(seed));
  }
  const options = { size: 5 as const, difficulty: 'Easy' as const, seed: 'a/b ? 💡' };
  assert.equal(getGeneratedPuzzleId(options), `generated-v${GENERATOR_VERSION}-5-easy-a%2Fb%20%3F%20%F0%9F%92%A1`);
  assert.notEqual(getGeneratedPuzzleId(options), getGeneratedPuzzleId({ ...options, seed: 'a/b ? 💡2' }));
  assert.notEqual(getGeneratedPuzzleId(options), getGeneratedPuzzleId({ ...options, size: 6 }));
  assert.notEqual(getGeneratedPuzzleId(options), getGeneratedPuzzleId({ ...options, difficulty: 'Hard' }));
});

test('the same normalized seed and options reproduce the whole board and rating', () => {
  const options = { size: 5 as const, difficulty: 'Easy' as const, seed: 'oneup-reproducible' };
  const first = generatePuzzle(options);
  const second = generatePuzzle({ ...options, seed: '  oneup-reproducible  ' });
  assert.deepEqual(first, second);
  assert.deepEqual(verifyPuzzle(first), []);
  assert.equal(isSolved(first, first.solution), true);
  const proof = solvePuzzle(first, { limit: 2, maxNodes: 100_000 });
  assert.equal(proof.exhausted, false);
  assert.equal(proof.count, 1);
  assert.deepEqual(proof.solutions[0], first.solution);
  assert.deepEqual(analyzeDifficulty(first), first.generation.rating);
});

test('different seeds produce new layouts and do not share mutable arrays', () => {
  const first = generatePuzzle({ size: 6, difficulty: 'Easy', seed: 'variation-a' });
  const second = generatePuzzle({ size: 6, difficulty: 'Easy', seed: 'variation-b' });
  assert.notDeepEqual([first.rightWalls, first.bottomWalls, first.solution], [second.rightWalls, second.bottomWalls, second.solution]);
  const original = second.givens[0];
  first.givens[0] = 99;
  assert.equal(second.givens[0], original);
});

test('runtime option validation rejects unsupported requests', () => {
  assert.throws(() => generatePuzzle({ size: 4, difficulty: 'Easy', seed: 'bad' } as never), /size/);
  assert.throws(() => generatePuzzle({ size: 5, difficulty: 'Expert', seed: 'bad' } as never), /Easy, Medium, or Hard/);
});
