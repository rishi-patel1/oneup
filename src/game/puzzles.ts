import type { Puzzle } from './engine';

/** Original starter puzzles, generated locally and checked for a unique solution.
 * No boards or solutions were copied from the reference game.
 * Wall indices mark the cell before an internal right/bottom wall. */
function walls(size: number, indices: number[]): boolean[] {
  const positions = new Set(indices);
  return Array.from({ length: size * size }, (_, index) => positions.has(index));
}

export const PUZZLES: Puzzle[] = [
  {
    id: 'first-light', title: 'First light', size: 5, difficulty: 'Easy',
    description: 'A gentle introduction. Find the short runs first.',
    givens: [
      2, 4, 0, 0, 5,
      0, 0, 0, 0, 0,
      3, 0, 0, 0, 2,
      0, 0, 0, 1, 0,
      0, 1, 0, 0, 4,
    ],
    solution: [
      2, 4, 1, 3, 5,
      1, 2, 1, 2, 3,
      3, 5, 1, 4, 2,
      1, 3, 2, 1, 1,
      2, 1, 3, 5, 4,
    ],
    rightWalls: walls(5, [6, 15, 18]),
    bottomWalls: walls(5, [2, 5, 7]),
  },
  {
    id: 'crossroads', title: 'Crossroads', size: 5, difficulty: 'Easy',
    description: 'A few clues. Plenty of small discoveries.',
    givens: [
      0, 0, 0, 1, 0,
      0, 0, 0, 0, 0,
      3, 0, 0, 0, 0,
      0, 0, 0, 0, 0,
      0, 0, 1, 0, 0,
    ],
    solution: [
      2, 1, 3, 1, 2,
      1, 2, 1, 2, 3,
      3, 1, 4, 2, 1,
      4, 3, 2, 1, 1,
      5, 4, 1, 3, 2,
    ],
    rightWalls: walls(5, [2, 6, 13, 18]),
    bottomWalls: walls(5, [1, 8, 14, 17]),
  },
  {
    id: 'a-new-angle', title: 'A new angle', size: 6, difficulty: 'Medium',
    description: 'Follow the walls and let the pieces connect.',
    givens: [
      1, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0,
      0, 0, 3, 1, 0, 0,
      0, 3, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0,
    ],
    solution: [
      1, 4, 2, 5, 3, 1,
      3, 2, 1, 2, 1, 3,
      2, 1, 3, 1, 4, 2,
      1, 3, 5, 4, 2, 1,
      2, 1, 4, 6, 5, 3,
      3, 2, 1, 3, 1, 2,
    ],
    rightWalls: walls(6, [4, 8, 13, 18, 32]),
    bottomWalls: walls(6, [12, 17, 19, 26, 28]),
  },
  {
    id: 'in-the-balance', title: 'In the balance', size: 6, difficulty: 'Medium',
    description: 'Slow down. Every intersection tells a story.',
    givens: [
      0, 0, 0, 0, 2, 0,
      0, 1, 0, 0, 4, 0,
      0, 0, 0, 0, 0, 0,
      0, 0, 2, 0, 0, 0,
      0, 0, 0, 3, 0, 0,
      0, 0, 0, 0, 0, 0,
    ],
    solution: [
      3, 2, 4, 1, 2, 1,
      1, 1, 5, 2, 4, 3,
      2, 1, 1, 2, 3, 4,
      4, 3, 2, 1, 1, 2,
      2, 4, 6, 3, 5, 1,
      1, 2, 3, 4, 1, 2,
    ],
    rightWalls: walls(6, [3, 6, 13, 21, 33]),
    bottomWalls: walls(6, [7, 9, 18, 23, 28]),
  },
  {
    id: 'hidden-order', title: 'Hidden order', size: 7, difficulty: 'Hard',
    description: 'Look a little closer. The logic is there.',
    givens: [
      0, 0, 0, 0, 0, 0, 0,
      0, 0, 5, 0, 0, 0, 1,
      0, 3, 0, 6, 0, 0, 0,
      0, 0, 0, 0, 4, 0, 0,
      0, 2, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 1, 0,
      0, 0, 0, 0, 0, 0, 2,
    ],
    solution: [
      3, 2, 1, 4, 1, 3, 2,
      2, 1, 5, 2, 3, 4, 1,
      1, 3, 4, 6, 2, 5, 1,
      2, 1, 3, 1, 4, 2, 3,
      3, 2, 7, 5, 1, 6, 4,
      4, 3, 6, 7, 2, 1, 5,
      1, 4, 2, 3, 3, 1, 2,
    ],
    rightWalls: walls(7, [2, 8, 19, 23, 45]),
    bottomWalls: walls(7, [13, 14, 15, 18, 40]),
  },
  {
    id: 'the-long-game', title: 'The long game', size: 8, difficulty: 'Hard',
    description: 'A bigger board for a deeper kind of focus.',
    givens: [
      3, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 4, 0, 0, 0, 0,
      0, 2, 0, 0, 0, 0, 8, 0,
      0, 0, 0, 0, 0, 1, 0, 3,
      0, 0, 0, 6, 0, 3, 0, 0,
      0, 0, 3, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 5, 0,
    ],
    solution: [
      3, 1, 2, 5, 3, 1, 4, 2,
      2, 4, 3, 8, 5, 7, 6, 1,
      1, 3, 5, 4, 2, 2, 1, 3,
      3, 2, 4, 7, 6, 5, 8, 1,
      5, 3, 1, 2, 4, 1, 2, 3,
      1, 4, 2, 6, 1, 3, 7, 5,
      4, 2, 3, 1, 1, 4, 3, 2,
      2, 1, 1, 3, 2, 6, 5, 4,
    ],
    rightWalls: walls(8, [2, 20, 36, 40, 51, 57]),
    bottomWalls: walls(8, [5, 16, 23, 25, 34, 44]),
  },
];
