import { isSolved, type Puzzle } from './engine';

export interface Snapshot {
  values: number[];
  notes: number[][];
}

export interface Session extends Snapshot {
  puzzleId: string;
  history: Snapshot[];
  future: Snapshot[];
  elapsedMs: number;
  status: 'playing' | 'paused' | 'completed';
  hintsUsed: number;
  checksUsed: number;
}

export type SessionAction =
  | { type: 'set-value'; index: number; value: number; puzzle: Puzzle }
  | { type: 'toggle-note'; index: number; value: number; puzzle: Puzzle }
  | { type: 'clear-cell'; index: number; puzzle: Puzzle }
  | { type: 'hint'; index: number; puzzle: Puzzle }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'tick'; deltaMs: number }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'complete' }
  | { type: 'check' }
  | { type: 'reset'; puzzle: Puzzle };

const HISTORY_LIMIT = 100;

function snapshot(state: Snapshot): Snapshot {
  return { values: [...state.values], notes: state.notes.map((notes) => [...notes]) };
}

export function createSession(puzzle: Puzzle): Session {
  return {
    puzzleId: puzzle.id,
    values: [...puzzle.givens],
    notes: Array.from({ length: puzzle.size * puzzle.size }, () => []),
    history: [],
    future: [],
    elapsedMs: 0,
    status: 'playing',
    hintsUsed: 0,
    checksUsed: 0,
  };
}

function canEdit(state: Session, puzzle: Puzzle, index: number): boolean {
  return (
    state.status === 'playing' &&
    state.puzzleId === puzzle.id &&
    Number.isInteger(index) &&
    index >= 0 &&
    index < state.values.length &&
    puzzle.givens[index] === 0
  );
}

function changed(state: Session, next: Snapshot): Session {
  return {
    ...state,
    ...next,
    history: [...state.history, snapshot(state)].slice(-HISTORY_LIMIT),
    future: [],
  };
}

