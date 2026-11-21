import { getConflicts, type Difficulty, type Puzzle } from '../game/engine';

export type PublicPuzzle = Omit<Puzzle, 'solution'>;
export type RoomStatus = 'lobby' | 'racing' | 'finished';

export interface RoomPlayer {
  user_id: string;
  nickname: string;
  ready: boolean;
  progress_count: number;
  finished_at: string | null;
  elapsed_ms: number | null;
  joined_at: string;
}

export interface RoomState {
  room: {
    id: string;
    code: string;
    host_id: string;
    status: RoomStatus;
    size: 5 | 6 | 7 | 8;
    difficulty: Difficulty;
    starts_at: string | null;
    created_at: string;
  };
  players: RoomPlayer[];
  self: { values: number[]; notes: number[][] } | null;
  puzzle: PublicPuzzle | null;
  server_now: string;
}

/** Private target progress returned only by the server-authorized spectator RPC. */
export interface SpectatorState {
  room_id: string;
  player_id: string;
  values: number[];
  notes: number[][];
  updated_at: string;
  server_now: string;
}

export class CompetitionInputError extends Error {}
export class RoomDataError extends Error {
  constructor() { super('The room returned unexpected data. Try reconnecting.'); }
}

const levels: Difficulty[] = ['Easy', 'Medium', 'Hard'];
const sizes = [5, 6, 7, 8];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const secretKeys = ['solution', 'seed', 'generation'];

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && uuid.test(value);
}

export function normalizeRoomCode(value: string): string {
  const code = value.trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) throw new CompetitionInputError('Enter the six-character room code.');
  return code;
}

