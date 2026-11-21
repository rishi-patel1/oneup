import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { generatePuzzle } from '../../src/game/generator';
import { getConflicts } from '../../src/game/engine';

type Profile = { id: string; display_name: string; friend_code: string };
type DailyState = {
  date: string; resets_at: string; server_now: string;
  daily: { id: string; date: string; size: number; difficulty: string } | null;
  puzzle: { id: string; givens: number[] } | null;
  attempt: { id: string; started_at: string; finished_at: string | null; elapsed_ms: number | null;
    ranked: boolean; values: number[]; notes: number[][] } | null;
  profile: Profile | null;
};
type Friend = { user_id: string; display_name: string; friend_code: string };
type Request = Friend & { id: string };
type Friends = { profile: Profile; friends: Friend[]; incoming: Request[]; outgoing: Request[] };
type Entry = Friend & { rank: number; elapsed_ms: number };
type Board = { date: string; scope: string; entries: Entry[]; self: Entry | null; total: number };
type RpcError = { error: string; code: string };

const A = '10000000-0000-4000-8000-000000000001';
const B = '10000000-0000-4000-8000-000000000002';
const C = '10000000-0000-4000-8000-000000000003';
const D = '10000000-0000-4000-8000-000000000004';
const ANON = '10000000-0000-4000-8000-000000000005';
const FORGED = '10000000-0000-4000-8000-000000000006';
const LATE = '10000000-0000-4000-8000-000000000007';
const ANON_GOOGLE = '10000000-0000-4000-8000-000000000008';
const puzzle = generatePuzzle({ size: 6, difficulty: 'Medium', seed: 'daily-sql-private-seed' });
const alternate = generatePuzzle({ size: 6, difficulty: 'Medium', seed: 'daily-sql-other-private-seed' });
const notes = Array.from({ length: 36 }, () => [] as number[]);
const migrationDirectory = new URL('../../supabase/migrations/', import.meta.url);
const migrations = readdirSync(migrationDirectory).filter(name => name.endsWith('.sql')).sort()
  .map(name => readFileSync(new URL(name, migrationDirectory), 'utf8')).join('\n');

// These are platform fixtures, not application authorization shortcuts. All RPC
// calls below run as real client roles with auth.uid() set from the request claim.
const platform = `
  create role anon; create role authenticated; create role service_role;
  create schema auth;
  create table auth.users (
    id uuid primary key, is_anonymous boolean not null default false,
    email text, raw_user_meta_data jsonb not null default '{}'::jsonb
  );
  create table auth.identities (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    provider text not null, identity_data jsonb not null default '{}'::jsonb,
    unique(user_id,provider)
  );
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;
  $$;
  grant usage on schema auth to anon,authenticated,service_role;
  create schema realtime;
  create table realtime.messages(extension text,topic text);
  alter table realtime.messages enable row level security;
  grant usage on schema realtime to authenticated;
  grant select,insert on realtime.messages to authenticated;
  create function realtime.topic() returns text language sql stable as $$
    select current_setting('realtime.topic',true);
  $$;
`;

