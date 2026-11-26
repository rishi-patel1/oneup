import { isSolved } from '../game/engine';
import type { PublicPuzzle } from './model';

export interface BoardComparison {
  matching: Set<number>;
  differing: Set<number>;
  remaining: number;
}

/** Compare editable entries with the viewer's verified completed board, never an answer key. */
export function compareBoards(puzzle: PublicPuzzle, completed: readonly number[] | null | undefined, live: readonly number[]): BoardComparison | null {
  if (!puzzle || !Number.isInteger(puzzle.size) || puzzle.size < 5 || puzzle.size > 8) return null;
  const count = puzzle.size ** 2;
  if (!Array.isArray(puzzle.givens) || puzzle.givens.length !== count ||
      !Array.isArray(puzzle.rightWalls) || puzzle.rightWalls.length !== count ||
      !Array.isArray(puzzle.bottomWalls) || puzzle.bottomWalls.length !== count ||
      Array.from(puzzle.givens).some(value => !Number.isInteger(value) || value < 0 || value > puzzle.size) ||
      [...puzzle.rightWalls, ...puzzle.bottomWalls].some(value => typeof value !== 'boolean') ||
      !Array.isArray(completed) || completed.length !== count ||
      Array.from(completed).some(value => !Number.isInteger(value) || value < 1 || value > puzzle.size) ||
      !isSolved({ id: '', title: '', description: '', difficulty: 'Easy', size: puzzle.size,
        givens: puzzle.givens, rightWalls: puzzle.rightWalls, bottomWalls: puzzle.bottomWalls, solution: [] }, [...completed]) ||
      !Array.isArray(live) || live.length !== count ||
      Array.from(live).some((value, index) => !Number.isInteger(value) || value < 0 || value > puzzle.size ||
        (puzzle.givens[index] !== 0 && value !== puzzle.givens[index]))) return null;

  const matching = new Set<number>(), differing = new Set<number>();
  let remaining = 0;
  for (let index = 0; index < count; index++) {
    if (puzzle.givens[index]) continue;
    if (live[index] === 0) remaining++;
    else if (live[index] === completed[index]) matching.add(index);
    else differing.add(index);
  }
  return { matching, differing, remaining };
}
