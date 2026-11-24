import assert from 'node:assert/strict';
import test from 'node:test';
import { generatePuzzle, GENERATOR_VERSION } from './generator';
import { getSegments, verifyPuzzle, type Difficulty, type Puzzle } from './engine';
import { analyzeDifficulty, solvePuzzle } from './solver';

function segmentation(puzzle: Puzzle) {
  const { size } = puzzle;
  const splitRows = new Set<number>(), splitColumns = new Set<number>();
  let rightWalls = 0, bottomWalls = 0;
  for (let index = 0; index < size * size; index++) {
    if (index % size < size - 1 && puzzle.rightWalls[index]) {
      rightWalls++; splitRows.add(Math.floor(index / size));
    }
    if (Math.floor(index / size) < size - 1 && puzzle.bottomWalls[index]) {
      bottomWalls++; splitColumns.add(index % size);
    }
  }
  const runs = getSegments(puzzle);
  return { rightWalls, bottomWalls, splitRows: splitRows.size, splitColumns: splitColumns.size,
    lengths: new Set([...runs.rows, ...runs.columns].map(run => run.length)) };
}

function assertSegmented(puzzle: Puzzle) {
  const shape = segmentation(puzzle);
  // A few walls clustered in one corner still look like an unsegmented Latin square.
  assert.ok(shape.rightWalls >= puzzle.size - 1, 'enough internal boundaries across rows');
  assert.ok(shape.bottomWalls >= puzzle.size - 1, 'enough internal boundaries down columns');
  assert.ok(shape.splitRows >= Math.ceil(puzzle.size * 0.6), 'most rows contain a boundary');
  assert.ok(shape.splitColumns >= Math.ceil(puzzle.size * 0.6), 'most columns contain a boundary');
  assert.ok(shape.lengths.size >= 3, 'the board has varied segment lengths');
}

test('new generated boards retain substantial segmentation at every size and difficulty', async t => {
  for (const size of [5, 6, 7, 8] as const) {
    for (const difficulty of ['Easy', 'Medium', 'Hard'] as Difficulty[]) {
      await t.test(`${size} × ${size} ${difficulty}`, () => {
        const puzzle = generatePuzzle({ size, difficulty, seed: `quality-review-v1-${size}-${difficulty}-0` });
        assert.equal(puzzle.generation.version, GENERATOR_VERSION);
        assertSegmented(puzzle);
        assert.deepEqual(verifyPuzzle(puzzle), []);
        assert.ok(puzzle.givens.filter(value => !value).length >= Math.ceil(size * size * 0.55));
        assert.equal(analyzeDifficulty(puzzle).difficulty, difficulty);
        const proof = solvePuzzle(puzzle, { limit: 2, maxNodes: 100_000 });
        assert.equal(proof.exhausted, false);
        assert.equal(proof.count, 1, 'the segmented board is uniquely solvable');
        assert.deepEqual(proof.solutions[0], puzzle.solution);
      });
    }
  }
});

test('small hard puzzles stay segmented across seeds without reusing one fixed layout', () => {
  const layouts = new Set<string>();
  for (const seed of ['quality-hard-small-a', 'quality-hard-small-b', 'quality-hard-small-c']) {
    const puzzle = generatePuzzle({ size: 5, difficulty: 'Hard', seed });
    assertSegmented(puzzle);
    assert.equal(analyzeDifficulty(puzzle).difficulty, 'Hard');
    layouts.add(JSON.stringify([puzzle.rightWalls, puzzle.bottomWalls]));
  }
  assert.ok(layouts.size >= 2, 'seeds produce different segment arrangements');
});
