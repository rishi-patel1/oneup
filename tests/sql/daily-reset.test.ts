import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { generatePuzzle } from '../../src/game/generator';

const directory = new URL('../../supabase/migrations/', import.meta.url);
const files = readdirSync(directory).filter(name => name.endsWith('.sql')).sort();
const migrations = files.map(name => readFileSync(new URL(name, directory), 'utf8')).join('\n');
const resetMigration = readFileSync(new URL(files.find(name => name.endsWith('_numora_daily_reset_ist.sql'))!, directory), 'utf8');
type State = {date:string;resets_at:string;server_now:string;attempt:null|{id:string;started_at:string;finished_at:string|null;elapsed_ms:number|null;values:number[];paused_at:string|null;paused_ms:number;timing_version:number}};

test('daily reset uses 09:30 IST consistently without replacing attempts or history', async t => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon;create role authenticated;create role service_role;
      create schema auth;create table auth.users(id uuid primary key,is_anonymous boolean not null default false,email text,raw_user_meta_data jsonb not null default '{}');
      create table auth.identities(id uuid primary key default gen_random_uuid(),user_id uuid references auth.users(id),provider text,identity_data jsonb not null default '{}',unique(user_id,provider));
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;$$;
      grant usage on schema auth to anon,authenticated,service_role;
      create schema realtime;create table realtime.messages(extension text,topic text);alter table realtime.messages enable row level security;
      create function realtime.topic() returns text language sql stable as $$select current_setting('realtime.topic',true);$$;`);
    await db.exec(migrations);
    const query = async <T>(sql:string,args:unknown[]=[]) => (await db.query<{data:T}>(`${sql} as data`,args)).rows[0].data;
    const role = async <T>(name:string,id:string|null,work:()=>Promise<T>):Promise<T> => {
      await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id??'']);await db.exec(`set role ${name}`);
      try {return await work();} finally {await db.exec('reset role');}
    };
    const user = randomUUID();
    await db.query('insert into auth.users(id) values($1)',[user]);
    await db.query("insert into auth.identities(user_id,provider) values($1,'google')",[user]);
    const current = () => role('authenticated',user,()=>query<State>('select public.numora_get_daily_timed()'));

    await t.test('the server switches at exactly 04:00 UTC, including leap days and year changes in every session timezone',async()=>{
      const cases = [
        ['2026-11-29T03:59:59.999999Z','2026-11-28','2026-11-29T04:00:00.000Z'],
        ['2026-11-29T04:00:00Z','2026-11-29','2026-11-30T04:00:00.000Z'],
        ['2026-11-29T23:59:59Z','2026-11-29','2026-11-30T04:00:00.000Z'],
        ['2026-11-30T00:00:00Z','2026-11-29','2026-11-30T04:00:00.000Z'],
        ['2027-01-01T03:59:59Z','2026-12-31','2027-01-01T04:00:00.000Z'],
        ['2027-01-01T04:00:00Z','2027-01-01','2027-01-02T04:00:00.000Z'],
        ['2028-03-01T03:59:59Z','2028-02-29','2028-03-01T04:00:00.000Z'],
      ];
      for(const zone of ['UTC','Asia/Kolkata','Pacific/Honolulu','Pacific/Kiritimati']) {
        await db.query("select set_config('TimeZone',$1,false)",[zone]);
        for(const [now,day,reset] of cases) {
          const actual=await query<{day:string;reset:string}>('select jsonb_build_object(\'day\',numora_private.daily_day($1::timestamptz),\'reset\',numora_private.daily_reset_at(numora_private.daily_day($1::timestamptz)))',[now]);
          assert.equal(actual.day,day);assert.equal(new Date(actual.reset).toISOString(),reset);
        }
      }
      await db.exec("set timezone='UTC'");
    });

    await t.test('daily metadata, legacy reads, default leaderboard and streaks agree on one live period',async()=>{
      const before=await current();
      const day=await query<string>('select numora_private.daily_day(clock_timestamp())::text');
      const next=new Date(Date.parse(day)+86400000).toISOString().slice(0,10);
      assert.equal(before.date,day);assert.equal(new Date(before.resets_at).toISOString(),`${next}T04:00:00.000Z`);
      const legacy=await role('authenticated',user,()=>query<State>('select public.numora_get_daily()'));
      assert.equal(legacy.date,day);assert.equal(legacy.resets_at,before.resets_at);
      const board=await role('authenticated',user,()=>query<{date:string}>('select public.numora_daily_leaderboard()'));
      const streaks=await role('authenticated',user,()=>query<{date:string}>('select public.numora_daily_streaks()'));
      assert.equal(board.date,day);assert.equal(streaks.date,day);
      for(const name of ['ensure_daily','get_daily_timed','start_daily','write_daily_timed','set_daily_paused','daily_leaderboard','daily_streaks']) {
        const definitions=(await db.query<{definition:string}>(`select pg_get_functiondef(oid) as definition from pg_proc where pronamespace='numora_private'::regnamespace and proname=$1`,[name])).rows;
        assert.equal(definitions.length,1);assert.match(definitions[0].definition,/numora_private\.daily_day\(/);
        assert.doesNotMatch(definitions[0].definition,/at time zone 'UTC'\)::date/);
      }
    });

    await t.test('existing current-day attempts started before 04:00 retain their board, timer and finish eligibility',async()=>{
      const day=(await current()).date;
      const puzzle=generatePuzzle({size:6,difficulty:'Medium',seed:'daily-ist-legacy-attempt'});
      await role('service_role',null,()=>query('select public.numora_ensure_daily($1,$2::jsonb)',[day,JSON.stringify(puzzle)]));
      const attempt=await role('authenticated',user,()=>query<State>('select public.numora_start_daily_timed()'));
      const started=`${day}T00:30:00Z`;
      await db.query('update numora_private.daily_attempts set started_at=$1 where id=$2',[started,attempt.attempt!.id]);
      const read=await current();
      assert.equal(Date.parse(read.attempt!.started_at),Date.parse(started));assert.deepEqual(read.attempt!.values,puzzle.givens);
      const notes=JSON.stringify(Array.from({length:36},()=>[]));
      const finished=await role('authenticated',user,()=>query<State>('select public.numora_submit_daily_timed($1,$2::int[],$3::jsonb,$4)',[day,puzzle.solution,notes,0]));
      assert.equal(finished.attempt!.id,attempt.attempt!.id);assert.equal(Date.parse(finished.attempt!.started_at),Date.parse(started));assert.ok(finished.attempt!.finished_at);
      const before=(await db.query('select to_jsonb(a) as data from numora_private.daily_attempts a')).rows;
      await db.exec(resetMigration);
      assert.deepEqual((await db.query('select to_jsonb(a) as data from numora_private.daily_attempts a')).rows,before);
      assert.deepEqual((await current()).attempt,finished.attempt);
      const streaks=await role('authenticated',user,()=>query<{completed_today:boolean}>('select public.numora_daily_streaks()'));
      assert.equal(streaks.completed_today,true);
    });

    await t.test('schedule helpers stay private and public wrappers retain invoker-only access',async()=>{
      for(const name of ['anon','authenticated','service_role']) {
        await assert.rejects(role(name,user,()=>query('select numora_private.daily_day(clock_timestamp())')),/permission denied/);
        await assert.rejects(role(name,user,()=>query("select numora_private.daily_reset_at('2026-11-29')")),/permission denied/);
      }
      for(const name of ['numora_get_daily','numora_get_daily_timed','numora_start_daily','numora_start_daily_timed','numora_daily_leaderboard','numora_daily_streaks']) {
        const functions=(await db.query<{definer:boolean}>(`select prosecdef as definer from pg_proc where pronamespace='public'::regnamespace and proname=$1`,[name])).rows;
        assert.ok(functions.length);assert.ok(functions.every(fn=>!fn.definer));
      }
    });
  } finally {await db.close();}
});
