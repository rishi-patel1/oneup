import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { generatePuzzle } from '../../src/game/generator';

const A='81000000-0000-4000-8000-000000000001', B='81000000-0000-4000-8000-000000000002', C='81000000-0000-4000-8000-000000000003';
const puzzle=generatePuzzle({size:6,difficulty:'Medium',seed:'daily-pause-backend'});
const notes=Array.from({length:36},()=>[] as number[]);
const dir=new URL('../../supabase/migrations/',import.meta.url);
const files=readdirSync(dir).filter(f=>f.endsWith('.sql')).sort();
const sql=files.map(f=>readFileSync(new URL(f,dir),'utf8')).join('\n');
const own=readFileSync(new URL(files.find(f=>f.endsWith('_numora_daily_pauses.sql'))!,dir),'utf8');
type Attempt={id:string;started_at:string;finished_at:string|null;elapsed_ms:number|null;ranked:boolean;values:number[];notes:number[][];paused_at:string|null;paused_ms:number;timing_version:number};
type State={date:string;resets_at:string;server_now:string;attempt:Attempt|null;puzzle:unknown;daily:unknown;profile:unknown};

test('daily pause clocks persist, reject stale writes, and preserve UTC deadlines',async t=>{
 const db=new PGlite();
 try {
  await db.exec(`create role anon;create role authenticated;create role service_role;
   create schema auth;create table auth.users(id uuid primary key,is_anonymous boolean not null default false,email text,raw_user_meta_data jsonb not null default '{}');
   create table auth.identities(id uuid primary key default gen_random_uuid(),user_id uuid references auth.users(id),provider text,identity_data jsonb not null default '{}',unique(user_id,provider));
   create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;$$;
   grant usage on schema auth to anon,authenticated,service_role;
   create schema realtime;create table realtime.messages(extension text,topic text);alter table realtime.messages enable row level security;
   create function realtime.topic() returns text language sql stable as $$select current_setting('realtime.topic',true);$$;`);
  await db.exec(sql);
  for(const id of[A,B,C])await db.query('insert into auth.users(id,is_anonymous)values($1,$2)',[id,id!==A]);
  await db.query("insert into auth.identities(user_id,provider)values($1,'google')",[A]);
  const run=async<T>(role:string,id:string|null,action:()=>Promise<T>)=>{
   await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id??'']);await db.exec(`set role ${role}`);
   try{return await action();}finally{await db.exec('reset role');}
  };
  const user=<T>(id:string,action:()=>Promise<T>)=>run('authenticated',id,action);
  const query=async<T>(stmt:string,args:unknown[]=[])=> (await db.query<{data:T}>(`${stmt} as data`,args)).rows[0].data;
  const current=()=>query<State>('select public.numora_get_daily_timed()');
  const today=await query<string>("select (clock_timestamp() at time zone 'UTC')::date::text");
  await run('service_role',null,()=>query('select public.numora_ensure_daily($1,$2::jsonb)',[today,JSON.stringify(puzzle)]));
  const a=await user(A,()=>query<State>('select public.numora_start_daily_timed()'));
  const b=await user(B,()=>query<State>('select public.numora_start_daily_timed()'));
  const attemptId=a.attempt!.id;
  const pause=(desired:boolean,version:number,id=attemptId,date=today)=>query<State>('select public.numora_set_daily_paused($1,$2,$3,$4)',[date,id,desired,version]);
  const write=(version:number|null,submit=false,values=puzzle.givens)=>query<State>(`select public.${submit?'numora_submit_daily_timed':'numora_save_daily_timed'}($1,$2::int[],$3::jsonb,$4)`,[today,values,JSON.stringify(notes),version]);

  await t.test('timed DTOs retain ranked/practice status and legacy DTOs retain their exact shape',async()=>{
   assert.equal(a.attempt!.ranked,true);assert.equal(b.attempt!.ranked,false);
   assert.equal(a.attempt!.paused_at,null);assert.equal(a.attempt!.paused_ms,0);assert.equal(a.attempt!.timing_version,0);
   const legacy=await user(A,()=>query<State>('select public.numora_get_daily()'));
   assert.deepEqual(Object.keys(legacy.attempt!).sort(),['id','started_at','finished_at','elapsed_ms','ranked','values','notes'].sort());
   assert.equal(legacy.resets_at,a.resets_at);
  });
  await t.test('anonymous, missing-auth, service, and other attempts cannot pause this player',async()=>{
   for(const[role,id]of[['anon',null],['service_role',null],['authenticated',null]]as const){
    await assert.rejects(run(role,id,()=>pause(true,0)),/permission denied|Sign in/);
   }
   await assert.rejects(user(B,()=>pause(true,0)),/only your current daily attempt/);
   await assert.rejects(user(C,()=>pause(true,0)),/only your current daily attempt/);
   await assert.rejects(user(A,()=>pause(true,0,'81000000-0000-4000-8000-000000000099')),/only your current daily attempt/);
   for(const role of['authenticated','service_role','anon'])await assert.rejects(run(role,A,()=>db.query('select * from numora_private.daily_attempts')),/permission denied/);
  });
  let anchor='';
  await t.test('pause persists across reads, freezes its anchor, and current-version retries are idempotent',async()=>{
   const paused=await user(A,()=>pause(true,0));anchor=paused.attempt!.paused_at!;
   assert.ok(anchor);assert.equal(paused.attempt!.timing_version,1);
   const reloaded=await user(A,current);assert.equal(reloaded.attempt!.paused_at,anchor);assert.equal(reloaded.resets_at,a.resets_at);
   const retry=await user(A,()=>pause(true,1));assert.equal(retry.attempt!.paused_at,anchor);assert.equal(retry.attempt!.timing_version,1);
   assert.equal((await user(B,current)).attempt!.paused_at,null);
   assert.equal((await user(B,current)).attempt!.timing_version,0);
  });
  await t.test('paused and stale requests cannot save, finish, or bypass through legacy/private helpers',async()=>{
   await assert.rejects(user(A,()=>write(1)),/Resume the daily puzzle/);
   await assert.rejects(user(A,()=>write(1,true,puzzle.solution)),/Resume the daily puzzle/);
   await assert.rejects(user(A,()=>write(0)),/pause state has changed/);
   await assert.rejects(user(A,()=>pause(false,0)),/pause state has changed/);
   for(const submit of[false,true]){
    await assert.rejects(user(A,()=>query(`select public.${submit?'numora_submit_daily':'numora_save_daily'}($1,$2::int[],$3::jsonb)`,[today,puzzle.solution,JSON.stringify(notes)])),/pause state has changed/);
    await assert.rejects(user(A,()=>query('select numora_private.write_daily($1,$2::int[],$3::jsonb,$4)',[today,puzzle.solution,JSON.stringify(notes),submit])),/pause state has changed/);
   }
   assert.equal((await user(A,current)).attempt!.paused_at,anchor);
  });
  await t.test('resume accumulates server pause milliseconds and old pause-cycle retries stay rejected',async()=>{
   await db.query("update numora_private.daily_attempts set started_at=clock_timestamp()-interval '120 seconds',paused_at=clock_timestamp()-interval '10 seconds' where id=$1",[attemptId]);
   const resumed=await user(A,()=>pause(false,1));
   assert.equal(resumed.attempt!.paused_at,null);assert.equal(resumed.attempt!.timing_version,2);
   assert.ok(resumed.attempt!.paused_ms>=10000&&resumed.attempt!.paused_ms<11000);
   await user(A,()=>write(2));
   const second=await user(A,()=>pause(true,2));assert.equal(second.attempt!.timing_version,3);
   await assert.rejects(user(A,()=>pause(false,1)),/pause state has changed/);
   await assert.rejects(user(A,()=>pause(true,0)),/pause state has changed/);
   await assert.rejects(user(A,()=>write(2)),/pause state has changed/);
   await user(A,()=>pause(false,3));
   const replay=await user(A,()=>pause(false,4));assert.equal(replay.attempt!.timing_version,4);
  });
  await t.test('pauses cannot extend the UTC day or target another day',async()=>{
   for(const offset of[-1,1]){
    const date=new Date(Date.parse(today)+offset*86400000).toISOString().slice(0,10);
    await assert.rejects(user(A,()=>pause(true,4,attemptId,date)),/expired/);
   }
   const state=await user(A,current);assert.equal(state.resets_at,a.resets_at);assert.equal(state.date,today);
  });
  await t.test('first finish subtracts paused time, remains immutable, and ranks the active elapsed time',async()=>{
   const finished=await user(A,()=>write(4,true,puzzle.solution));const attempt=finished.attempt!;
   assert.ok(attempt.finished_at);assert.equal(attempt.paused_at,null);
   const wall=Date.parse(attempt.finished_at!)-Date.parse(attempt.started_at);
   assert.ok(Math.abs(wall-attempt.paused_ms-attempt.elapsed_ms!)<=1);
   assert.ok(attempt.elapsed_ms!>=109000&&attempt.elapsed_ms!<112000);
   const repeated=await user(A,()=>write(0,true,puzzle.givens));assert.deepEqual(repeated.attempt,attempt);
   await assert.rejects(user(A,()=>pause(true,4)),/already finished/);
   const board=await user(A,()=>query<{entries:{user_id:string;elapsed_ms:number}[]}>('select public.numora_daily_leaderboard($1,$2)',[today,'global']));
   assert.equal(board.entries.find(p=>p.user_id===A)!.elapsed_ms,attempt.elapsed_ms);
   const guest=await user(B,()=>pause(true,0,b.attempt!.id));assert.equal(guest.attempt!.ranked,false);
  });
  await t.test('reapplying migration history keeps pause state and cannot reopen raw access',async()=>{
   const before=await user(B,current);
   await db.exec(own);await db.exec(sql);
   const after=await user(B,current);assert.deepEqual(after.attempt,before.attempt);
   await assert.rejects(user(B,()=>query('select public.numora_save_daily($1,$2::int[],$3::jsonb)',[today,puzzle.givens,JSON.stringify(notes)])),/pause state has changed/);
   const acl=await db.query<{definer:boolean;path:string[]}>('select prosecdef as definer,proconfig as path from pg_proc where oid=$1::regprocedure',['public.numora_set_daily_paused(date,uuid,boolean,bigint)']);
   assert.equal(acl.rows[0].definer,false);assert.ok(acl.rows[0].path.includes('search_path=""'));
  });
 } finally {await db.close();}
});
