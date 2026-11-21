import assert from 'node:assert/strict';
import test from 'node:test';
import { DailyDataError, normalizeDailyDate, normalizeDisplayName, normalizeFriendCode, parseDailyLeaderboard, parseDailyState, parseFriendsState, parseProfile } from './model';

const user = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222';
const dailyId = '33333333-3333-4333-8333-333333333333', attemptId = '44444444-4444-4444-8444-444444444444';
const date = '2026-11-21', now = `${date}T12:00:05.000Z`;
const profile = { id: user, display_name: 'Player One', friend_code: 'ABC1234567' };
function daily(started = true) {
  return {
    date, resets_at: '2026-11-22T00:00:00Z', server_now: now,
    daily: { id: dailyId, date, size: 6, difficulty: 'Medium' },
    puzzle: started ? { id: `daily-${dailyId}`, title: 'The shared daily', description: 'A fresh challenge.', size: 6, difficulty: 'Medium', givens: [1, ...Array<number>(35).fill(0)], rightWalls: Array<boolean>(36).fill(false), bottomWalls: Array<boolean>(36).fill(false) } : null,
    attempt: started ? { id: attemptId, started_at: `${date}T12:00:00Z`, finished_at: null as string | null, elapsed_ms: null as number | null, ranked: true, values: [1, ...Array<number>(35).fill(0)], notes: Array.from({ length: 36 }, () => [] as number[]) } : null,
    profile,
  };
}
function friends() { return { profile, friends: [{ user_id: other, display_name: 'Player Two', friend_code: 'BCD1234567' }], incoming: [], outgoing: [] }; }
const row = { rank: 1, user_id: user, display_name: profile.display_name, friend_code: profile.friend_code, elapsed_ms: 1234 };

test('daily dates, names and friend codes normalize safely', () => {
  assert.equal(normalizeDailyDate(date), date);
  for (const invalid of ['2026-02-30', '2026-1-01', 'today', '2026-11-21T00:00:00Z']) assert.throws(() => normalizeDailyDate(invalid));
  assert.equal(normalizeFriendCode(' abc1234567 '), profile.friend_code);
  for (const invalid of ['ABC123', 'ZBC1234567', 'ABC12345678']) assert.throws(() => normalizeFriendCode(invalid));
  assert.equal(normalizeDisplayName(' Café   Player '), 'Café Player');
  assert.throws(() => normalizeDisplayName('A'));
});

test('metadata cannot reveal a board before starting and uses the UTC server day', () => {
  assert.equal(parseDailyState(daily(false)).attempt, null);
  const leaked = daily(false); leaked.puzzle = daily().puzzle;
  assert.throws(() => parseDailyState(leaked), DailyDataError);
  for (const patch of [{ date: '2026-11-20' }, { resets_at: `${date}T23:00:00Z` }, { server_now: 'invalid' }, { daily: null }]) assert.throws(() => parseDailyState({ ...daily(), ...patch }), DailyDataError);
});

test('daily drafts preserve fixed clues and notes while accepting conflicting guesses', () => {
  const raw = daily(); raw.attempt!.values[1] = 1; raw.attempt!.notes[2] = [6, 1];
  const parsed = parseDailyState(raw);
  assert.equal(parsed.attempt?.values[1], 1);
  assert.deepEqual(parsed.attempt?.notes[2], [1, 6]);
  parsed.attempt!.values[1] = 5; parsed.puzzle!.givens[0] = 0;
  assert.equal(raw.attempt!.values[1], 1); assert.equal(raw.puzzle!.givens[0], 1);
  raw.attempt!.values[0] = 0;
  assert.throws(() => parseDailyState(raw), DailyDataError);
  const badNotes = daily(); badNotes.attempt!.notes[0] = [1];
  assert.throws(() => parseDailyState(badNotes), DailyDataError);
});

test('finished daily attempts require an actual valid board and consistent server timing', () => {
  const raw = daily();
  raw.attempt!.values = Array.from({ length: 36 }, (_, i) => (Math.floor(i / 6) + i % 6) % 6 + 1);
  raw.attempt!.finished_at = `${date}T12:00:02Z`; raw.attempt!.elapsed_ms = 2000;
  assert.equal(parseDailyState(raw).attempt?.elapsed_ms, 2000);
  raw.attempt!.elapsed_ms = 0;
  assert.throws(() => parseDailyState(raw), DailyDataError);
  raw.attempt!.elapsed_ms = 2000; raw.attempt!.values[1] = 1;
  assert.throws(() => parseDailyState(raw), DailyDataError);
});

test('daily, profile and leaderboard responses fail closed on answers, seeds and auth details', () => {
  for (const key of ['solution', 'seed', 'generation', 'access_token', 'email']) {
    assert.throws(() => parseDailyState({ ...daily(), [key]: 'private' }), DailyDataError);
    assert.throws(() => parseProfile({ ...profile, [key]: 'private' }), DailyDataError);
    assert.throws(() => parseDailyLeaderboard({ date, scope: 'global', entries: [{ ...row, [key]: 'private' }], self: null, total: 1 }, date, 'global'), DailyDataError);
  }
  const hidden = daily(); Object.assign(hidden.puzzle!, { seed: 'hidden' });
  assert.throws(() => parseDailyState(hidden), DailyDataError);
  const seededId = daily(); seededId.puzzle!.id = 'generated-v1-6-Medium-secret';
  assert.throws(() => parseDailyState(seededId), DailyDataError);
});

test('leaderboards are scoped to the requested day and reject duplicated or inconsistent placements', () => {
  const raw = { date, scope: 'global', entries: [row], self: row, total: 1 };
  assert.equal(parseDailyLeaderboard(raw, date, 'global').self?.user_id, user);
  for (const patch of [{ date: '2026-11-20' }, { scope: 'friends' }, { total: 0 }, { entries: [row, row], total: 2 }, { self: { ...row, elapsed_ms: 999 } }]) assert.throws(() => parseDailyLeaderboard({ ...raw, ...patch }, date, 'global'), DailyDataError);
});

test('friends separate request IDs from user IDs and never expose account data', () => {
  const incoming = { id: attemptId, user_id: other, display_name: 'Player Two', friend_code: 'BCD1234567' };
  const parsed = parseFriendsState({ profile, friends: [], incoming: [incoming], outgoing: [] });
  assert.equal(parsed.incoming[0].id, attemptId); assert.equal(parsed.incoming[0].user_id, other);
  assert.equal(parseFriendsState(friends()).friends[0].user_id, other);
  for (const patch of [{ outgoing: [incoming] }, { profile: { ...profile, email: 'private' } }, { friends: [{ ...friends().friends[0], values: [] }] }]) assert.throws(() => parseFriendsState({ profile, friends: [], incoming: [incoming], outgoing: [], ...patch }), DailyDataError);
});
