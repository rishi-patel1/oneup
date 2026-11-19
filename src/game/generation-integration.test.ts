import assert from 'node:assert/strict';
import test from 'node:test';
import { generatePuzzle } from './generator';
import { analyzeDifficulty } from './solver';
import { getSegments, isSolved, verifyPuzzle, type Difficulty, type Puzzle } from './engine';
import { PUZZLES } from './puzzles';

/**
 * Independent oracle copied from the original starter-board tests. It does not
 * import the production search implementation or consult the stored solution.
 * Its independent budget is only a safety stop, never a uniqueness certificate.
 */
function independentlyCountSolutions(puzzle: Puzzle) {
  const { rows, columns } = getSegments(puzzle);
  const runs = [...rows, ...columns];
  const domains = puzzle.givens.map((value, index) => value ? 1 << (value - 1) :
    (1 << Math.min(...runs.filter(run => run.includes(index)).map(run => run.length))) - 1);
  let count = 0;
  let nodes = 0;
  let exhausted = false;
  function search(state: number[]) {
    if (++nodes > 1_000_000) { exhausted = true; return; }
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
          const possible = run.filter(index => (state[index] & bit) !== 0);
          if (possible.length === 0) return;
          if (possible.length === 1 && state[possible[0]] !== bit) {
            state[possible[0]] = bit;
            changed = true;
          }
        }
      }
    }
    const choices = state.flatMap((mask, index) => mask & (mask - 1) ? [index] : []);
    if (!choices.length) { count++; return; }
    const index = choices.reduce((best, current) =>
      state[current].toString(2).replaceAll('0', '').length <
      state[best].toString(2).replaceAll('0', '').length ? current : best);
    for (let value = 0; value < puzzle.size; value++) {
      const bit = 1 << value;
      if (state[index] & bit) {
        const next = [...state];
        next[index] = bit;
        search(next);
        if (count >= 2 || exhausted) return;
      }
    }
  }
  search(domains);
  return { count, nodes, exhausted };
}

/** Compare wall geometry even when a board is rotated or reflected. */
function canonicalWallLayout(puzzle: Puzzle) {
  const walls: [number, number][] = [];
  for (let index = 0; index < puzzle.size ** 2; index++) {
    const column = index % puzzle.size;
    const row = Math.floor(index / puzzle.size);
    if (column < puzzle.size - 1 && puzzle.rightWalls[index]) walls.push([index, index + 1]);
    if (row < puzzle.size - 1 && puzzle.bottomWalls[index]) walls.push([index, index + puzzle.size]);
  }
  const layouts: string[] = [];
  for (let reflected = 0; reflected < 2; reflected++) {
    for (let rotation = 0; rotation < 4; rotation++) {
      const transform = (index: number) => {
        let row = Math.floor(index / puzzle.size);
        let column = index % puzzle.size;
        if (reflected) column = puzzle.size - 1 - column;
        for (let turn = 0; turn < rotation; turn++) {
          [row, column] = [column, puzzle.size - 1 - row];
        }
        return row * puzzle.size + column;
      };
      layouts.push(walls.map(([first, second]) => {
        const a = transform(first), b = transform(second);
        return `${Math.min(a, b)}:${Math.max(a, b)}`;
      }).sort().join(','));
    }
  }
  return layouts.sort()[0];
}

const generatedByGroup = new Map<string, Puzzle[]>();
const sizes = [5, 6, 7, 8] as const;
const difficulties: Difficulty[] = ['Easy', 'Medium', 'Hard'];
const cases = sizes.flatMap(size => difficulties.map(difficulty => ({
  size, difficulty, seed: `integration-${size}-${difficulty}`,
})));
for (const size of [5, 8] as const) {
  for (const suffix of ['a', 'b']) {
    cases.push({ size, difficulty: 'Hard', seed: `integration-hard-${suffix}` });
  }
}

for (const options of cases) {
  test(`generated ${options.size}×${options.size} ${options.difficulty}, seed ${options.seed}: independent certification`, t => {
    const started = performance.now();
    const puzzle = generatePuzzle(options);
    const generatedMs = performance.now() - started;
    assert.equal(puzzle.size, options.size);
    assert.equal(puzzle.generation.seed, options.seed);
    assert.equal(puzzle.generation.requestedDifficulty, options.difficulty);
    assert.equal(typeof puzzle.generation.version, 'string');
    assert.deepEqual(verifyPuzzle(puzzle), []);
    assert.equal(isSolved(puzzle, puzzle.solution), true);
    assert.ok(puzzle.givens.some(value => value === 0), 'A playable puzzle needs empty cells.');
    const oracle = independentlyCountSolutions(puzzle);
    assert.equal(oracle.exhausted, false, 'Independent oracle exhausted its budget; uniqueness is unproven.');
    assert.equal(oracle.count, 1, 'Independent solver must find exactly one solution.');
    const analysis = analyzeDifficulty(puzzle);
    assert.equal(analysis.solved, true);
    assert.equal(puzzle.difficulty, analysis.difficulty);
    assert.equal(puzzle.difficulty, options.difficulty, 'The requested grade must actually be achieved.');
    assert.deepEqual(puzzle.generation.rating, analysis);
    if (options.difficulty === 'Hard') assert.ok(analysis.guesses > 0, 'Hard must require search beyond the supported logical techniques.');
    const group = `${options.size}-${options.difficulty}`;
    generatedByGroup.set(group, [...(generatedByGroup.get(group) ?? []), puzzle]);
    t.diagnostic(`${generatedMs.toFixed(1)} ms generation; ${oracle.nodes} independent search nodes; ${performance.now() - started} ms total.`);
  });
}

for (const size of [5, 8]) {
  test(`fresh ${size}×${size} seeds vary geometry beyond rotations and starter templates`, () => {
    const boards = generatedByGroup.get(`${size}-Hard`) ?? [];
    assert.equal(boards.length, 3, 'All three seed cases must have succeeded.');
    const layouts = boards.map(canonicalWallLayout);
    assert.ok(new Set(layouts).size >= 2, 'Changing the seed should change wall geometry, not only clues or orientation.');
    const starterLayouts = new Set(PUZZLES.filter(puzzle => puzzle.size === size).map(canonicalWallLayout));
    assert.ok(layouts.some(layout => !starterLayouts.has(layout)), 'Fresh generation must produce wall geometry beyond the starter collection.');
    assert.equal(new Set(boards.map(board => board.id)).size, boards.length, 'Different seeds must have distinct stable IDs.');
  });
}
