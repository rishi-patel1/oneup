import { getSegments, verifyPuzzle, type Difficulty, type Puzzle } from './engine';
import { analyzeDifficulty, solvePuzzle, type DifficultyAnalysis } from './solver';

/** Increment when generation, PRNG, or rating rules change. Seeds include this version. */
export const GENERATOR_VERSION = '2';
export const SUPPORTED_GENERATOR_VERSIONS = ['1', '2'] as const;

export interface GenerationOptions {
  size: 5 | 6 | 7 | 8;
  difficulty: Difficulty;
  seed: string;
  version?: string;
}

export type GeneratedPuzzle = Puzzle & {
  generation: {
    version: string;
    seed: string;
    requestedDifficulty: Difficulty;
    rating: DifficultyAnalysis;
  };
};

const MAX_LAYOUT_ATTEMPTS = 2_048;
const MAX_SOLUTION_NODES = 3_000;
const MAX_UNIQUENESS_NODES = 3_000;
const MAX_TOTAL_NODES = 1_000_000;
const MAX_SEGMENTED_LAYOUT_ATTEMPTS = 8_192;
const MAX_SEGMENTED_NODES = 2_000_000;
const LEVEL: Record<Difficulty, number> = { Easy: 0, Medium: 1, Hard: 2 };

export function normalizeSeed(seed: string): string {
  if (typeof seed !== 'string') throw new Error('Enter a seed between 1 and 64 characters.');
  const normalized = seed.trim().normalize('NFC');
  if (!normalized || normalized.length > 64 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error('Enter a seed between 1 and 64 characters, without control characters.');
  }
  try { encodeURIComponent(normalized); }
  catch { throw new Error('The seed must contain valid Unicode characters.'); }
  return normalized;
}

function validateOptions(options: GenerationOptions): GenerationOptions & { version: string } {
  if (![5, 6, 7, 8].includes(options.size)) throw new Error('Choose a board size from 5 through 8.');
  if (!Object.hasOwn(LEVEL, options.difficulty)) throw new Error('Choose Easy, Medium, or Hard.');
  if (options.version !== undefined && !SUPPORTED_GENERATOR_VERSIONS.includes(options.version as '1' | '2')) throw new Error('Choose a supported generator version.');
  return { ...options, seed: normalizeSeed(options.seed), version: options.version ?? GENERATOR_VERSION };
}

export function getGeneratedPuzzleId(options: GenerationOptions): string {
  const normalized = validateOptions(options);
  return `generated-v${normalized.version}-${normalized.size}-${normalized.difficulty.toLowerCase()}-${encodeURIComponent(normalized.seed)}`;
}

