import assert from 'node:assert/strict';
import test from 'node:test';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createDailyApi, explainDailyError } from './api';

const user = '11111111-1111-4111-8111-111111111111', target = 'abcdef12-abcd-4abc-8abc-abcdef123456';
const date = '2026-11-21';
const profile = { id: user, display_name: 'Player One', friend_code: 'ABC1234567' };
const metadata = { date, resets_at: '2026-11-22T00:00:00Z', server_now: `${date}T12:00:00Z`, daily: null, puzzle: null, attempt: null, profile: null };
const friends = { profile, friends: [], incoming: [], outgoing: [] };
function mock() {
  let data: unknown = metadata, error: unknown = null, identities = 0;
  const calls: { name: string; args: unknown }[] = [], signals: AbortSignal[] = [];
  const client = {
    rpc(name: string, args: unknown) { calls.push({ name, args }); const result = Promise.resolve({ data, error }); return Object.assign(result, { abortSignal(signal: AbortSignal) { signals.push(signal); return result; } }); },
    functions: { async invoke(name: string, args: unknown) { calls.push({ name, args }); return { data, error }; } },
  } as unknown as SupabaseClient;
  const api = createDailyApi(client, async () => { identities++; return user; });
  return { api, calls, signals, respond: (next: unknown, failure: unknown = null) => { data = next; error = failure; }, identityCalls: () => identities };
}

test('daily metadata is lazy, checks timed state, and generates only when the day is missing', async () => {
  const service = mock(); assert.equal(service.identityCalls(), 0);
  const controller = new AbortController();
  assert.equal((await service.api.getDailyState(controller.signal)).attempt, null);
  assert.equal(service.identityCalls(), 2);
  assert.deepEqual(service.calls, [
    { name: 'numora_get_daily_timed', args: {} },
    { name: 'numora-daily', args: { body: {}, signal: controller.signal } },
    { name: 'numora_get_daily_timed', args: {} },
  ]);
  assert.equal(service.signals[0], controller.signal);
  assert.equal(service.signals[1], controller.signal);
  await service.api.startDaily(); assert.deepEqual(service.calls[3], { name: 'numora_start_daily_timed', args: {} });
  const ready = mock();
  ready.respond({ ...metadata, daily: { id: target, date, size: 6, difficulty: 'Medium' } });
  await ready.api.getDailyState();
  assert.deepEqual(ready.calls, [{ name: 'numora_get_daily_timed', args: {} }]);
});

test('daily saves send immutable board snapshots with no client identity, ranking or time claims', async () => {
  const service = mock(), values = Array<number>(36).fill(0), notes = values.map(() => [] as number[]);
  notes[0] = [6, 1];
  await service.api.saveDaily(date, values, notes); await service.api.submitDaily(date, values, notes);
  values[1] = 6; notes[0].push(2);
  assert.deepEqual(Object.keys(service.calls[0].args as object).sort(), ['p_date', 'p_notes', 'p_timing_version', 'p_values']);
  assert.equal(service.calls[1].name, 'numora_submit_daily_timed');
  assert.equal((service.calls[0].args as { p_values: number[] }).p_values[1], 0);
  assert.deepEqual((service.calls[0].args as { p_notes: number[][] }).p_notes[0], [1, 6]);
});

test('malformed dates, board sizes and friend identifiers fail before guest authentication', async () => {
  const service = mock();
  await assert.rejects(service.api.getDailyLeaderboard('2026-02-30', 'global'));
  await assert.rejects(service.api.saveDaily(date, Array(25).fill(0), Array.from({ length: 25 }, () => [])));
  await assert.rejects(service.api.requestFriend('ABC123'));
  await assert.rejects(service.api.respondFriend('bad', true));
  assert.equal(service.calls.length, 0); assert.equal(service.identityCalls(), 0);
});

test('leaderboard requests enforce response day/scope and forward cancellation', async () => {
  const service = mock(), controller = new AbortController();
  service.respond({ date, scope: 'friends', entries: [], self: null, total: 0 });
  assert.equal((await service.api.getDailyLeaderboard(date, 'friends', controller.signal)).scope, 'friends');
  assert.deepEqual(service.calls[0], { name: 'numora_daily_leaderboard', args: { p_date: date, p_scope: 'friends' } });
  assert.equal(service.signals[0], controller.signal);
  service.respond({ date: '2026-11-20', scope: 'friends', entries: [], self: null, total: 0 });
  await assert.rejects(service.api.getDailyLeaderboard(date, 'friends'), /unexpected data/);
});

