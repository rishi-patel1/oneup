import { getConflicts } from '../game/engine';
import { isUuid, normalizeProgress, type PublicPuzzle } from '../multiplayer/model';

export interface Profile { id: string; display_name: string; friend_code: string }
export interface DailyAttempt {
  id: string; started_at: string; finished_at: string | null; elapsed_ms: number | null;
  ranked: boolean; values: number[]; notes: number[][];
  paused_at: string | null; paused_ms: number; timing_version: number;
}
export interface DailyState {
  date: string; resets_at: string; server_now: string;
  daily: { id: string; date: string; size: 6; difficulty: 'Medium' } | null;
  puzzle: PublicPuzzle | null; attempt: DailyAttempt | null; profile: Profile | null;
}

export function getDailyElapsed(attempt: DailyAttempt, serverNow: number): number {
  const clock = attempt.paused_at ? Math.min(serverNow, Date.parse(attempt.paused_at)) : serverNow;
  return attempt.elapsed_ms ?? Math.max(0, clock - Date.parse(attempt.started_at) - attempt.paused_ms);
}

/** A late poll must not undo a pause, resume, or confirmed finish. */
export function isCurrentDailySnapshot(previous: DailyState | null, next: DailyState, lastServerTime: number): boolean {
  if (!previous) return true;
  if (next.date < previous.date || (next.date === previous.date && Date.parse(next.server_now) < lastServerTime)) return false;
  if (previous.attempt && next.attempt?.id === previous.attempt.id) {
    if (next.attempt.timing_version < previous.attempt.timing_version) return false;
    if (previous.attempt.finished_at && !next.attempt.finished_at) return false;
  }
  return true;
}
export interface DailyStreaks {
  date: string; current: number; max: number;
  completed_today: boolean; last_completed_date: string | null;
}
export type LeaderboardScope = 'global' | 'friends';
export interface LeaderboardEntry {
  rank: number; user_id: string; display_name: string; friend_code: string; elapsed_ms: number;
}
export interface DailyLeaderboard {
  date: string; scope: LeaderboardScope; entries: LeaderboardEntry[];
  self: LeaderboardEntry | null; total: number;
}
export interface Friend { user_id: string; display_name: string; friend_code: string }
export interface FriendRequest extends Friend { id: string }
export interface FriendsState { profile: Profile; friends: Friend[]; incoming: FriendRequest[]; outgoing: FriendRequest[] }

export class DailyInputError extends Error {}
export class DailyDataError extends Error {
  constructor() { super('The daily challenge returned unexpected data. Try refreshing.'); }
}
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
function ensure(value: unknown): asserts value { if (!value) throw new DailyDataError(); }
function object(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  ensure(record(value) && Object.keys(value).every(key => keys.includes(key)));
}
const integer = (value: unknown, min = 0): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min;
const timestamp = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));

