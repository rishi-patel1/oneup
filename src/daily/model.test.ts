import assert from 'node:assert/strict';
import test from 'node:test';
import { DailyDataError, getDailyElapsed, isCurrentDailySnapshot, normalizeDailyDate, normalizeDisplayName, normalizeFriendCode, parseDailyLeaderboard, parseDailyState, parseDailyStreaks, parseFriendsState, parseProfile } from './model';

const user = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222';
const dailyId = '33333333-3333-4333-8333-333333333333', attemptId = '44444444-4444-4444-8444-444444444444';
const date = '2026-11-21', now = `${date}T12:00:05.000Z`;
const profile = { id: user, display_name: 'Player One', friend_code: 'ABC1234567' };
function daily(started = true) {
  return {
    date, resets_at: '2026-11-22T04:00:00Z', server_now: now,
    daily: { id: dailyId, date, size: 6, difficulty: 'Medium' },
    puzzle: started ? { id: `daily-${dailyId}`, title: 'The shared daily', description: 'A fresh challenge.', size: 6, difficulty: 'Medium', givens: [1, ...Array<number>(35).fill(0)], rightWalls: Array<boolean>(36).fill(false), bottomWalls: Array<boolean>(36).fill(false) } : null,
    attempt: started ? { id: attemptId, started_at: `${date}T12:00:00Z`, finished_at: null as string | null, elapsed_ms: null as number | null, ranked: true, values: [1, ...Array<number>(35).fill(0)], notes: Array.from({ length: 36 }, () => [] as number[]) } : null,
    profile,
  };
}
function friends() { return { profile, friends: [{ user_id: other, display_name: 'Player Two', friend_code: 'BCD1234567' }], incoming: [], outgoing: [] }; }
const row = { rank: 1, user_id: user, display_name: profile.display_name, friend_code: profile.friend_code, elapsed_ms: 1234 };

test('daily streaks distinguish today, yesterday, gaps, and no history', () => {
  const empty = { date, current: 0, max: 0, completed_today: false, last_completed_date: null };
  assert.deepEqual(parseDailyStreaks(empty, date), empty);
  const active = { date, current: 3, max: 7, completed_today: false, last_completed_date: '2026-11-20' };
  assert.deepEqual(parseDailyStreaks(active, date), active);
  assert.equal(parseDailyStreaks({ ...active, current: 4, completed_today: true, last_completed_date: date }, date).current, 4);
  assert.equal(parseDailyStreaks({ ...active, current: 0, last_completed_date: '2026-11-19' }, date).max, 7);
});

test('streak snapshots reject stale dates, impossible counts, and unrelated user data', () => {
  const valid = { date, current: 1, max: 4, completed_today: true, last_completed_date: date };
  for (const patch of [
    { date: '2026-11-20' }, { current: -1 }, { current: 5 }, { max: 0 }, { current: 1.5 },
    { completed_today: false }, { last_completed_date: '2026-11-22' }, { last_completed_date: null },
    { last_completed_date: '2026-11-19', completed_today: false }, { user_id: other }, { seed: 'hidden' },
  ]) assert.throws(() => parseDailyStreaks({ ...valid, ...patch }, date), DailyDataError);
});

test('daily dates, names and friend codes normalize safely', () => {
  assert.equal(normalizeDailyDate(date), date);
  for (const invalid of ['2026-02-30', '2026-1-01', 'today', '2026-11-21T00:00:00Z']) assert.throws(() => normalizeDailyDate(invalid));
  assert.equal(normalizeFriendCode(' abc1234567 '), profile.friend_code);
  for (const invalid of ['ABC123', 'ZBC1234567', 'ABC12345678']) assert.throws(() => normalizeFriendCode(invalid));
  assert.equal(normalizeDisplayName(' Café   Player '), 'Café Player');
  assert.throws(() => normalizeDisplayName('A'));
});

test('metadata cannot reveal a board before starting and uses the 9:30 AM IST challenge day', () => {
  assert.equal(parseDailyState(daily(false)).attempt, null);
  const leaked = daily(false); leaked.puzzle = daily().puzzle;
  assert.throws(() => parseDailyState(leaked), DailyDataError);
  for (const patch of [{ date: '2026-11-20' }, { resets_at: `${date}T23:00:00Z` }, { server_now: 'invalid' }, { daily: null }]) assert.throws(() => parseDailyState({ ...daily(), ...patch }), DailyDataError);
});

