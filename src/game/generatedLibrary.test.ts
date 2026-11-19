import assert from 'node:assert/strict';
import test from 'node:test';
import { generatePuzzle } from './generator';
import { addGeneratedPuzzle, formatPuzzleCode, parsePuzzleCode, persistGeneratedLibrary, readGeneratedPuzzles, RECENT_PUZZLE_LIMIT } from './generatedLibrary';

test('puzzle codes roundtrip settings including Unicode and delimiters in the seed', () => {
  const puzzle = generatePuzzle({ size: 5, difficulty: 'Easy', seed: 'café: tea / 1' });
  assert.deepEqual(parsePuzzleCode(formatPuzzleCode(puzzle)), { size: 5, difficulty: 'Easy', seed: 'café: tea / 1' });
  for (const bad of ['oneup:99:5:easy:seed', 'oneup:1:4:easy:seed', 'oneup:1:5:easy:%', 'not-a-code']) {
    assert.equal(parsePuzzleCode(bad), null);
  }
});

test('restoration rejects malformed boards and mismatched generation metadata', () => {
  const puzzle = generatePuzzle({ size: 5, difficulty: 'Easy', seed: 'saved-board' });
  assert.deepEqual(readGeneratedPuzzles([puzzle]), [puzzle]);
  assert.deepEqual(readGeneratedPuzzles(null), []);
  assert.deepEqual(readGeneratedPuzzles([null, {}, { ...puzzle, id: 'wrong' }, { ...puzzle, solution: [] }, { ...puzzle, generation: { ...puzzle.generation, version: '99' } }]), []);
  const corrupted = structuredClone(puzzle);
  corrupted.givens[0] = puzzle.size + 1;
  assert.deepEqual(readGeneratedPuzzles([corrupted]), []);
  assert.equal(readGeneratedPuzzles([puzzle, puzzle]).length, 1);
});

test('the recent library retains the latest board, deduplicates IDs, and is bounded', () => {
  const puzzle = generatePuzzle({ size: 5, difficulty: 'Easy', seed: 'recent-board' });
  const previous = Array.from({ length: RECENT_PUZZLE_LIMIT }, (_, i) => ({ ...puzzle, id: `old-${i}` }));
  const next = addGeneratedPuzzle(previous, puzzle);
  assert.equal(next.length, RECENT_PUZZLE_LIMIT);
  assert.equal(next[0].id, puzzle.id);
  assert.equal(addGeneratedPuzzle(next, puzzle).filter(p => p.id === puzzle.id).length, 1);
  assert.equal(previous[0].id, 'old-0');
});

test('expiring a generated board removes its session without touching starter or retained progress', () => {
  const puzzle = generatePuzzle({ size: 5, difficulty: 'Easy', seed: 'retained' });
  const oldId = 'generated-v1-5-easy-previous';
  const values = new Map<string, string>([
    [`oneup:v1:puzzle:${oldId}`, 'old progress'],
    [`oneup:v1:puzzle:${puzzle.id}`, 'keep progress'],
    ['oneup:v1:puzzle:first-light', 'starter progress'],
  ]);
  const storage = { setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  assert.equal(persistGeneratedLibrary(storage, [puzzle], [oldId, puzzle.id, 'first-light'], 'oneup:v1:'), true);
  assert.equal(values.has(`oneup:v1:puzzle:${oldId}`), false);
  assert.equal(values.get(`oneup:v1:puzzle:${puzzle.id}`), 'keep progress');
  assert.equal(values.get('oneup:v1:puzzle:first-light'), 'starter progress');
  assert.deepEqual(JSON.parse(values.get('oneup:v1:generated')!), [puzzle]);
  assert.equal(persistGeneratedLibrary({ setItem: () => { throw new Error('storage blocked'); }, removeItem: () => {} }, [puzzle], [], 'oneup:v1:'), false);
});