export function normalizeNickname(value: string): string {
  const nickname = value.trim().normalize('NFC').replace(/\s+/gu, ' ');
  const length = Array.from(nickname).length;
  if (length < 2 || length > 24 || /[\u0000-\u001f\u007f]/u.test(nickname)) {
    throw new CompetitionInputError('Choose a nickname between 2 and 24 characters.');
  }
  return nickname;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function ensure(condition: unknown): asserts condition {
  if (!condition) throw new RoomDataError();
}

function date(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function whole(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

/** Validate only the shape/domain here. Rule violations remain valid in-progress guesses. */
export function normalizeProgress(values: number[], notes: number[][]): { values: number[]; notes: number[][] } {
  if (!Array.isArray(values)) throw new CompetitionInputError('The saved grid is invalid. Reconnect to restore your progress.');
  const size = Math.sqrt(values.length);
  if (!sizes.includes(size) || !Array.isArray(notes) || notes.length !== values.length ||
    Array.from(values).some(value => !whole(value, 0, size)) || Array.from(notes).some((cell, index) =>
      !Array.isArray(cell) || cell.length > size || Array.from(cell).some(value => !whole(value, 1, size)) ||
      new Set(cell).size !== cell.length || (values[index] !== 0 && cell.length > 0))) {
    throw new CompetitionInputError('The saved grid is invalid. Reconnect to restore your progress.');
  }
  return { values: [...values], notes: notes.map(cell => [...cell].sort((a, b) => a - b)) };
}

/** This DTO stays separate from room polling so unfinished players never receive opponents' entries. */
export function parseSpectatorState(raw: unknown, playerId: string, puzzle: PublicPuzzle): SpectatorState {
  ensure(record(raw) && isUuid(playerId));
  const fields = ['room_id', 'player_id', 'values', 'notes', 'updated_at', 'server_now'];
  ensure(Object.keys(raw).every(key => fields.includes(key)) && !secretKeys.some(key => key in raw));
  ensure(isUuid(raw.room_id) && isUuid(raw.player_id) && raw.player_id.toLowerCase() === playerId.toLowerCase());
  ensure(date(raw.updated_at) && date(raw.server_now) && Date.parse(raw.updated_at) <= Date.parse(raw.server_now));
  ensure(record(puzzle) && !secretKeys.some(key => key in puzzle) && sizes.includes(puzzle.size));
  const count = puzzle.size * puzzle.size;
  ensure(Array.isArray(puzzle.givens) && puzzle.givens.length === count && Array.from(puzzle.givens).every(value => whole(value, 0, puzzle.size)));
  ensure(Array.isArray(raw.values) && Array.isArray(raw.notes));
  let progress: ReturnType<typeof normalizeProgress>;
  try { progress = normalizeProgress(raw.values, raw.notes); } catch { throw new RoomDataError(); }
  ensure(progress.values.length === count && puzzle.givens.every((given, index) => given === 0 || progress.values[index] === given));
  return {
    room_id: raw.room_id.toLowerCase(), player_id: raw.player_id.toLowerCase(),
    ...progress, updated_at: raw.updated_at, server_now: raw.server_now,
  };
}

/** Fail closed if a server response accidentally contains the hidden answer or seed. */
export function parseRoomState(raw: unknown): RoomState {
  ensure(record(raw) && record(raw.room) && Array.isArray(raw.players) && date(raw.server_now));
  const source = raw.room;
  ensure(isUuid(source.id) && isUuid(source.host_id) && typeof source.code === 'string');
  let code: string;
  try { code = normalizeRoomCode(source.code); } catch { throw new RoomDataError(); }
  ensure(source.code === code && sizes.includes(source.size as number) && levels.includes(source.difficulty as Difficulty));
  ensure(source.status === 'lobby' || source.status === 'racing' || source.status === 'finished');
  ensure(date(source.created_at) && (source.starts_at === null || date(source.starts_at)));
  ensure(source.status === 'lobby' ? source.starts_at === null : date(source.starts_at));
  const size = source.size as RoomState['room']['size'];
  const count = size * size;
  const players: RoomPlayer[] = [];
  ensure(raw.players.length >= 1 && raw.players.length <= 8);
  for (const candidate of raw.players) {
    ensure(record(candidate) && isUuid(candidate.user_id) && typeof candidate.nickname === 'string');
    ensure(!['values', 'notes', ...secretKeys].some(key => key in candidate));
    let nickname: string;
    try { nickname = normalizeNickname(candidate.nickname); } catch { throw new RoomDataError(); }
    ensure(nickname === candidate.nickname && !players.some(player => player.user_id === candidate.user_id));
    ensure(typeof candidate.ready === 'boolean' && whole(candidate.progress_count, 0, count) && date(candidate.joined_at));
    ensure((candidate.finished_at === null && candidate.elapsed_ms === null) ||
      (date(candidate.finished_at) && whole(candidate.elapsed_ms, 0, Number.MAX_SAFE_INTEGER)));
    players.push({
      user_id: candidate.user_id, nickname, ready: candidate.ready,
      progress_count: candidate.progress_count, finished_at: candidate.finished_at as string | null,
      elapsed_ms: candidate.elapsed_ms as number | null, joined_at: candidate.joined_at,
    });
  }
  ensure(players.some(player => player.user_id === source.host_id));
  const hasStarted = source.status !== 'lobby' && date(source.starts_at) && Date.parse(raw.server_now) >= Date.parse(source.starts_at);
  ensure(hasStarted || (raw.puzzle === null && raw.self === null));

  let puzzle: PublicPuzzle | null = null;
  if (raw.puzzle !== null) {
    const board = raw.puzzle;
    ensure(record(board) && !secretKeys.some(key => key in board));
    ensure(typeof board.id === 'string' && board.id.length > 0 && board.id.length <= 256 && !board.id.startsWith('generated-v'));
    ensure(typeof board.title === 'string' && board.title.length > 0 && board.title.length <= 80);
    ensure(typeof board.description === 'string' && board.description.length <= 300);
    ensure(board.size === size && board.difficulty === source.difficulty);
    ensure(Array.isArray(board.givens) && board.givens.length === count && Array.from(board.givens).every(value => whole(value, 0, size)));
    ensure(Array.isArray(board.rightWalls) && board.rightWalls.length === count && Array.from(board.rightWalls).every(value => typeof value === 'boolean'));
    ensure(Array.isArray(board.bottomWalls) && board.bottomWalls.length === count && Array.from(board.bottomWalls).every(value => typeof value === 'boolean'));
    puzzle = {
      id: board.id, title: board.title, description: board.description, size,
      difficulty: source.difficulty as Difficulty, givens: [...board.givens] as number[],
      rightWalls: [...board.rightWalls] as boolean[], bottomWalls: [...board.bottomWalls] as boolean[],
    };
    ensure(getConflicts({ ...puzzle, solution: [] }, puzzle.givens).size === 0);
  }

  let self: RoomState['self'] = null;
  if (raw.self !== null) {
    ensure(puzzle && record(raw.self) && Array.isArray(raw.self.values) && Array.isArray(raw.self.notes));
    try { self = normalizeProgress(raw.self.values, raw.self.notes); } catch { throw new RoomDataError(); }
    ensure(self.values.length === count && puzzle.givens.every((value, index) => value === 0 || self!.values[index] === value));
  }
  return {
    room: {
      id: source.id, code, host_id: source.host_id, status: source.status, size,
      difficulty: source.difficulty as Difficulty, starts_at: source.starts_at as string | null,
      created_at: source.created_at,
    },
    players, puzzle, self, server_now: raw.server_now,
  };
}