test('streaks request only the current account and bind the response to the UTC day', async () => {
  const service = mock(), controller = new AbortController();
  const streaks = { date, current: 2, max: 5, completed_today: true, last_completed_date: date };
  service.respond(streaks);
  assert.deepEqual(await service.api.getDailyStreaks(date, controller.signal), streaks);
  assert.deepEqual(service.calls[0], { name: 'numora_daily_streaks', args: {} });
  assert.equal(service.signals[0], controller.signal);
  assert.equal(service.identityCalls(), 1);
  service.respond({ ...streaks, date: '2026-11-20' });
  await assert.rejects(service.api.getDailyStreaks(date), /unexpected data/);
  const untouched = mock();
  await assert.rejects(untouched.api.getDailyStreaks('2026-02-30'));
  assert.equal(untouched.identityCalls(), 0);
});

test('friend mutations use canonical codes, request IDs, and user IDs without authorizing from the client', async () => {
  const service = mock(); service.respond(friends);
  await service.api.getFriends(); await service.api.requestFriend(' abc1234567 ');
  await service.api.respondFriend(` ${target.toUpperCase()} `, true); await service.api.removeFriend(target); await service.api.cancelFriendRequest(target);
  assert.deepEqual(service.calls.map(call => call.name), ['numora_get_friends', 'numora_request_friend', 'numora_respond_friend', 'numora_remove_friend', 'numora_cancel_friend_request']);
  assert.deepEqual(service.calls[1].args, { p_friend_code: 'ABC1234567' });
  assert.deepEqual(service.calls[2].args, { p_request_id: target, p_accept: true });
  assert.deepEqual(service.calls[3].args, { p_user_id: target });
  service.respond(profile); await service.api.updateProfile(' Player   One ');
  assert.deepEqual(service.calls[5].args, { p_display_name: 'Player One' });
});

test('server Google and expired-day gates remain authoritative with safe error feedback', async () => {
  const service = mock();
  service.respond(null, { code: '42501', message: 'Sign in with Google to use friends.' });
  await assert.rejects(service.api.getFriends(), /Sign in with Google/);
  service.respond({ error: 'No player has that friend code.', code: 'FRIEND_NOT_FOUND' });
  await assert.rejects(service.api.requestFriend('ABC1234567'), /friend code wasn’t found/);
  service.respond(null, { context: new Response(JSON.stringify({ error: 'This daily puzzle has expired. Start today’s puzzle.' }), { status: 400 }) });
  await assert.rejects(service.api.getDailyState(), /new daily challenge/);
  assert.match(explainDailyError({ code: 'PGRST202', message: 'internal SQL function missing' }), /not ready/);
  assert.equal(explainDailyError({ message: 'Internal server failure with token=secret' }), 'Something went wrong. Please try again.');
});

test('daily pause controls and board writes carry the server timer version without client elapsed time', async () => {
  const service = mock();
  await service.api.setDailyPaused(date, ` ${target.toUpperCase()} `, true, 3);
  await service.api.setDailyPaused(date, target, false, 4);
  const values = Array<number>(36).fill(0), notes = values.map(() => [] as number[]);
  await service.api.saveDaily(date, values, notes, 5);
  await service.api.submitDaily(date, values, notes, 5);
  assert.deepEqual(service.calls[0], {name:'numora_set_daily_paused',args:{p_date:date,p_attempt_id:target,p_paused:true,p_timing_version:3}});
  assert.deepEqual(service.calls[1], {name:'numora_set_daily_paused',args:{p_date:date,p_attempt_id:target,p_paused:false,p_timing_version:4}});
  assert.equal((service.calls[2].args as {p_timing_version:number}).p_timing_version, 5);
  assert.equal(service.calls[2].name, 'numora_save_daily_timed');
  assert.equal(service.calls[3].name, 'numora_submit_daily_timed');
  assert.deepEqual(Object.keys(service.calls[3].args as object).sort(), ['p_date','p_notes','p_timing_version','p_values']);
  const invalid = mock();
  await assert.rejects(invalid.api.setDailyPaused(date, 'bad', true, 0));
  await assert.rejects(invalid.api.setDailyPaused(date, target, true, -1));
  await assert.rejects(invalid.api.saveDaily(date, values, notes, 1.5));
  assert.equal(invalid.identityCalls(), 0);
  assert.equal(invalid.calls.length, 0);
  assert.match(explainDailyError({message:'The daily timer has changed. Refresh before continuing.'}), /timer changed/);
  assert.match(explainDailyError({message:'This attempt is paused.'}), /Resume before continuing/);
});
