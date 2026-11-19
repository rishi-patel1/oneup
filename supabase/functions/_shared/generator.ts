// Generated from src/game/generator.ts by npm run supabase:sync.
// Edit the source file, then run the sync command.
import { verifyPuzzle, type Difficulty, type Puzzle } from './engine.ts';
import { analyzeDifficulty, solvePuzzle, type DifficultyAnalysis } from './solver.ts';

/** Increment when generation, PRNG, or rating rules change. Seeds include this version. */
export const GENERATOR_VERSION = '1';

export interface GenerationOptions {
  size: 5 | 6 | 7 | 8;
  difficulty: Difficulty;
  seed: string;
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

function validateOptions(options: GenerationOptions): GenerationOptions {
  if (![5, 6, 7, 8].includes(options.size)) throw new Error('Choose a board size from 5 through 8.');
  if (!Object.hasOwn(LEVEL, options.difficulty)) throw new Error('Choose Easy, Medium, or Hard.');
  return { ...options, seed: normalizeSeed(options.seed) };
}

export function getGeneratedPuzzleId(options: GenerationOptions): string {
  const normalized = validateOptions(options);
  return `generated-v${GENERATOR_VERSION}-${normalized.size}-${normalized.difficulty.toLowerCase()}-${encodeURIComponent(normalized.seed)}`;
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
function createLayout(size: number, difficulty: Difficulty, random: () => number) {
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

/** Generate a unique puzzle within deterministic search budgets.
 * Every retained clue removal is certified by a complete solution count to two;
 * exhausted searches never count as uniqueness. The actual human-style rating
 * must match the requested level before a board can be returned. */
export function generatePuzzle(input: GenerationOptions): GeneratedPuzzle {
  const options = validateOptions(input);
  const { size, difficulty, seed } = options;
  const random = seededRandom(`${GENERATOR_VERSION}\0${size}\0${difficulty}\0${seed}`);
  let usedNodes = 0;
  for (let attempt = 0; attempt < MAX_LAYOUT_ATTEMPTS && usedNodes < MAX_TOTAL_NODES; attempt++) {
    const layout = createLayout(size, difficulty, random);
    const construction = solvePuzzle(layout, {
      limit: 1, maxNodes: Math.min(MAX_SOLUTION_NODES, MAX_TOTAL_NODES - usedNodes), random,
    });
    usedNodes += construction.nodes;
    if (!construction.solutions.length) continue;

    const solution = construction.solutions[0];
    const board = { ...layout, givens: [...solution] };
    let best: { givens: number[]; rating: DifficultyAnalysis } | null = null;
    const positions = shuffle(Array.from({ length: size ** 2 }, (_, index) => index), random);
    for (const index of positions) {
      if (usedNodes >= MAX_TOTAL_NODES) break;
      const clue = board.givens[index];
      board.givens[index] = 0;
      const uniqueness = solvePuzzle(board, {
        limit: 2, maxNodes: Math.min(MAX_UNIQUENESS_NODES, MAX_TOTAL_NODES - usedNodes),
      });
      usedNodes += uniqueness.nodes;
      if (uniqueness.count !== 1 || uniqueness.exhausted) {
        board.givens[index] = clue;
        continue;
      }
      const rating = analyzeDifficulty(board);
      if (!rating.solved || LEVEL[rating.difficulty] > LEVEL[difficulty]) {
        board.givens[index] = clue;
        continue;
      }
      if (rating.difficulty === difficulty) best = { givens: [...board.givens], rating };
    }

    // Avoid returning a nearly filled exercise just to satisfy a difficulty label.
    if (!best || best.givens.filter(value => !value).length < Math.ceil(size ** 2 * 0.55)) continue;
    const puzzle: GeneratedPuzzle = {
      id: getGeneratedPuzzleId(options),
      title: 'Fresh perspective',
      description: difficulty === 'Easy' ? 'A fresh grid for a gentle logic break.'
        : difficulty === 'Medium' ? 'Look for the number with only one home in a segment.'
        : 'Pencil in possibilities and follow the consequences.',
      size, difficulty: best.rating.difficulty,
      givens: best.givens, solution: [...solution],
      rightWalls: [...layout.rightWalls], bottomWalls: [...layout.bottomWalls],
      generation: { version: GENERATOR_VERSION, seed, requestedDifficulty: difficulty, rating: best.rating },
    };
    if (verifyPuzzle(puzzle).length) throw new Error('The generated board failed its integrity check. Try another seed.');
    return puzzle;
  }
  throw new Error(`Couldn’t find a ${difficulty.toLowerCase()} ${size} × ${size} puzzle within the search budget. Try a different seed.`);
}
