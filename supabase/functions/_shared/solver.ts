// Generated from src/game/solver.ts by npm run supabase:sync.
// Edit the source file, then run the sync command.
import type { Difficulty, Puzzle } from './engine.ts';

export type SolverPuzzle = Pick<Puzzle, 'size' | 'givens' | 'rightWalls' | 'bottomWalls'>;

export interface SolverOptions {
  limit?: number;
  maxNodes?: number;
  random?: () => number;
}

export interface SolverResult {
  count: number;
  solutions: number[][];
  nodes: number;
  /** The search hit its node budget. A partial count is not a uniqueness proof. */
  exhausted: boolean;
}

export interface DifficultyAnalysis {
  difficulty: Difficulty;
  solved: boolean;
  nakedSingles: number;
  hiddenSingles: number;
  nakedPairs: number;
  guesses: number;
  maxGuessDepth: number;
  score: number;
}

interface Model {
  size: number;
  givens: number[];
  runs: number[][];
  domains: number[];
}

type Work = Omit<DifficultyAnalysis, 'difficulty' | 'solved' | 'score'>;
const POPCOUNT = Array.from({ length: 512 }, (_, value) => {
  let count = 0;
  for (let bits = value; bits; bits &= bits - 1) count++;
  return count;
});
const single = (mask: number) => mask !== 0 && (mask & (mask - 1)) === 0;

function buildModel(puzzle: SolverPuzzle): Model | null {
  if (!puzzle || !Number.isInteger(puzzle.size) || puzzle.size < 1 || puzzle.size > 9) return null;
  const { size, givens, rightWalls, bottomWalls } = puzzle;
  const count = size * size;
  if (![givens, rightWalls, bottomWalls].every(array => Array.isArray(array) && array.length === count)) return null;
  for (let index = 0; index < count; index++) {
    if (!Number.isInteger(givens[index]) || givens[index] < 0 || givens[index] > size ||
      typeof rightWalls[index] !== 'boolean' || typeof bottomWalls[index] !== 'boolean') return null;
  }
  const runs: number[][] = [];
  const limits = Array<number>(count).fill(size);
  for (let direction = 0; direction < 2; direction++) {
    for (let line = 0; line < size; line++) {
      let run: number[] = [];
      for (let offset = 0; offset < size; offset++) {
        const index = direction ? offset * size + line : line * size + offset;
        run.push(index);
        if (offset === size - 1 || (direction ? bottomWalls[index] : rightWalls[index])) {
          runs.push(run);
          for (const cell of run) limits[cell] = Math.min(limits[cell], run.length);
          run = [];
        }
      }
    }
  }
  if (givens.some((value, index) => value > limits[index])) return null;
  return {
    size, givens: [...givens], runs,
    domains: givens.map((value, index) => value ? 1 << (value - 1) : (1 << limits[index]) - 1),
  };
}

/** Exhaust naked singles before hidden singles, and both before naked pairs.
 * This priority ensures the analysis records techniques actually needed by this
 * solver rather than counting more advanced moves it happened to notice first. */
function propagate(domains: number[], model: Model, work?: Work, root = false): boolean {
  const counted = new Uint8Array(domains.length);
  for (let index = 0; index < domains.length; index++) {
    if (single(domains[index])) {
      counted[index] = 1;
      if (work && root && !model.givens[index]) work.nakedSingles++;
    }
  }
  const assignDomain = (index: number, mask: number) => {
    domains[index] = mask;
    if (work && single(mask) && !counted[index]) {
      work.nakedSingles++;
      counted[index] = 1;
    }
  };

  while (true) {
    let nakedChanged = true;
    while (nakedChanged) {
      nakedChanged = false;
      for (const run of model.runs) {
        let taken = 0;
        for (const index of run) {
          const mask = domains[index];
          if (mask === 0) return false;
          if (single(mask)) {
            if (taken & mask) return false;
            taken |= mask;
          }
        }
        for (const index of run) {
          const mask = domains[index];
          if (single(mask)) continue;
          const next = mask & ~taken;
          if (next === 0) return false;
          if (next !== mask) {
            assignDomain(index, next);
            nakedChanged = true;
          }
        }
      }
    }

    let hiddenChanged = false;
    for (const run of model.runs) {
      for (let value = 0; value < run.length; value++) {
        const bit = 1 << value;
        let cell = -1;
        let count = 0;
        for (const index of run) {
          if (domains[index] & bit) { cell = index; count++; }
        }
        if (count === 0) return false;
        if (count === 1 && domains[cell] !== bit) {
          domains[cell] = bit;
          if (work) work.hiddenSingles++;
          counted[cell] = 1;
          hiddenChanged = true;
        }
      }
    }
    if (hiddenChanged) continue;

    // Apply one effective pair at a time, then exhaust easier steps again.
    let pairChanged = false;
    outer: for (const run of model.runs) {
      const pairs = new Map<number, number[]>();
      for (const index of run) {
        const mask = domains[index];
        if (POPCOUNT[mask] !== 2) continue;
        const cells = pairs.get(mask) ?? [];
        cells.push(index);
        pairs.set(mask, cells);
      }
      for (const [mask, cells] of pairs) {
        if (cells.length !== 2) continue;
        let effective = false;
        for (const index of run) {
          if (cells.includes(index) || !(domains[index] & mask)) continue;
          const next = domains[index] & ~mask;
          if (next === 0) return false;
          assignDomain(index, next);
          effective = true;
        }
        if (effective) {
          if (work) work.nakedPairs++;
          pairChanged = true;
          break outer;
        }
      }
    }
    if (!pairChanged) return true;
  }
}