export function normalizeDailyDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new DailyInputError('Choose a valid daily challenge date.');
  }
  return value;
}
export function normalizeFriendCode(value: string): string {
  const code = value.trim().toUpperCase();
  if (!/^[A-F0-9]{10}$/.test(code)) throw new DailyInputError('Enter the ten-character friend code.');
  return code;
}
export function normalizeDisplayName(value: string): string {
  const name = value.trim().normalize('NFC').replace(/\s+/gu, ' ');
  if (Array.from(name).length < 2 || Array.from(name).length > 24 || /[\u0000-\u001f\u007f]/u.test(name)) throw new DailyInputError('Choose a display name between 2 and 24 characters.');
  return name;
}
function canonicalName(raw: unknown): string {
  ensure(typeof raw === 'string');
  // Postgres accepts Unicode names without NFC-normalizing them; preserve valid server text.
  ensure(Array.from(raw).length >= 2 && Array.from(raw).length <= 24 && !/[\u0000-\u001f\u007f]/u.test(raw) && raw.trim().replace(/\s+/gu, ' ') === raw);
  return raw;
}
function canonicalCode(raw: unknown): string {
  ensure(typeof raw === 'string');
  try { ensure(normalizeFriendCode(raw) === raw); } catch { throw new DailyDataError(); }
  return raw;
}
function day(raw: unknown): string {
  ensure(typeof raw === 'string');
  try { return normalizeDailyDate(raw); } catch { throw new DailyDataError(); }
}
export function parseProfile(raw: unknown): Profile {
  object(raw, ['id', 'display_name', 'friend_code']); ensure(isUuid(raw.id));
  return { id: raw.id, display_name: canonicalName(raw.display_name), friend_code: canonicalCode(raw.friend_code) };
}
function parsePuzzle(raw: unknown, id: string): PublicPuzzle {
  object(raw, ['id', 'title', 'description', 'size', 'difficulty', 'givens', 'rightWalls', 'bottomWalls']);
  ensure(raw.id === `daily-${id}` && raw.size === 6 && raw.difficulty === 'Medium');
  ensure(typeof raw.title === 'string' && raw.title.length > 0 && raw.title.length <= 80 && typeof raw.description === 'string' && raw.description.length <= 300);
  ensure(Array.isArray(raw.givens) && raw.givens.length === 36 && Array.from(raw.givens).every(value => integer(value) && value <= 6));
  ensure(Array.isArray(raw.rightWalls) && raw.rightWalls.length === 36 && Array.from(raw.rightWalls).every(value => typeof value === 'boolean'));
  ensure(Array.isArray(raw.bottomWalls) && raw.bottomWalls.length === 36 && Array.from(raw.bottomWalls).every(value => typeof value === 'boolean'));
  const puzzle: PublicPuzzle = { id: raw.id, title: raw.title, description: raw.description, size: 6, difficulty: 'Medium', givens: [...raw.givens], rightWalls: [...raw.rightWalls], bottomWalls: [...raw.bottomWalls] };
  ensure(getConflicts({ ...puzzle, solution: [] }, puzzle.givens).size === 0);
  return puzzle;
}
export function parseDailyState(raw: unknown): DailyState {
  object(raw, ['date', 'resets_at', 'server_now', 'daily', 'puzzle', 'attempt', 'profile']);
  const date = day(raw.date); ensure(timestamp(raw.server_now) && timestamp(raw.resets_at));
  const server = Date.parse(raw.server_now), reset = Date.parse(raw.resets_at);
  const midnight = Date.parse(`${date}T00:00:00Z`);
  ensure(server >= midnight && server < midnight + 86_400_000 && reset === midnight + 86_400_000);
  const profile = raw.profile === null ? null : parseProfile(raw.profile);
  let daily: DailyState['daily'] = null;
  if (raw.daily !== null) {
    object(raw.daily, ['id', 'date', 'size', 'difficulty']);
    ensure(isUuid(raw.daily.id) && raw.daily.date === date && raw.daily.size === 6 && raw.daily.difficulty === 'Medium');
    daily = { id: raw.daily.id, date, size: 6, difficulty: 'Medium' };
  }
  let puzzle: PublicPuzzle | null = null, attempt: DailyAttempt | null = null;
  if (raw.attempt !== null) {
    ensure(daily); puzzle = parsePuzzle(raw.puzzle, daily.id);
    const source = raw.attempt;
    object(source, ['id', 'started_at', 'finished_at', 'elapsed_ms', 'ranked', 'values', 'notes', 'paused_at', 'paused_ms', 'timing_version']);
    ensure(isUuid(source.id) && timestamp(source.started_at) && typeof source.ranked === 'boolean');
    const started = Date.parse(source.started_at); ensure(started >= midnight && started <= server);
    const hasTiming = ['paused_at', 'paused_ms', 'timing_version'].some(key => key in source);
    const pausedAt = hasTiming ? source.paused_at : null;
    const pausedMs = hasTiming ? source.paused_ms : 0;
    const timingVersion = hasTiming ? source.timing_version : 0;
    ensure((pausedAt === null || timestamp(pausedAt)) && integer(pausedMs) && integer(timingVersion));
    const clockEnd = pausedAt === null ? server : Date.parse(pausedAt);
    ensure(clockEnd >= started && clockEnd <= server && pausedMs <= clockEnd - started + 1);
    if (pausedAt !== null || pausedMs > 0) ensure(timingVersion > 0);
    ensure((source.finished_at === null && source.elapsed_ms === null) || (timestamp(source.finished_at) && integer(source.elapsed_ms)));
    ensure(Array.isArray(source.values) && Array.isArray(source.notes));
    let progress: ReturnType<typeof normalizeProgress>;
    try { progress = normalizeProgress(source.values, source.notes); } catch { throw new DailyDataError(); }
    ensure(progress.values.length === 36 && puzzle.givens.every((given, index) => given === 0 || progress.values[index] === given));
    if (source.finished_at !== null) {
      const finished = Date.parse(source.finished_at as string);
      ensure(pausedAt === null && finished >= started && finished <= server && Math.abs(finished - started - pausedMs - (source.elapsed_ms as number)) <= 1);
      ensure(progress.values.every(Boolean) && getConflicts({ ...puzzle, solution: [] }, progress.values).size === 0);
    }
    attempt = { id: source.id, started_at: source.started_at, finished_at: source.finished_at as string | null, elapsed_ms: source.elapsed_ms as number | null, ranked: source.ranked, paused_at: pausedAt, paused_ms: pausedMs, timing_version: timingVersion, ...progress };
  } else ensure(raw.puzzle === null);
  ensure(daily !== null || (puzzle === null && attempt === null));
  return { date, resets_at: raw.resets_at, server_now: raw.server_now, daily, puzzle, attempt, profile };
}

