import type { Puzzle } from './engine';

export type ArrowKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown';

export function isArrowKey(key: string): key is ArrowKey {
  return key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown';
}

/** Wrap along the current row or column, stopping only on an editable cell. */
export function nextEditableCell(puzzle: Pick<Puzzle, 'size' | 'givens'>, selected: number, key: string): number {
  const { size, givens } = puzzle;
  if (!isArrowKey(key) || !Number.isInteger(size) || size < 1 || !Array.isArray(givens) ||
      givens.length !== size * size || !Number.isInteger(selected) || selected < 0 || selected >= givens.length) return selected;

  const row = Math.floor(selected / size), column = selected % size;
  const rowStep = key === 'ArrowUp' ? -1 : key === 'ArrowDown' ? 1 : 0;
  const columnStep = key === 'ArrowLeft' ? -1 : key === 'ArrowRight' ? 1 : 0;
  // A complete pass also handles a line with no editable cells without looping.
  for (let distance = 1; distance <= size; distance++) {
    const nextRow = (row + rowStep * distance + size) % size;
    const nextColumn = (column + columnStep * distance + size) % size;
    const next = nextRow * size + nextColumn;
    if (givens[next] === 0) return next;
  }
  return selected;
}