function shuffled<T>(items: T[], random?: () => number): T[] {
  if (!random) return items;
  for (let index = items.length - 1; index > 0; index--) {
    const sample = random();
    const other = Number.isFinite(sample) ? Math.max(0, Math.min(index, Math.floor(sample * (index + 1)))) : 0;
    [items[index], items[other]] = [items[other], items[index]];
  }
  return items;
}

function search(model: Model, options: SolverOptions, work?: Work): SolverResult {
  const limit = Number.isInteger(options.limit) && options.limit! > 0 ? options.limit! : 2;
  const maxNodes = Number.isInteger(options.maxNodes) && options.maxNodes! >= 0 ? options.maxNodes! : 100_000;
  const result: SolverResult = { count: 0, solutions: [], nodes: 0, exhausted: false };

  const visit = (domains: number[], depth: number) => {
    if (result.count >= limit || result.exhausted) return;
    if (result.nodes >= maxNodes) { result.exhausted = true; return; }
    result.nodes++;
    if (!propagate(domains, model, work, depth === 0)) return;
    let fewest = model.size + 1;
    let choices: number[] = [];
    for (let index = 0; index < domains.length; index++) {
      const count = POPCOUNT[domains[index]];
      if (count <= 1 || count > fewest) continue;
      if (count < fewest) { fewest = count; choices = []; }
      choices.push(index);
    }
    if (choices.length === 0) {
      result.count++;
      result.solutions.push(domains.map(mask => 32 - Math.clz32(mask)));
      return;
    }
    const cell = options.random ? shuffled(choices, options.random)[0] : choices[0];
    const values = shuffled(Array.from({ length: model.size }, (_, value) => 1 << value)
      .filter(bit => domains[cell] & bit), options.random);
    for (const value of values) {
      if (result.count >= limit || result.exhausted) break;
      if (work) {
        work.guesses++;
        work.maxGuessDepth = Math.max(work.maxGuessDepth, depth + 1);
      }
      const next = [...domains];
      next[cell] = value;
      visit(next, depth + 1);
    }
  };
  visit([...model.domains], 0);
  return result;
}

/** Counts solutions up to the requested limit. Only count=1, limit>=2, and
 * exhausted=false together prove uniqueness. The provided puzzle is not mutated. */
export function solvePuzzle(puzzle: SolverPuzzle, options: SolverOptions = {}): SolverResult {
  const model = buildModel(puzzle);
  return model ? search(model, options) : { count: 0, solutions: [], nodes: 0, exhausted: false };
}

/** A deterministic technique-based estimate, not a human-playtested rating.
 * Easy: naked singles suffice. Medium: hidden singles or naked pairs are needed.
 * Hard: those techniques stall and search is needed. Counts include work on
 * failed branches; pairs count effective eliminations, singles count placements.
 * Neither the stored solution nor the author-provided difficulty is inspected. */
export function analyzeDifficulty(puzzle: SolverPuzzle): DifficultyAnalysis {
  const work: Work = { nakedSingles: 0, hiddenSingles: 0, nakedPairs: 0, guesses: 0, maxGuessDepth: 0 };
  const model = buildModel(puzzle);
  const result = model ? search(model, { limit: 1, maxNodes: 10_000 }, work) : null;
  const solved = result?.count === 1 && !result.exhausted;
  const difficulty: Difficulty = !solved || work.guesses ? 'Hard'
    : work.hiddenSingles || work.nakedPairs ? 'Medium' : 'Easy';
  return {
    ...work, difficulty, solved,
    score: work.nakedSingles + 5 * work.hiddenSingles + 12 * work.nakedPairs + 30 * work.guesses + 10 * work.maxGuessDepth,
  };
}