/** FNV-1a plus Mulberry32: integer operations make generation stable across browsers. */
function seededRandom(seed: string): () => number {
  let state = 2_166_136_261;
  for (let index = 0; index < seed.length; index++) {
    state = Math.imul(state ^ seed.charCodeAt(index), 16_777_619) >>> 0;
  }
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function shuffle<T>(values: T[], random: () => number): T[] {
  for (let index = values.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [values[index], values[other]] = [values[other], values[index]];
  }
  return values;
}

/** Mirrored layouts balance the global run-length counts across both directions.
 * They are generated from scratch, rather than selected from the starter library.
 * A solver still proves feasibility; symmetry alone does not guarantee a solution. */
function createLegacyLayout(size: number, difficulty: Difficulty, random: () => number) {
  const rightWalls = Array<boolean>(size ** 2).fill(false);
  const bottomWalls = Array<boolean>(size ** 2).fill(false);
  const positions = shuffle(Array.from({ length: size * (size - 1) }, (_, index) => (
    Math.floor(index / (size - 1)) * size + index % (size - 1)
  )), random);
  const minimum = difficulty === 'Easy' ? size - 2 : difficulty === 'Medium' ? 2 : 1;
  const maximum = difficulty === 'Easy' ? size + 1 : difficulty === 'Medium' ? size - 1 : Math.max(2, size - 4);
  const wallCount = minimum + Math.floor(random() * (maximum - minimum + 1));
  for (const cell of positions.slice(0, wallCount)) {
    rightWalls[cell] = true;
    bottomWalls[(cell % size) * size + Math.floor(cell / size)] = true;
  }
  return { size, rightWalls, bottomWalls, givens: Array<number>(size ** 2).fill(0) };
}

/** Spread real boundaries through most rows and columns instead of reducing
 * segmentation to make the board harder. Clue removal controls the rating. */
function createSegmentedLayout(size: number, difficulty: Difficulty, random: () => number) {
  const rightWalls = Array<boolean>(size ** 2).fill(false);
  const bottomWalls = Array<boolean>(size ** 2).fill(false);
  const positions = shuffle(Array.from({ length: size * (size - 1) }, (_, index) => (
    Math.floor(index / (size - 1)) * size + index % (size - 1)
  )), random);
  // Four split points per direction keep 5 × 5 Hard boards segmented while
  // retaining enough long intersections for genuinely difficult deductions.
  const choices = difficulty === 'Hard' && size === 5 ? 1 : 3;
  const wallCount = size - 1 + Math.floor(random() * choices);
  const chosen = positions.slice(0, wallCount);
  const rows = new Set(chosen.map(cell => Math.floor(cell / size)));
  const boundaries = new Set(chosen.map(cell => cell % size));
  if (rows.size < Math.ceil(size * 0.6) || boundaries.size < 2) return null;
  const lengths = new Set<number>();
  for (let row = 0; row < size; row++) {
    let start = 0;
    for (let column = 0; column < size; column++) {
      if (column === size - 1 || chosen.includes(row * size + column)) {
        lengths.add(column - start + 1);
        start = column + 1;
      }
    }
  }
  if (lengths.size < 3 || [...boundaries].some(column => chosen.filter(cell => cell % size === column).length === size)) return null;
  for (const cell of chosen) {
    rightWalls[cell] = true;
    bottomWalls[(cell % size) * size + Math.floor(cell / size)] = true;
  }
  return { size, rightWalls, bottomWalls, givens: Array<number>(size ** 2).fill(0) };
}

/** Generate a unique puzzle within deterministic search budgets.
 * Every retained clue removal is certified by a forced-value proof or a
 * complete solution count to two;
 * exhausted searches never count as uniqueness. The actual human-style rating
 * must match the requested level before a board can be returned. */
export function generatePuzzle(input: GenerationOptions): GeneratedPuzzle {
  const options = validateOptions(input);
  const { size, difficulty, seed, version } = options;
  const random = seededRandom(`${version}\0${size}\0${difficulty}\0${seed}`);
  let usedNodes = 0;
  const maximumAttempts = version === '1' ? MAX_LAYOUT_ATTEMPTS : MAX_SEGMENTED_LAYOUT_ATTEMPTS;
  const maximumNodes = version === '1' ? MAX_TOTAL_NODES : MAX_SEGMENTED_NODES;
  for (let attempt = 0; attempt < maximumAttempts && usedNodes < maximumNodes; attempt++) {
    const layout = version === '1' ? createLegacyLayout(size, difficulty, random) : createSegmentedLayout(size, difficulty, random);
    if (!layout) continue;
    const construction = solvePuzzle(layout, {
      limit: 1, maxNodes: Math.min(MAX_SOLUTION_NODES, maximumNodes - usedNodes), random,
    });
    usedNodes += construction.nodes;
    if (!construction.solutions.length) continue;

    const solution = construction.solutions[0];
    const runs = version === '1' ? null : getSegments({ ...layout, id: '', title: '', description: '', difficulty, solution: [] });
    const cellRuns = runs ? Array.from({ length: size ** 2 }, (_, cell) =>
      [runs.rows.find(run => run.includes(cell))!, runs.columns.find(run => run.includes(cell))!]) : null;
    let best: { givens: number[]; rating: DifficultyAnalysis } | null = null;
    const carveAttempts = version === '1' ? 1 : difficulty === 'Hard' ? 4 : 2;
    for (let carve = 0; carve < carveAttempts; carve++) {
      const board = { ...layout, givens: [...solution] };
      const positions = shuffle(Array.from({ length: size ** 2 }, (_, index) => index), random);
      for (const index of positions) {
        if (usedNodes >= maximumNodes) break;
        const clue = board.givens[index];
        board.givens[index] = 0;
        // A value already forced by remaining peers cannot introduce a second
        // solution when its clue is removed. Avoid rebuilding a full search for it.
        let forced = false;
        if (cellRuns) {
          let domain = (1 << Math.min(...cellRuns[index].map(run => run.length))) - 1;
          for (const run of cellRuns[index]) {
            for (const peer of run) if (board.givens[peer]) domain &= ~(1 << (board.givens[peer] - 1));
          }
          forced = domain !== 0 && (domain & (domain - 1)) === 0;
        }
        if (!forced) {
          const uniqueness = solvePuzzle(board, {
            limit: 2, maxNodes: Math.min(MAX_UNIQUENESS_NODES, maximumNodes - usedNodes),
          });
          usedNodes += uniqueness.nodes;
          if (uniqueness.count !== 1 || uniqueness.exhausted) {
            board.givens[index] = clue;
            continue;
          }
        }
        if (version !== '1' && difficulty === 'Hard' && board.givens.filter(value => !value).length < Math.ceil(size ** 2 * 0.55)) continue;
        const rating = analyzeDifficulty(board);
        if (!rating.solved || LEVEL[rating.difficulty] > LEVEL[difficulty]) {
          board.givens[index] = clue;
          continue;
        }
        if (rating.difficulty === difficulty) best = { givens: [...board.givens], rating };
      }
      if (best && best.givens.filter(value => !value).length >= Math.ceil(size ** 2 * 0.55)) break;
    }

    // Avoid returning a nearly filled exercise just to satisfy a difficulty label.
    if (!best || best.givens.filter(value => !value).length < Math.ceil(size ** 2 * 0.55)) continue;
    if (version !== '1') {
      const proof = solvePuzzle({ ...layout, givens: best.givens }, {
        limit: 2, maxNodes: Math.min(MAX_UNIQUENESS_NODES, maximumNodes - usedNodes),
      });
      usedNodes += proof.nodes;
      if (proof.count !== 1 || proof.exhausted) continue;
    }
    const puzzle: GeneratedPuzzle = {
      id: getGeneratedPuzzleId(options),
      title: 'Fresh perspective',
      description: difficulty === 'Easy' ? 'A fresh grid for a gentle logic break.'
        : difficulty === 'Medium' ? 'Look for the number with only one home in a segment.'
        : 'Pencil in possibilities and follow the consequences.',
      size, difficulty: best.rating.difficulty,
      givens: best.givens, solution: [...solution],
      rightWalls: [...layout.rightWalls], bottomWalls: [...layout.bottomWalls],
      generation: { version, seed, requestedDifficulty: difficulty, rating: best.rating },
    };
    if (verifyPuzzle(puzzle).length) throw new Error('The generated board failed its integrity check. Try another seed.');
    return puzzle;
  }
  throw new Error(`Couldn’t find a ${difficulty.toLowerCase()} ${size} × ${size} puzzle within the search budget. Try a different seed.`);
}