export function parseDailyStreaks(raw: unknown, expectedDate: string): DailyStreaks {
  object(raw, ['date', 'current', 'max', 'completed_today', 'last_completed_date']);
  const date = day(raw.date);
  ensure(date === expectedDate && integer(raw.current) && integer(raw.max) && raw.current <= raw.max && typeof raw.completed_today === 'boolean');
  const last = raw.last_completed_date === null ? null : day(raw.last_completed_date);
  if (last === null) ensure(raw.current === 0 && raw.max === 0 && !raw.completed_today);
  else {
    const gap = (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${last}T00:00:00Z`)) / 86_400_000;
    ensure(gap >= 0 && raw.max > 0 && raw.completed_today === (gap === 0));
    ensure(gap <= 1 ? raw.current > 0 : raw.current === 0);
  }
  return { date, current: raw.current, max: raw.max, completed_today: raw.completed_today, last_completed_date: last };
}

export function parseDailyLeaderboard(raw: unknown, expectedDate: string, expectedScope: LeaderboardScope): DailyLeaderboard {
  object(raw, ['date', 'scope', 'entries', 'self', 'total']);
  const date = day(raw.date); ensure(date === expectedDate && raw.scope === expectedScope && integer(raw.total));
  const entry = (value: unknown): LeaderboardEntry => {
    object(value, ['rank', 'user_id', 'display_name', 'friend_code', 'elapsed_ms']);
    ensure(integer(value.rank, 1) && isUuid(value.user_id) && integer(value.elapsed_ms));
    return { rank: value.rank, user_id: value.user_id, display_name: canonicalName(value.display_name), friend_code: canonicalCode(value.friend_code), elapsed_ms: value.elapsed_ms };
  };
  ensure(Array.isArray(raw.entries) && raw.entries.length <= raw.total);
  const entries = raw.entries.map(entry); ensure(new Set(entries.map(row => row.user_id)).size === entries.length);
  ensure(entries.every(row => row.rank <= (raw.total as number)));
  const self = raw.self === null ? null : entry(raw.self);
  if (self) {
    ensure(self.rank <= raw.total);
    const listed = entries.find(row => row.user_id === self.user_id);
    ensure(!listed || JSON.stringify(listed) === JSON.stringify(self));
  }
  return { date, scope: expectedScope, entries, self, total: raw.total };
}
export function parseFriendsState(raw: unknown): FriendsState {
  object(raw, ['profile', 'friends', 'incoming', 'outgoing']);
  const profile = parseProfile(raw.profile);
  const users = new Set<string>(), requests = new Set<string>();
  const person = (value: unknown, request: boolean): Friend | FriendRequest => {
    object(value, request ? ['id', 'user_id', 'display_name', 'friend_code'] : ['user_id', 'display_name', 'friend_code']);
    ensure(isUuid(value.user_id) && value.user_id !== profile.id && !users.has(value.user_id)); users.add(value.user_id);
    const friend = { user_id: value.user_id, display_name: canonicalName(value.display_name), friend_code: canonicalCode(value.friend_code) };
    if (!request) return friend;
    ensure(isUuid(value.id) && !requests.has(value.id)); requests.add(value.id);
    return { id: value.id, ...friend };
  };
  ensure(Array.isArray(raw.friends) && Array.isArray(raw.incoming) && Array.isArray(raw.outgoing));
  return {
    profile, friends: raw.friends.map(value => person(value, false)),
    incoming: raw.incoming.map(value => person(value, true) as FriendRequest),
    outgoing: raw.outgoing.map(value => person(value, true) as FriendRequest),
  };
}