test('the daily label switches exactly at 04:00 UTC, including the next UTC calendar morning', () => {
  const before = {
    ...daily(false), date: '2026-11-20',
    daily: { ...daily(false).daily, date: '2026-11-20' },
    server_now: `${date}T03:59:59.999999Z`, resets_at: `${date}T04:00:00Z`,
  };
  assert.equal(parseDailyState(before).date, '2026-11-20');
  assert.throws(() => parseDailyState({ ...before, server_now: `${date}T04:00:00Z` }), DailyDataError);
  const opened = { ...daily(false), server_now: `${date}T04:00:00Z` };
  assert.equal(parseDailyState(opened).date, date);
  assert.throws(() => parseDailyState({ ...opened, server_now: `${date}T03:59:59.999Z` }), DailyDataError);
  assert.equal(parseDailyState({ ...opened, server_now: '2026-11-22T03:59:59.999Z' }).date, date);
  assert.throws(() => parseDailyState({ ...opened, server_now: '2026-11-22T04:00:00Z' }), DailyDataError);
  assert.throws(() => parseDailyState({ ...opened, resets_at: '2026-11-22T03:59:59.999Z' }), DailyDataError);
  assert.equal(parseDailyState({ ...opened, server_now: `${date}T09:30:00+05:30`, resets_at: '2026-11-22T09:30:00+05:30' }).date, date);
});

test('rolling deployment accepts either complete reset schedule without accepting mixed day windows', () => {
  const legacy = { ...daily(false), resets_at: '2026-11-22T00:00:00Z' };
  assert.equal(parseDailyState({ ...legacy, server_now: `${date}T00:00:00Z` }).date, date);
  assert.equal(parseDailyState({ ...legacy, server_now: `${date}T23:59:59.999Z` }).date, date);
  assert.throws(() => parseDailyState({ ...legacy, server_now: '2026-11-22T01:00:00Z' }), DailyDataError);
  assert.throws(() => parseDailyState({ ...daily(false), server_now: `${date}T01:00:00Z` }), DailyDataError);
  assert.throws(() => parseDailyState({ ...legacy, resets_at: '2026-11-22T05:00:00Z' }), DailyDataError);
});

test('challenge-day validation crosses year and leap-day boundaries independently of local timezone', () => {
  for (const [label, afterMidnight] of [['2026-12-31', '2027-01-01'], ['2028-02-29', '2028-03-01']]) {
    const raw = {
      ...daily(false), date: label, daily: { ...daily(false).daily, date: label },
      server_now: `${afterMidnight}T03:59:59.999Z`, resets_at: `${afterMidnight}T04:00:00Z`,
    };
    assert.equal(parseDailyState(raw).date, label);
    assert.throws(() => parseDailyState({ ...raw, server_now: raw.resets_at }), DailyDataError);
  }
});

