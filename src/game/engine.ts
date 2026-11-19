/** One Up rules: every wall-delimited run is a permutation of 1..run.length. */
export type Difficulty = 'Easy' | 'Medium' | 'Hard';

export interface Puzzle {
  id: string;
  title: string;
  size: number;
  difficulty: Difficulty;
  description: string;
  /** 0 marks an empty cell. All cell arrays are row-major. */
  givens: number[];
  solution: number[];
  /** A true value adds a wall to the right/bottom of that cell. */
  rightWalls: boolean[];
  bottomWalls: boolean[];
}

export interface Segments {
  rows: number[][];
  columns: number[][];
}

export function getSegments(puzzle: Puzzle): Segments {
  const { size, rightWalls, bottomWalls } = puzzle;
  const rows: number[][] = [];
  const columns: number[][] = [];
  for (let row = 0; row < size; row++) {
    let run: number[] = [];
    for (let column = 0; column < size; column++) {
      const cell = row * size + column;
      run.push(cell);
      if (column === size - 1 || rightWalls[cell]) {
        rows.push(run);
        run = [];
      }
    }
  }
  for (let column = 0; column < size; column++) {
    let run: number[] = [];
    for (let row = 0; row < size; row++) {
      const cell = row * size + column;
      run.push(cell);
      if (row === size - 1 || bottomWalls[cell]) {
        columns.push(run);
        run = [];
      }
    }
  }
  return { rows, columns };
}

function cellSegments(puzzle: Puzzle, index: number): number[][] {
  const { rows, columns } = getSegments(puzzle);
  return [...rows, ...columns].filter((run) => run.includes(index));
}

export function getCellLimit(puzzle: Puzzle, index: number): number {
  if (!Number.isInteger(index) || index < 0 || index >= puzzle.size ** 2) return 0;
  return Math.min(...cellSegments(puzzle, index).map((run) => run.length));
}

/** Rule conflicts only: an incorrect guess can still be a legal partial move. */
export function getConflicts(puzzle: Puzzle, values: number[]): Set<number> {
  const conflicts = new Set<number>();
  const { rows, columns } = getSegments(puzzle);
  for (const run of [...rows, ...columns]) {
    const seen = new Map<number, number[]>();
    for (const index of run) {
      const value = values[index] ?? 0;
      if (value === 0) continue;
      if (!Number.isInteger(value) || value < 1 || value > run.length) {
        conflicts.add(index);
      }
      const matches = seen.get(value) ?? [];
      matches.push(index);
      seen.set(value, matches);
    }
    for (const duplicates of seen.values()) {
      if (duplicates.length > 1) duplicates.forEach((index) => conflicts.add(index));
    }
  }
  return conflicts;
}

export function getMistakes(puzzle: Puzzle, values: number[]): Set<number> {
  return new Set(
    puzzle.solution.flatMap((answer, index) => {
      const value = values[index] ?? 0;
      return value !== 0 && value !== answer ? [index] : [];
    }),
  );
}

export function isSolved(puzzle: Puzzle, values: number[]): boolean {
  if (values.length !== puzzle.size ** 2) return false;
  for (const value of values) {
    if (!Number.isInteger(value) || value <= 0) return false;
  }
  if (puzzle.givens.some((given, index) => given !== 0 && values[index] !== given)) return false;
  return getConflicts(puzzle, values).size === 0;
}

/** Legal notes for this cell, considering both runs and ignoring its current value. */
export function getCandidates(puzzle: Puzzle, values: number[], index: number): number[] {
  const limit = getCellLimit(puzzle, index);
  if (limit === 0) return [];
  const used = new Set<number>();
  for (const run of cellSegments(puzzle, index)) {
    for (const other of run) if (other !== index && values[other]) used.add(values[other]);
  }
  return Array.from({ length: limit }, (_, position) => position + 1).filter(
    (value) => !used.has(value),
  );
}

/** Authoring integrity check; uniqueness is checked separately by the library tests. */
export function verifyPuzzle(puzzle: Puzzle): string[] {
  const errors: string[] = [];
  if (!Number.isInteger(puzzle.size) || puzzle.size < 1 || puzzle.size > 9) {
    return ['Board size must be an integer from 1 to 9.'];
  }
  const count = puzzle.size ** 2;
  for (const field of ['givens', 'solution', 'rightWalls', 'bottomWalls'] as const) {
    if (!Array.isArray(puzzle[field]) || puzzle[field].length !== count) {
      errors.push(`${field} must contain exactly ${count} cells.`);
    }
  }
  if (errors.length) return errors;
  if (Array.from(puzzle.rightWalls).some((wall) => typeof wall !== 'boolean') ||
      Array.from(puzzle.bottomWalls).some((wall) => typeof wall !== 'boolean')) {
    errors.push('Wall arrays must contain booleans.');
  }
  if (Array.from(puzzle.solution).some((value) => !Number.isInteger(value) || value < 1 || value > puzzle.size)) {
    errors.push('Solution must contain a valid number in every cell.');
  }
  if (getConflicts(puzzle, puzzle.solution).size) errors.push('Stored solution violates a run.');
  if (Array.from(puzzle.givens).some((value, index) => !Number.isInteger(value) || value < 0 ||
      (value !== 0 && value !== puzzle.solution[index]))) {
    errors.push('Clues must be zero or match the stored solution.');
  }
  return errors;
}
