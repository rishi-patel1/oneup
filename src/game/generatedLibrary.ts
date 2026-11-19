import { verifyPuzzle, type Difficulty } from './engine';
import { GENERATOR_VERSION, getGeneratedPuzzleId, normalizeSeed, type GeneratedPuzzle, type GenerationOptions } from './generator';
import { LEGACY_PUZZLE_CODE_PREFIX, PUZZLE_CODE_PREFIX } from '../branding';

export const RECENT_PUZZLE_LIMIT = 12;
const DIFFICULTIES: Difficulty[] = ['Easy', 'Medium', 'Hard'];

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Restore only intact boards created by the supported generator version. */
export function readGeneratedPuzzles(raw: unknown): GeneratedPuzzle[] {
  if (!Array.isArray(raw)) return [];
  const result: GeneratedPuzzle[] = [];
  for (const value of raw.slice(0, RECENT_PUZZLE_LIMIT)) {
    if (!record(value) || !record(value.generation)) continue;
    const generation = value.generation;
    if (generation.version !== GENERATOR_VERSION || typeof generation.seed !== 'string' ||
      !DIFFICULTIES.includes(generation.requestedDifficulty as Difficulty) ||
      ![5, 6, 7, 8].includes(value.size as number) || typeof value.title !== 'string' || value.title.length > 80 ||
      typeof value.description !== 'string' || value.description.length > 300 ||
      !record(generation.rating) || generation.rating.difficulty !== value.difficulty || generation.rating.solved !== true) continue;
    if (['nakedSingles', 'hiddenSingles', 'nakedPairs', 'guesses', 'maxGuessDepth', 'score'].some(
      key => typeof generation.rating !== 'object' || !Number.isSafeInteger((generation.rating as Record<string, unknown>)[key]) ||
        Number((generation.rating as Record<string, unknown>)[key]) < 0,
    )) continue;
    try {
      const options: GenerationOptions = { size: value.size as GenerationOptions['size'], difficulty: generation.requestedDifficulty as Difficulty, seed: generation.seed };
      if (value.id !== getGeneratedPuzzleId(options) || normalizeSeed(generation.seed) !== generation.seed ||
        value.difficulty !== options.difficulty) continue;
      const puzzle = value as unknown as GeneratedPuzzle;
      if (verifyPuzzle(puzzle).length || result.some(p => p.id === puzzle.id)) continue;
      result.push(puzzle);
    } catch { /* An invalid cached board must not prevent the game from opening. */ }
  }
  return result;
}

export function addGeneratedPuzzle(puzzles: GeneratedPuzzle[], puzzle: GeneratedPuzzle): GeneratedPuzzle[] {
  return [puzzle, ...puzzles.filter(item => item.id !== puzzle.id)].slice(0, RECENT_PUZZLE_LIMIT);
}

/** Expire old generated sessions as well as their definitions, keeping the cache bounded. */
export function persistGeneratedLibrary(storage: Pick<Storage, 'setItem' | 'removeItem'>, puzzles: GeneratedPuzzle[], previousIds: string[], prefix: string): boolean {
  try {
    const kept = new Set(puzzles.map(puzzle => puzzle.id));
    for (const id of previousIds) {
      if (id.startsWith('generated-v') && !kept.has(id)) storage.removeItem(`${prefix}puzzle:${id}`);
    }
    storage.setItem(`${prefix}generated`, JSON.stringify(puzzles));
    return true;
  } catch { return false; }
}

export function formatPuzzleCode(puzzle: GeneratedPuzzle): string {
  return `${PUZZLE_CODE_PREFIX}:${puzzle.generation.version}:${puzzle.size}:${puzzle.difficulty.toLowerCase()}:${encodeURIComponent(puzzle.generation.seed)}`;
}

export function isPuzzleCode(text: string): boolean {
  return [PUZZLE_CODE_PREFIX, LEGACY_PUZZLE_CODE_PREFIX].includes(text.trim().split(':')[0].toLowerCase()) && text.includes(':');
}

export function parsePuzzleCode(text: string): GenerationOptions | null {
  const match = /^[^:]+:([^:]+):([5-8]):(easy|medium|hard):(.+)$/i.exec(text.trim());
  if (!match || !isPuzzleCode(text) || match[1] !== GENERATOR_VERSION) return null;
  try {
    const difficulty = DIFFICULTIES.find(level => level.toLowerCase() === match[3].toLowerCase())!;
    return { size: Number(match[2]) as GenerationOptions['size'], difficulty, seed: normalizeSeed(decodeURIComponent(match[4])) };
  } catch { return null; }
}

export function randomSeed(): string {
  const words = crypto.getRandomValues(new Uint32Array(2));
  return `${words[0].toString(36)}-${words[1].toString(36)}`;
}