test('existing attempts and accepted finishes before the new opening hour remain readable', () => {
  const raw = daily();
  raw.server_now = `${date}T04:00:00Z`;
  raw.attempt!.started_at = `${date}T00:00:00Z`;
  assert.equal(parseDailyState(raw).attempt?.started_at, raw.attempt!.started_at);
  raw.attempt!.started_at = '2026-11-20T23:59:59.999Z';
  assert.throws(() => parseDailyState(raw), DailyDataError);
  raw.attempt!.started_at = `${date}T02:00:00Z`;
  raw.attempt!.values = Array.from({ length: 36 }, (_, i) => (Math.floor(i / 6) + i % 6) % 6 + 1);
  raw.attempt!.finished_at = `${date}T03:00:00Z`;
  raw.attempt!.elapsed_ms = 3_600_000;
  assert.equal(parseDailyState(raw).attempt?.elapsed_ms, 3_600_000);
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

test('paused daily clocks freeze and resume using accumulated server pause time', () => {
  const raw = daily();
  Object.assign(raw.attempt!, {paused_at:`${date}T12:00:02Z`,paused_ms:1000,timing_version:3});
  const paused = parseDailyState(raw);
  assert.equal(getDailyElapsed(paused.attempt!, Date.parse(`${date}T12:00:05Z`)), 1000);
  assert.equal(getDailyElapsed(paused.attempt!, Date.parse(`${date}T12:05:00Z`)), 1000);
  Object.assign(raw.attempt!, {paused_at:null,paused_ms:4000,timing_version:4});
  const resumed = parseDailyState(raw);
  assert.equal(getDailyElapsed(resumed.attempt!, Date.parse(now)), 1000);
  assert.equal(getDailyElapsed(resumed.attempt!, Date.parse(`${date}T12:00:06Z`)), 2000);
  const legacy = parseDailyState(daily());
  assert.equal(legacy.attempt?.paused_at, null);
  assert.equal(legacy.attempt?.paused_ms, 0);
  assert.equal(legacy.attempt?.timing_version, 0);
});

test('daily timing rejects malformed pauses and validates ranked active finish time', () => {
  for (const patch of [
    {paused_at:`${date}T12:00:06Z`,paused_ms:0,timing_version:1},
    {paused_at:`${date}T11:59:59Z`,paused_ms:0,timing_version:1},
    {paused_at:`${date}T12:00:02Z`,paused_ms:3000,timing_version:1},
    {paused_at:null,paused_ms:-1,timing_version:1},
    {paused_at:null,paused_ms:0,timing_version:1.5},
    {paused_at:`${date}T12:00:02Z`,paused_ms:0,timing_version:0},
    {paused_ms:0},
  ]) { const bad = daily(); Object.assign(bad.attempt!, patch); assert.throws(() => parseDailyState(bad), DailyDataError); }
  const finished = daily();
  finished.attempt!.values = Array.from({length:36},(_,i)=>(Math.floor(i/6)+i%6)%6+1);
  Object.assign(finished.attempt!, {paused_at:null,paused_ms:3000,timing_version:2,finished_at:now,elapsed_ms:2000});
  assert.equal(parseDailyState(finished).attempt?.elapsed_ms, 2000);
  Object.assign(finished.attempt!, {elapsed_ms:5000});
  assert.throws(() => parseDailyState(finished), DailyDataError);
});

test('same-millisecond late polls cannot undo a daily pause, resume, or confirmed finish', () => {
  const before = parseDailyState(daily());
  const paused = structuredClone(before);
  paused.attempt!.paused_at = `${date}T12:00:05Z`;
  paused.attempt!.timing_version = 1;
  paused.server_now = `${date}T12:00:05.000900Z`;
  before.server_now = `${date}T12:00:05.000100Z`;
  assert.equal(Date.parse(paused.server_now), Date.parse(before.server_now));
  assert.equal(isCurrentDailySnapshot(before,paused,Date.parse(before.server_now)),true);
  assert.equal(isCurrentDailySnapshot(paused,before,Date.parse(paused.server_now)),false);
  const resumed = structuredClone(paused);
  resumed.attempt!.paused_at = null; resumed.attempt!.timing_version = 2;
  assert.equal(isCurrentDailySnapshot(resumed,paused,Date.parse(resumed.server_now)),false);
  const finished = structuredClone(resumed); finished.attempt!.finished_at = now;
  assert.equal(isCurrentDailySnapshot(finished,resumed,Date.parse(finished.server_now)),false);
});

test('a strictly newer schedule correction may move the daily label back once before 04:00 UTC', () => {
  const metadata = (label: string, server: string, reset: string) => parseDailyState({
    ...daily(false), date: label, daily: { ...daily(false).daily, date: label }, server_now: server, resets_at: reset,
  });
  const legacy = metadata('2026-11-22', '2026-11-22T01:00:00Z', '2026-11-23T00:00:00Z');
  const current = metadata(date, '2026-11-22T01:00:00.001Z', '2026-11-22T04:00:00Z');
  assert.equal(isCurrentDailySnapshot(legacy, current, Date.parse(legacy.server_now)), true);
  assert.equal(isCurrentDailySnapshot(legacy, { ...current, server_now: legacy.server_now }, Date.parse(legacy.server_now)), false);
  assert.equal(isCurrentDailySnapshot(legacy, { ...current, server_now: '2026-11-22T00:59:59Z' }, Date.parse(legacy.server_now)), false);
  assert.equal(isCurrentDailySnapshot(legacy, { ...current, date: '2026-11-20', resets_at: '2026-11-21T04:00:00Z' }, Date.parse(legacy.server_now)), false);
  assert.equal(isCurrentDailySnapshot(current, { ...legacy, server_now: '2026-11-22T01:00:01Z' }, Date.parse(current.server_now)), false);
  const next = metadata('2026-11-22', '2026-11-22T04:00:00Z', '2026-11-23T04:00:00Z');
  assert.equal(isCurrentDailySnapshot(current, next, Date.parse(current.server_now)), true);
  assert.equal(isCurrentDailySnapshot(next, current, Date.parse(next.server_now)), false);
});

test('same-day deadline extension retires the former schedule even when its response clock is newer', () => {
  const legacy = parseDailyState({ ...daily(false), resets_at: '2026-11-22T00:00:00Z' });
  const current = parseDailyState({ ...daily(false), server_now: `${date}T12:00:05.001Z` });
  assert.equal(isCurrentDailySnapshot(legacy, current, Date.parse(legacy.server_now)), true);
  const staleSchedule = { ...legacy, server_now: `${date}T12:00:06Z` };
  assert.equal(isCurrentDailySnapshot(current, staleSchedule, Date.parse(current.server_now)), false);
});
