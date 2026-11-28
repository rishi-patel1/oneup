import assert from 'node:assert/strict';
import test from 'node:test';
import { isArrowKey, nextEditableCell } from './board-navigation';

function board(size = 5) { return { size, givens: Array<number>(size * size).fill(0) }; }

test('all four arrows wrap to the opposite edge on every supported board size', () => {
  for (const size of [5, 6, 7, 8]) {
    const puzzle = board(size);
    assert.equal(nextEditableCell(puzzle, size * 2, 'ArrowLeft'), size * 2 + size - 1);
    assert.equal(nextEditableCell(puzzle, size * 2 + size - 1, 'ArrowRight'), size * 2);
    assert.equal(nextEditableCell(puzzle, 2, 'ArrowUp'), size * (size - 1) + 2);
    assert.equal(nextEditableCell(puzzle, size * (size - 1) + 2, 'ArrowDown'), 2);
  }
});

test('horizontal movement skips consecutive clues, including clues beyond the wrapped edge', () => {
  const puzzle = board();
  puzzle.givens.splice(10, 5, 1, 2, 0, 0, 3);
  assert.equal(nextEditableCell(puzzle, 13, 'ArrowRight'), 12);
  assert.equal(nextEditableCell(puzzle, 12, 'ArrowLeft'), 13);
  assert.equal(nextEditableCell(puzzle, 10, 'ArrowRight'), 12); // A clicked clue can be the starting cell.
  assert.equal(nextEditableCell(puzzle, 14, 'ArrowLeft'), 13);
});

test('vertical movement skips consecutive clues across top and bottom without changing columns', () => {
  const puzzle = board();
  for (const index of [3, 8, 23]) puzzle.givens[index] = 1;
  assert.equal(nextEditableCell(puzzle, 18, 'ArrowDown'), 13);
  assert.equal(nextEditableCell(puzzle, 13, 'ArrowUp'), 18);
  assert.equal(nextEditableCell(puzzle, 3, 'ArrowDown'), 13);
  assert.equal(nextEditableCell(puzzle, 23, 'ArrowUp'), 18);
});

test('one editable cell stays selected and fully fixed lines terminate without changing selection', () => {
  const puzzle = { size: 5, givens: Array<number>(25).fill(1) };
  for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
    assert.equal(nextEditableCell(puzzle, 12, key), 12);
  }
  puzzle.givens[12] = 0;
  for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
    assert.equal(nextEditableCell(puzzle, 12, key), 12);
  }
  assert.equal(nextEditableCell(puzzle, 10, 'ArrowRight'), 12);
  assert.equal(nextEditableCell(puzzle, 2, 'ArrowDown'), 12);
});

test('only fixed clues are skipped, with no reads of player entries or mutations', () => {
  const puzzle = board(), before = [...puzzle.givens];
  Object.defineProperty(puzzle, 'values', { get() { throw new Error('Player entries are not navigation clues'); } });
  Object.freeze(puzzle.givens); Object.freeze(puzzle);
  assert.equal(nextEditableCell(puzzle, 11, 'ArrowRight'), 12);
  assert.equal(nextEditableCell(puzzle, 11, 'ArrowLeft'), 10);
  assert.deepEqual(puzzle.givens, before);
});

test('other keys and invalid geometry or selection leave selection alone', () => {
  const puzzle = board();
  for (const key of ['Enter', 'Home', 'ArrowDiagonal', 'arrowleft', 'a', '']) {
    assert.equal(isArrowKey(key), false);
    assert.equal(nextEditableCell(puzzle, 12, key), 12);
  }
  for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) assert.equal(isArrowKey(key), true);
  for (const selected of [-1, 25, 1.5, NaN]) assert.equal(nextEditableCell(puzzle, selected, 'ArrowRight'), selected);
  for (const invalid of [{ size: 0, givens: [] }, { size: 1.5, givens: [] }, { size: NaN, givens: [] }, { size: 5, givens: [] }]) {
    assert.equal(nextEditableCell(invalid, 12, 'ArrowRight'), 12);
  }
});