test('daily SQL: shared UTC puzzles, Google ranking, private profiles, and accepted friends', async t => {
  const db = new PGlite();
  try {
    await db.exec(platform);
    await db.exec(migrations);
    const query = async <T>(sql: string, args: unknown[] = []) => (await db.query<{ data: T }>(sql, args)).rows[0].data;
    const asRole = async <T>(role: 'authenticated' | 'anon' | 'service_role', id: string | null, action: () => Promise<T>): Promise<T> => {
      await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id ?? '']);
      await db.exec(`set role ${role}`);
      try { return await action(); }
      finally { await db.exec('reset role'); await db.query("select set_config('request.jwt.claim.sub','',false)"); }
    };
    const user = <T>(id: string, action: () => Promise<T>) => asRole('authenticated', id, action);
    const daily = () => query<DailyState>('select public.numora_get_daily() as data');
    const start = () => query<DailyState>('select public.numora_start_daily() as data');
    const friends = () => query<Friends>('select public.numora_get_friends() as data');
    const request = (code: string) => query<Friends | RpcError>('select public.numora_request_friend($1) as data', [code]);
    const respond = (id: string, accept: boolean | null) => query<Friends>('select public.numora_respond_friend($1,$2) as data', [id, accept]);
    const cancel = (id: string) => query<Friends>('select public.numora_cancel_friend_request($1) as data', [id]);
    const remove = (id: string) => query<Friends>('select public.numora_remove_friend($1) as data', [id]);
    const board = (date: string | null = null, scope = 'global') => query<Board>('select public.numora_daily_leaderboard($1::date,$2) as data', [date, scope]);
    const today = await query<string>("select (clock_timestamp() at time zone 'UTC')::date::text as data");
    const previous = new Date(Date.parse(today) - 86400000).toISOString().slice(0, 10);
    const next = new Date(Date.parse(today) + 86400000).toISOString().slice(0, 10);
    const write = (values: number[], marks = notes, submit = false, date = today) => query<DailyState>(
      `select public.${submit ? 'numora_submit_daily' : 'numora_save_daily'}($1::date,$2::integer[],$3::jsonb) as data`,
      [date, values, JSON.stringify(marks)]);
    const ensure = (date = today, value = puzzle) => asRole('service_role', null,
      () => db.query('select public.numora_ensure_daily($1::date,$2::jsonb)', [date, JSON.stringify(value)]));
    for (const id of [A, B, C, D, ANON, FORGED, LATE, ANON_GOOGLE]) {
      await db.query('insert into auth.users(id,is_anonymous,email,raw_user_meta_data) values($1,$2,$3,$4::jsonb)',
        [id, [ANON, LATE, ANON_GOOGLE].includes(id), `${id}@private.example`, JSON.stringify({ name: 'Private legal name', provider: 'google', providers: ['google'] })]);
      if ([A, B, C, D, ANON_GOOGLE].includes(id))
        await db.query("insert into auth.identities(user_id,provider) values($1,'google')", [id]);
    }
    let dailyId = '';
    let profileA: Profile;
    let profileB: Profile;
    let profileC: Profile;
    let firstAttempt: DailyState['attempt'];
    let finishedA: DailyState['attempt'];

    await t.test('only authenticated users use daily APIs; absent puzzle stays absent and private', async () => {
      await assert.rejects(asRole('anon', null, daily), /permission denied/);
      await assert.rejects(asRole('authenticated', null, daily), /Sign in/);
      const s = await user(A, daily);
      profileA = s.profile!;
      assert.equal(s.daily, null); assert.equal(s.puzzle, null); assert.equal(s.attempt, null);
      assert.equal(s.date, today);
      assert.equal(new Date(s.resets_at).toISOString(), `${next}T00:00:00.000Z`);
      assert.equal(new Date(s.server_now).toISOString().slice(0, 10), today);
      assert.match(profileA.friend_code, /^[A-F0-9]{10}$/);
      assert.match(profileA.display_name, /^Player [A-F0-9]{6}$/);
      assert.deepEqual(Object.keys(profileA).sort(), ['display_name', 'friend_code', 'id']);
      assert.equal(JSON.stringify(s).includes('private.example'), false);
      assert.equal(JSON.stringify(s).includes('Private legal name'), false);
      await assert.rejects(user(A, start), /being prepared/);
    });

    await t.test('service-only ensure validates UTC date and puzzle integrity and never replaces a day', async () => {
      await assert.rejects(user(A, () => db.query('select public.numora_ensure_daily($1::date,$2::jsonb)', [today, JSON.stringify(puzzle)])), /permission denied/);
      await assert.rejects(asRole('anon', null, () => db.query('select public.numora_ensure_daily($1::date,$2::jsonb)', [today, JSON.stringify(puzzle)])), /permission denied/);
      await assert.rejects(ensure(previous), /current UTC/);
      await assert.rejects(ensure(next), /current UTC/);
      await assert.rejects(ensure(today, { ...puzzle, size: 5 }), /valid 6 by 6/);
      await assert.rejects(ensure(today, { ...puzzle, solution: puzzle.solution.map(() => 1) }), /valid 6 by 6/);
      await ensure();
      await ensure(today, alternate);
      assert.equal((await db.query('select * from numora_private.daily_puzzles')).rows.length, 1);
      assert.deepEqual(await query('select data as data from numora_private.daily_puzzles'), puzzle);
      const s = await user(A, daily);
      dailyId = s.daily!.id;
      assert.equal(s.daily!.size, 6); assert.equal(s.daily!.difficulty, 'Medium');
      assert.equal(s.puzzle, null); assert.equal(s.attempt, null);
      assert.equal(JSON.stringify(s).includes(puzzle.generation.seed), false);
    });

    await t.test('starting releases the common safe board and one immutable server timer', async () => {
      const s = await user(A, start);
      firstAttempt = s.attempt;
      assert.equal(s.attempt!.ranked, true);
      assert.deepEqual(s.attempt!.values, puzzle.givens);
      assert.deepEqual(s.attempt!.notes, notes);
      assert.deepEqual(s.puzzle!.givens, puzzle.givens);
      assert.equal(s.puzzle!.id, `daily-${dailyId}`);
      assert.equal(s.attempt!.elapsed_ms, null);
      assert.equal(JSON.stringify(s).includes(puzzle.generation.seed), false);
      assert.equal(JSON.stringify(s).includes('solution'), false);
      assert.equal(JSON.stringify(s).includes('generation'), false);
      const repeated = await user(A, async () => Promise.all(Array.from({ length: 8 }, start)));
      for (const state of repeated) {
        assert.equal(state.attempt!.id, firstAttempt!.id);
        assert.equal(state.attempt!.started_at, firstAttempt!.started_at);
      }
      const other = await user(B, start);
      profileB = other.profile!;
      assert.equal(other.daily!.id, dailyId);
      assert.deepEqual(other.puzzle, s.puzzle);
      assert.notEqual(other.attempt!.id, firstAttempt!.id);
      assert.equal(await query<number>('select count(*)::integer as data from numora_private.daily_attempts where user_id=$1', [A]), 1);
    });

    await t.test('anonymous, spoofed Google metadata, and inconsistent anonymous identity remain practice only', async () => {
      for (const id of [ANON, FORGED, LATE, ANON_GOOGLE]) {
        const s = await user(id, start);
        assert.equal(s.attempt!.ranked, false);
        assert.equal(s.profile, null);
        await assert.rejects(user(id, friends), /Sign in with Google/);
        await assert.rejects(user(id, () => board(null, 'friends')), /Sign in with Google/);
        await assert.rejects(user(id, () => query('select public.numora_update_profile($1) as data', ['Forged profile'])), /Sign in with Google/);
      }
      await db.query('update auth.users set is_anonymous=false where id=$1', [LATE]);
      await db.query("insert into auth.identities(user_id,provider) values($1,'google')", [LATE]);
      const upgraded = await user(LATE, start);
      assert.ok(upgraded.profile);
      assert.equal(upgraded.attempt!.ranked, false);
      const completed = await user(LATE, () => write(puzzle.solution, notes, true));
      assert.equal(completed.attempt!.ranked, false);
      assert.equal((await user(LATE, () => board())).self, null);
    });

    await t.test('progress permits visible-rule mistakes but preserves clues, note domains, and ownership', async () => {
      const values = [...puzzle.givens];
      const editable = values.findIndex(v => v === 0);
      let invalid = 0;
      for (let value = 1; value <= 6; value++) {
        values[editable] = value;
        if (getConflicts(puzzle, values).has(editable)) { invalid = value; break; }
      }
      assert.ok(invalid, 'test board contains a visible-rule-invalid legal digit');
      values[editable] = invalid;
      const marks = structuredClone(notes);
      const noteCell = values.findIndex((v, i) => v === 0 && i !== editable);
      marks[noteCell] = [1, 3];
      const s = await user(A, () => write(values, marks));
      assert.deepEqual(s.attempt!.values, values);
      assert.deepEqual(s.attempt!.notes, marks);
      const other = await user(B, daily);
      assert.deepEqual(other.attempt!.values, puzzle.givens);
      assert.deepEqual(other.attempt!.notes, notes);
      assert.equal(JSON.stringify(other).includes(firstAttempt!.id), false);
      const changedClue = [...puzzle.givens];
      const given = changedClue.findIndex(v => v !== 0);
      assert.ok(given >= 0);
      changedClue[given] = changedClue[given] % 6 + 1;
      await assert.rejects(user(A, () => write(changedClue)), /preserve the clues/);
      const outOfRange = [...puzzle.givens]; outOfRange[editable] = 7;
      await assert.rejects(user(A, () => write(outOfRange)), /board range/);
      const duplicateNotes = structuredClone(notes); duplicateNotes[noteCell] = [1, 1];
      await assert.rejects(user(A, () => write(puzzle.givens, duplicateNotes)), /notes/);
      const clueNotes = structuredClone(notes); clueNotes[given] = [1];
      await assert.rejects(user(A, () => write(puzzle.givens, clueNotes)), /notes/);
      await assert.rejects(user(A, () => write(values, marks, true)), /not solved/);
      await assert.rejects(user(C, () => write(puzzle.givens)), /Start today's puzzle/);
    });

    await t.test('first valid finish computes time on the server and survives replay and refresh', async () => {
      // Trusted fixture advances only elapsed time, not any client-supplied score.
      await db.query("update numora_private.daily_attempts set started_at=clock_timestamp()-interval '12 seconds' where user_id=$1", [A]);
      const s = await user(A, () => write(puzzle.solution, notes, true));
      finishedA = s.attempt;
      assert.ok(s.attempt!.elapsed_ms! >= 12000 && s.attempt!.elapsed_ms! < 14000);
      assert.ok(s.attempt!.finished_at);
      const replay = await user(A, () => write(puzzle.givens, notes, true));
      assert.deepEqual(replay.attempt, s.attempt);
      const saveAfterFinish = await user(A, () => write(puzzle.givens));
      assert.deepEqual(saveAfterFinish.attempt, s.attempt);
      assert.deepEqual((await user(A, start)).attempt, s.attempt);
      await assert.rejects(user(A, () => db.query('update numora_private.daily_attempts set elapsed_ms=0,ranked=true where user_id=$1', [A])), /permission denied/);
      await assert.rejects(user(A, () => db.query('select public.numora_submit_daily($1::date,$2::integer[],$3::jsonb,0)', [today, puzzle.solution, JSON.stringify(notes)])), /does not exist/);
      for (const id of [B, C]) {
        const initial = await user(id, start);
        if (id === C) profileC = initial.profile!;
        await user(id, () => write(puzzle.solution, notes, true));
      }
      await user(ANON, () => write(puzzle.solution, notes, true));
      await user(FORGED, () => write(puzzle.solution, notes, true));
      const ranked = await user(ANON, () => board());
      assert.equal(ranked.total, 3);
      assert.deepEqual(new Set(ranked.entries.map(x => x.user_id)), new Set([A, B, C]));
      assert.equal(ranked.self, null);
    });

    await t.test('UTC date expiry blocks old or future writes and does not reveal historical boards', async () => {
      await db.exec("set timezone='Pacific/Honolulu'");
      assert.equal((await user(A, daily)).date, today);
      assert.equal(new Date((await user(A, daily)).resets_at).toISOString(), `${next}T00:00:00.000Z`);
      await assert.rejects(user(A, () => write(puzzle.solution, notes, true, previous)), /expired/);
      await assert.rejects(user(A, () => write(puzzle.solution, notes, false, next)), /expired/);
      await assert.rejects(user(A, () => board(next)), /valid daily date/);
      await assert.rejects(user(A, () => board(null, 'private')), /valid daily date/);
      assert.equal((await user(A, () => board(previous))).total, 0);
      const current = (await user(A, daily)).attempt!;
      assert.equal(current.id, finishedA!.id);
      assert.equal(current.elapsed_ms, finishedA!.elapsed_ms);
      assert.equal(Date.parse(current.started_at), Date.parse(finishedA!.started_at));
      assert.equal(Date.parse(current.finished_at!), Date.parse(finishedA!.finished_at!));
      await db.exec("set timezone='UTC'");
    });

    await t.test('names are explicitly editable, bounded, and independent of Google metadata', async () => {
      const updated = await user(A, () => query<Profile>('select public.numora_update_profile($1) as data', ['  Puzzle Pal  ']));
      assert.equal(updated.display_name, 'Puzzle Pal');
      assert.equal(updated.friend_code, profileA.friend_code);
      assert.equal(updated.id, A);
      await assert.rejects(user(A, () => query('select public.numora_update_profile($1) as data', ['x'])), /2 to 24/);
      await assert.rejects(user(A, () => query('select public.numora_update_profile($1) as data', ['line\nbreak'])), /2 to 24/);
      const row = (await user(A, () => board())).self!;
      assert.equal(row.display_name, 'Puzzle Pal');
      assert.deepEqual(Object.keys(row).sort(), ['display_name', 'elapsed_ms', 'friend_code', 'rank', 'user_id']);
      assert.equal(JSON.stringify(await user(A, daily)).includes('private.example'), false);
    });

    let requestId = '';
    await t.test('friend codes create pending requests without implicit or crossed acceptance', async () => {
      assert.deepEqual((await user(A, friends)).friends, []);
      assert.equal((await user(A, () => request(profileA.friend_code)) as RpcError).code, 'SELF_REQUEST');
      assert.equal((await user(A, () => request('not an email@example.com')) as RpcError).code, 'INVALID_FRIEND_CODE');
      assert.equal((await user(A, () => request('0000000000')) as RpcError).code, 'FRIEND_NOT_FOUND');
      const sent = await user(A, () => request(` ${profileB.friend_code.toLowerCase()} `)) as Friends;
      assert.equal(sent.outgoing.length, 1); assert.equal(sent.friends.length, 0);
      requestId = sent.outgoing[0].id;
      assert.equal(sent.outgoing[0].user_id, B);
      const received = await user(B, friends);
      assert.equal(received.incoming[0].id, requestId);
      assert.equal(received.incoming[0].user_id, A);
      assert.equal((await user(A, () => request(profileB.friend_code)) as RpcError).code, 'REQUEST_PENDING');
      assert.equal((await user(B, () => request(profileA.friend_code)) as RpcError).code, 'INCOMING_REQUEST');
      assert.equal((await user(A, () => board(null, 'friends'))).total, 1);
      assert.deepEqual((await user(C, friends)).incoming, []);
      assert.deepEqual((await user(C, friends)).outgoing, []);
    });

    await t.test('only the recipient can accept or decline; only the sender can cancel', async () => {
      await assert.rejects(user(A, () => respond(requestId, true)), /Only the recipient/);
      await assert.rejects(user(C, () => respond(requestId, true)), /Only the recipient/);
      await assert.rejects(user(C, () => cancel(requestId)), /Only the sender/);
      await assert.rejects(user(B, () => cancel(requestId)), /Only the sender/);
      await assert.rejects(user(B, () => respond(requestId, null)), /Choose whether/);
      const accepted = await user(B, () => respond(requestId, true));
      assert.equal(accepted.friends.length, 1); assert.equal(accepted.friends[0].user_id, A);
      assert.deepEqual(accepted.incoming, []);
      assert.equal((await user(A, friends)).friends[0].user_id, B);
      await assert.rejects(user(A, () => cancel(requestId)), /Only the sender/);
      assert.equal((await user(A, () => request(profileB.friend_code)) as RpcError).code, 'ALREADY_FRIENDS');
      const another = await user(A, () => request(profileC.friend_code)) as Friends;
      const id = another.outgoing[0].id;
      await user(C, () => respond(id, false));
      assert.deepEqual((await user(A, friends)).outgoing, []);
      const third = await user(A, () => request(profileC.friend_code)) as Friends;
      await user(A, () => cancel(third.outgoing[0].id));
      assert.deepEqual((await user(C, friends)).incoming, []);
    });

    await t.test('friends board includes only accepted friends and self, with independent tied ranks', async () => {
      // Fixture creates an exact elapsed tie to exercise SQL ranking, not timing luck.
      await db.query('update numora_private.daily_attempts set elapsed_ms=15000 where user_id=any($1::uuid[])', [[A, B]]);
      await db.query('update numora_private.daily_attempts set elapsed_ms=20000 where user_id=$1', [C]);
      const global = await user(A, () => board());
      assert.deepEqual(global.entries.map(x => x.rank), [1, 1, 3]);
      const personal = await user(A, () => board(null, 'friends'));
      assert.equal(personal.total, 2);
      assert.deepEqual(new Set(personal.entries.map(x => x.user_id)), new Set([A, B]));
      assert.deepEqual(personal.entries.map(x => x.rank), [1, 1]);
      assert.equal(personal.self!.user_id, A);
      const noFriends = await user(C, () => board(null, 'friends'));
      assert.equal(noFriends.total, 1); assert.equal(noFriends.self!.rank, 1);
      await user(C, () => remove(B)); // A stranger cannot remove the A/B friendship.
      assert.equal((await user(A, friends)).friends[0].user_id, B);
      await user(B, () => remove(A));
      assert.deepEqual((await user(A, friends)).friends, []);
      assert.equal((await user(A, () => board(null, 'friends'))).total, 1);
    });

    await t.test('failed friend-code guesses consume the persisted request rate limit', async () => {
      await user(D, friends);
      for (let i = 0; i < 30; i++) {
        const result = await user(D, () => request('0000000000')) as RpcError;
        assert.equal(result.code, 'FRIEND_NOT_FOUND');
      }
      await assert.rejects(user(D, () => request(profileA.friend_code)), /Too many requests/);
      assert.equal(await query<number>("select request_count as data from numora_private.rate_limits where user_id=$1 and action='friend_request'", [D]), 30);
      assert.deepEqual((await user(A, friends)).incoming, []);
    });

    await t.test('top fifty is bounded while self remains available below the cutoff', async () => {
      for (let i = 10; i < 65; i++) {
        const id = `20000000-0000-4000-8000-${i.toString().padStart(12, '0')}`;
        await db.query('insert into auth.users(id) values($1)', [id]);
        await db.query("insert into auth.identities(user_id,provider) values($1,'google')", [id]);
        await db.query('insert into numora_private.profiles(user_id,display_name,friend_code) values($1,$2,$3)', [id, `Player ${i}`, i.toString(16).padStart(10, '0').toUpperCase()]);
        await db.query(`insert into numora_private.daily_attempts(daily_id,user_id,ranked,values,notes,started_at,finished_at,elapsed_ms)
          values($1,$2,true,$3::int[],$4::jsonb,clock_timestamp()-interval '1 hour',clock_timestamp(),$5)`,
        [dailyId, id, puzzle.solution, JSON.stringify(notes), i]);
      }
      const result = await user(A, () => board());
      assert.equal(result.total, 58);
      assert.equal(result.entries.length, 50);
      assert.equal(result.self!.user_id, A);
      assert.equal(result.self!.rank, 56);
      assert.equal(result.entries.some(x => x.user_id === A), false);
    });

    await t.test('raw tables and authorization helpers stay private and migration reapply preserves data', async () => {
      for (const table of ['profiles', 'daily_puzzles', 'daily_attempts', 'friendships']) {
        await assert.rejects(user(A, () => db.query(`select * from numora_private.${table}`)), /permission denied/);
        await assert.rejects(user(ANON, () => db.query(`select * from numora_private.${table}`)), /permission denied/);
        await assert.rejects(asRole('service_role', null, () => db.query(`select * from numora_private.${table}`)), /permission denied/);
      }
      await assert.rejects(user(A, () => db.query('select numora_private.is_google_user($1)', [B])), /permission denied/);
      await assert.rejects(user(A, () => db.query('select numora_private.daily_profile()')), /permission denied/);
      const count = await query<number>('select count(*)::integer as data from numora_private.daily_attempts');
      await db.exec(migrations);
      assert.equal(await query<number>('select count(*)::integer as data from numora_private.daily_attempts'), count);
      assert.equal((await user(A, daily)).attempt!.id, firstAttempt!.id);
      const definitions = await db.query<{ name: string; definer: boolean; config: string[] }>(`select p.proname as name,p.prosecdef as definer,p.proconfig as config
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where (n.nspname='public' and p.proname in ('numora_get_daily','numora_start_daily','numora_ensure_daily','numora_get_friends'))
          or (n.nspname='numora_private' and p.proname in ('get_daily','start_daily','ensure_daily','get_friends'))`);
      assert.equal(definitions.rows.length, 8);
      for (const fn of definitions.rows) {
        assert.equal(fn.definer, !fn.name.startsWith('numora_'));
        assert.ok(fn.config.includes('search_path=""'));
      }
      const rls = await db.query<{ relrowsecurity: boolean }>(`select relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='numora_private' and c.relname in ('profiles','daily_puzzles','daily_attempts','friendships')`);
      assert.equal(rls.rows.length, 4); assert.ok(rls.rows.every(row => row.relrowsecurity));
      assert.equal((await user(A, () => board())).total, 58);
    });
  } finally { await db.close(); }
});
