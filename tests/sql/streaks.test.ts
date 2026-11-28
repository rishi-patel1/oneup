import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

type Streaks = { date: string; current: number; max: number; completed_today: boolean; last_completed_date: string | null };
const A = '30000000-0000-4000-8000-000000000001';
const B = '30000000-0000-4000-8000-000000000002';
const C = '30000000-0000-4000-8000-000000000003';
const PRACTICE = '30000000-0000-4000-8000-000000000004';
const directory = new URL('../../supabase/migrations/', import.meta.url);
const files = readdirSync(directory).filter(name => name.endsWith('.sql')).sort();
const migration = files.map(name => readFileSync(new URL(name, directory), 'utf8')).join('\n');

test('daily streaks derive private ranked history with daily-period grace and calendar boundaries', async t => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create schema auth;
      create table auth.users(id uuid primary key,is_anonymous boolean not null default false);
      create table auth.identities(user_id uuid references auth.users(id),provider text);
      create function auth.uid() returns uuid language sql stable as $$
        select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;
      $$;
      grant usage on schema auth to anon,authenticated,service_role;
      create schema realtime;
      create table realtime.messages(extension text,topic text);
      alter table realtime.messages enable row level security;
      create function realtime.topic() returns text language sql stable as $$
        select current_setting('realtime.topic',true);
      $$;
    `);
    await db.exec(migration);
    for (const id of [A, B, C, PRACTICE]) {
      await db.query('insert into auth.users(id,is_anonymous) values($1,$2)', [id, id === PRACTICE]);
      if (id !== PRACTICE) await db.query("insert into auth.identities values($1,'google')", [id]);
    }
    const role = async <T>(name: string, id: string | null, action: () => Promise<T>): Promise<T> => {
      await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id ?? '']);
      await db.exec(`set role ${name}`);
      try { return await action(); }
      finally { await db.exec('reset role'); }
    };
    const rpc = async () => (await db.query<{ data: Streaks }>('select public.numora_daily_streaks() as data')).rows[0].data;
    const read = (id: string) => role('authenticated', id, rpc);
    const today = (await db.query<{ date: string }>("select numora_private.daily_day(clock_timestamp())::text as date")).rows[0].date;
    const date = (offset: number) => new Date(Date.parse(today) + offset * 86400000).toISOString().slice(0, 10);
    const add = async (id: string, day: string, ranked = true, finished = true) => {
      // Trusted history fixture avoids changing production clocks or waiting days.
      // No puzzle content is needed: the streak RPC reads dates/results only.
      await db.query("insert into numora_private.daily_puzzles(date,data) values($1,'{}') on conflict(date) do nothing", [day]);
      await db.query(`insert into numora_private.daily_attempts(daily_id,user_id,ranked,values,notes,started_at,finished_at,elapsed_ms)
        select id,$2,$3,array[]::int[],'[]'::jsonb,$1::date::timestamp at time zone 'UTC',
          case when $4 then ($1::date::timestamp at time zone 'UTC')+interval '1 minute' else null end,
          case when $4 then 60000 else null end from numora_private.daily_puzzles where date=$1::date`, [day, id, ranked, finished]);
    };

    await t.test('empty history returns exact zeros; anonymous role, missing identity and service role are denied', async () => {
      assert.deepEqual(await read(A), { date: today, current: 0, max: 0, completed_today: false, last_completed_date: null });
      await assert.rejects(role('anon', null, rpc), /permission denied/);
      await assert.rejects(role('service_role', null, rpc), /permission denied/);
      await assert.rejects(role('authenticated', null, rpc), /Sign in/);
      assert.deepEqual(await read(PRACTICE), { date: today, current: 0, max: 0, completed_today: false, last_completed_date: null });
    });
    await t.test('consecutive completions through yesterday retain the active streak', async () => {
      for (const offset of [-3, -2, -1]) await add(A, date(offset));
      assert.deepEqual(await read(A), { date: today, current: 3, max: 3, completed_today: false, last_completed_date: date(-1) });
      assert.equal((await read(B)).max, 0, 'other users cannot read this history');
      await assert.rejects(role('authenticated', B, () => db.query('select public.numora_daily_streaks($1)', [A])), /does not exist/);
    });
    await t.test('today extends the run; an isolated current completion starts at one', async () => {
      await add(A, today);
      await add(B, today);
      assert.deepEqual(await read(A), { date: today, current: 4, max: 4, completed_today: true, last_completed_date: today });
      assert.equal((await read(B)).current, 1);
    });
    await t.test('older gaps, year changes and leap days contribute to max but cannot keep an expired streak active', async () => {
      for (const day of ['2020-12-29', '2020-12-30', '2020-12-31', '2021-01-01', '2021-01-02', '2021-01-03', '2021-01-04']) {
        await add(A, day); await add(C, day);
      }
      for (const day of ['2024-02-27', '2024-02-28', '2024-02-29', '2024-03-01', '2024-03-02']) await add(B, day);
      assert.equal((await read(A)).current, 4); assert.equal((await read(A)).max, 7);
      assert.deepEqual(await read(C), { date: today, current: 0, max: 7, completed_today: false, last_completed_date: '2021-01-04' });
      assert.equal((await read(B)).max, 5);
    });
    await t.test('practice, incomplete and future dates do not count or bridge gaps', async () => {
      await add(PRACTICE, date(-3));
      await add(PRACTICE, date(-2), false);
      await add(PRACTICE, date(-1), true, false);
      await add(PRACTICE, today, false);
      await add(PRACTICE, date(1));
      assert.deepEqual(await read(PRACTICE), { date: today, current: 0, max: 1, completed_today: false, last_completed_date: date(-3) });
      await add(C, date(1));
      assert.equal((await read(C)).last_completed_date, '2021-01-04');
    });
    await t.test('Daily-period results ignore database timezone, are read-only, and survive migration reapply', async () => {
      const before = (await db.query('select to_jsonb(a) as row from numora_private.daily_attempts a order by a.id')).rows;
      const expected = await read(A);
      for (const zone of ['Pacific/Kiritimati', 'Pacific/Honolulu']) {
        await db.query("select set_config('TimeZone',$1,false)", [zone]);
        assert.deepEqual(await read(A), expected);
      }
      await db.exec("set timezone='UTC'");
      assert.deepEqual((await db.query('select to_jsonb(a) as row from numora_private.daily_attempts a order by a.id')).rows, before);
      const streakFile = files.find(name => name.endsWith('_numora_daily_streaks.sql'))!;
      await db.exec(readFileSync(new URL(streakFile, directory), 'utf8'));
      await db.exec(readFileSync(new URL(files.find(name=>name.endsWith('_numora_daily_reset_ist.sql'))!,directory),'utf8'));
      assert.deepEqual(await read(A), expected);
      await assert.rejects(role('authenticated', A, () => db.query('select * from numora_private.daily_attempts')), /permission denied/);
      const funcs = (await db.query<{ schema: string; definer: boolean; config: string[] }>(`select n.nspname as schema,p.prosecdef as definer,p.proconfig as config
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace where
        (n.nspname='public' and p.proname='numora_daily_streaks') or (n.nspname='numora_private' and p.proname='daily_streaks')`)).rows;
      assert.equal(funcs.length, 2);
      for (const fn of funcs) { assert.equal(fn.definer, fn.schema === 'numora_private'); assert.ok(fn.config.includes('search_path=""')); }
    });
  } finally { await db.close(); }
});