/** All edits are immutable and one undo step; assistance counts cannot be undone. */
export function sessionReducer(state: Session, action: SessionAction): Session {
  switch (action.type) {
    case 'reset':
      return createSession(action.puzzle);
    case 'pause':
      return state.status === 'playing' ? { ...state, status: 'paused' } : state;
    case 'resume':
      return state.status === 'paused' ? { ...state, status: 'playing' } : state;
    case 'complete':
      return state.status === 'playing' ? { ...state, status: 'completed' } : state;
    case 'tick':
      if (state.status !== 'playing' || !Number.isFinite(action.deltaMs) || action.deltaMs <= 0) return state;
      return { ...state, elapsedMs: Math.min(Number.MAX_SAFE_INTEGER, state.elapsedMs + action.deltaMs) };
    case 'check':
      return state.status === 'playing' ? { ...state, checksUsed: state.checksUsed + 1 } : state;
    case 'undo': {
      if (state.status !== 'playing' || state.history.length === 0) return state;
      const previous = state.history[state.history.length - 1];
      return {
        ...state,
        ...snapshot(previous),
        history: state.history.slice(0, -1),
        future: [...state.future, snapshot(state)].slice(-HISTORY_LIMIT),
      };
    }
    case 'redo': {
      if (state.status !== 'playing' || state.future.length === 0) return state;
      const next = state.future[state.future.length - 1];
      return {
        ...state,
        ...snapshot(next),
        history: [...state.history, snapshot(state)].slice(-HISTORY_LIMIT),
        future: state.future.slice(0, -1),
      };
    }
    case 'set-value': {
      if (!canEdit(state, action.puzzle, action.index)) return state;
      if (!Number.isInteger(action.value) || action.value < 0 || action.value > action.puzzle.size) return state;
      if (state.values[action.index] === action.value && state.notes[action.index].length === 0) return state;
      const next = snapshot(state);
      next.values[action.index] = action.value;
      next.notes[action.index] = [];
      return changed(state, next);
    }
    case 'toggle-note': {
      if (!canEdit(state, action.puzzle, action.index)) return state;
      if (!Number.isInteger(action.value) || action.value < 1 || action.value > action.puzzle.size) return state;
      const next = snapshot(state);
      const notes = next.notes[action.index];
      next.values[action.index] = 0;
      next.notes[action.index] = notes.includes(action.value)
        ? notes.filter((value) => value !== action.value)
        : [...notes, action.value].sort((a, b) => a - b);
      return changed(state, next);
    }
    case 'clear-cell': {
      if (!canEdit(state, action.puzzle, action.index)) return state;
      if (state.values[action.index] === 0 && state.notes[action.index].length === 0) return state;
      const next = snapshot(state);
      next.values[action.index] = 0;
      next.notes[action.index] = [];
      return changed(state, next);
    }
    case 'hint': {
      if (!canEdit(state, action.puzzle, action.index)) return state;
      const value = action.puzzle.solution[action.index];
      if (state.values[action.index] === value) return state;
      const next = snapshot(state);
      next.values[action.index] = value;
      next.notes[action.index] = [];
      return { ...changed(state, next), hintsUsed: state.hintsUsed + 1 };
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function readSnapshot(puzzle: Puzzle, raw: unknown): Snapshot | null {
  if (!isRecord(raw)) return null;
  const { values, notes } = raw;
  const length = puzzle.size * puzzle.size;
  if (!Array.isArray(values) || values.length !== length || !Array.isArray(notes) || notes.length !== length) return null;
  for (let index = 0; index < length; index += 1) {
    const value: unknown = values[index];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > puzzle.size) return null;
    if (puzzle.givens[index] !== 0 && value !== puzzle.givens[index]) return null;
    const cellNotes: unknown = notes[index];
    if (!Array.isArray(cellNotes) || cellNotes.length > puzzle.size) return null;
    if (value !== 0 && cellNotes.length !== 0) return null;
    for (const note of cellNotes) {
      if (typeof note !== 'number' || !Number.isInteger(note) || note < 1 || note > puzzle.size) return null;
    }
    if (new Set(cellNotes).size !== cellNotes.length) return null;
  }
  return { values: [...values] as number[], notes: notes.map((cellNotes: number[]) => [...cellNotes].sort((a, b) => a - b)) };
}

/** Reject stale, corrupted or oversized saves rather than restoring an unsafe board. */
export function restoreSession(puzzle: Puzzle, raw: unknown): Session | null {
  if (!isRecord(raw) || raw.puzzleId !== puzzle.id || (raw.version !== undefined && raw.version !== 1)) return null;
  const current = readSnapshot(puzzle, raw);
  if (!current || !Array.isArray(raw.history) || raw.history.length > HISTORY_LIMIT || !Array.isArray(raw.future) || raw.future.length > HISTORY_LIMIT) return null;
  if (typeof raw.elapsedMs !== 'number' || !Number.isFinite(raw.elapsedMs) || raw.elapsedMs < 0 || raw.elapsedMs > Number.MAX_SAFE_INTEGER) return null;
  if (!isCount(raw.hintsUsed) || !isCount(raw.checksUsed)) return null;
  if (raw.status !== 'playing' && raw.status !== 'paused' && raw.status !== 'completed') return null;
  if (raw.status === 'completed' && !isSolved(puzzle, current.values)) return null;
  const history = raw.history.map((entry: unknown) => readSnapshot(puzzle, entry));
  const future = raw.future.map((entry: unknown) => readSnapshot(puzzle, entry));
  if (history.includes(null) || future.includes(null)) return null;
  return {
    ...current,
    puzzleId: puzzle.id,
    history: history as Snapshot[],
    future: future as Snapshot[],
    elapsedMs: raw.elapsedMs,
    status: raw.status,
    hintsUsed: raw.hintsUsed,
    checksUsed: raw.checksUsed,
  };
}

export function serializeSession(session: Session): object {
  return {
    version: 1,
    ...session,
    ...snapshot(session),
    history: session.history.slice(-HISTORY_LIMIT).map(snapshot),
    future: session.future.slice(-HISTORY_LIMIT).map(snapshot),
  };
}
