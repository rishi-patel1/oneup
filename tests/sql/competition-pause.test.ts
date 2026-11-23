import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { generatePuzzle } from '../../src/game/generator';

const HOST='81000000-0000-4000-8000-000000000001';
const GUEST='81000000-0000-4000-8000-000000000002';
const FINISHED='81000000-0000-4000-8000-000000000003';
const OUTSIDER='81000000-0000-4000-8000-000000000004';
const board=generatePuzzle({size:5,difficulty:'Easy',seed:'shared-pause-first'});
const nextBoard=generatePuzzle({size:5,difficulty:'Easy',seed:'shared-pause-next'});
const notes=Array.from({length:25},()=>[] as number[]);
const directory=new URL('../../supabase/migrations/',import.meta.url);
const files=readdirSync(directory).filter(name=>name.endsWith('.sql')).sort();
const migration=files.map(name=>readFileSync(new URL(name,directory),'utf8')).join('\n');
const pauseMigration=readFileSync(new URL(files.find(name=>name.endsWith('_numora_competition_pauses.sql'))!,directory),'utf8');
type State={room:{id:string;code:string;round_id:string;status:string;starts_at:string|null;paused_at:string|null;resumes_at:string|null;paused_ms:number;pause_id:string|null;pause_version:number};players:{user_id:string;active:boolean;resume_ready:boolean;finished_at:string|null;elapsed_ms:number|null}[];self:{values:number[];notes:number[][]}|null;puzzle:unknown;server_now:string};

test('competition pauses require unanimous resume, exclude paused time, and isolate state transitions',async t=>{
 const db=new PGlite();
 try {
  await db.exec(`create role anon;create role authenticated;create role service_role;
   create schema auth;create table auth.users(id uuid primary key);
   create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;$$;
   grant usage on schema auth to anon,authenticated,service_role;
   create schema realtime;create table realtime.messages(extension text,topic text);alter table realtime.messages enable row level security;
   create function realtime.topic() returns text language sql stable as $$select current_setting('realtime.topic',true);$$;`);
  await db.exec(migration);
  for(const id of [HOST,GUEST,FINISHED,OUTSIDER])await db.query('insert into auth.users(id) values($1)',[id]);
  const asRole=async<T>(role:string,id:string|null,operation:()=>Promise<T>):Promise<T>=>{
   await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id??'']);await db.exec(`set role ${role}`);
   try{return await operation();}finally{await db.exec('reset role');}
  };
  const user=<T>(id:string,operation:()=>Promise<T>)=>asRole('authenticated',id,operation);
  const rpc=async<T=State>(name:string,args:unknown[]=[],casts:string[]=[])=>{
   const params=args.map((_,i)=>`$${i+1}${casts[i]??''}`).join(',');
   return (await db.query<{data:T}>(`select ${name}(${params}) as data`,args)).rows[0].data;
  };
  const code=await asRole('service_role',null,()=>rpc<string>('public.numora_create_room',[HOST,'Host',JSON.stringify(board)],['','','::jsonb']));
  const read=(id=HOST)=>user(id,()=>rpc('public.numora_get_room',[code]));
  let state=await read(),round=state.room.round_id,version=0,pauseId='';
  const pause=(id=HOST,v=version,r=round)=>user(id,()=>rpc('public.numora_pause_room',[code,r,v]));
  const vote=(id:string,ready=true,p=pauseId,r=round)=>user(id,()=>rpc('public.numora_set_resume_ready',[code,r,p,ready]));
  const ready=(id:string)=>user(id,()=>rpc('public.numora_set_ready',[code,true,round]));
  const save=(id:string,v=version)=>user(id,()=>rpc('public.numora_save_progress',[code,board.givens,JSON.stringify(notes),round,v],['','::int[]','::jsonb']));
  const finish=(id:string,v=version)=>user(id,()=>rpc('public.numora_submit_solution',[code,board.solution,JSON.stringify(notes),round,v],['','::int[]','::jsonb']));
  const release=()=>db.query("update public.numora_rooms set starts_at=clock_timestamp()-interval '60 seconds' where code=$1",[code]);
  const endResume=()=>db.query("update public.numora_rooms set paused_at=clock_timestamp()-interval '20 seconds',resumes_at=clock_timestamp()-interval '1 second' where code=$1",[code]);
  let originalFinish=0;

  await t.test('membership and active race gates reject unauthorized pauses and privileged helper calls',async()=>{
   for(const id of [GUEST,FINISHED])await user(id,()=>rpc('public.numora_join_room',[code,id===GUEST?'Guest':'Finisher']));
   for(const [role,id] of [['anon',null],['authenticated',null],['authenticated',OUTSIDER],['service_role',null]] as const){
    await assert.rejects(asRole(role,id,()=>rpc('public.numora_pause_room',[code,round,0])),/permission denied|Sign in|active unfinished/);
   }
   await assert.rejects(user(HOST,()=>rpc('numora_private.settle_room_pause',[state.room.id])),/permission denied/);
   await assert.rejects(user(HOST,()=>rpc('numora_private.reconcile_room_resume',[state.room.id])),/permission denied/);
   await assert.rejects(pause(),/running/);
   for(const id of [HOST,GUEST,FINISHED])await ready(id);
   await user(HOST,()=>rpc('public.numora_start_room',[code,round]));
   await assert.rejects(pause(),/running/);
   await release();
   const finished=await finish(FINISHED);originalFinish=finished.players.find(p=>p.user_id===FINISHED)!.elapsed_ms!;
   await assert.rejects(pause(FINISHED),/active unfinished/);
  });
  await t.test('one participant pauses every board, freezes time, and blocks all progress and spectator routes',async()=>{
   const before=await read();state=await pause();version=state.room.pause_version;pauseId=state.room.pause_id!;
   assert.ok(state.room.paused_at);assert.equal(state.room.resumes_at,null);assert.equal(state.room.paused_ms,0);
   assert.ok(state.players.every(p=>!p.resume_ready));assert.deepEqual(state.self,before.self);
   const peer=await read(GUEST);assert.equal(peer.room.pause_id,pauseId);assert.equal(peer.room.paused_at,state.room.paused_at);
   const duplicate=await pause(HOST,version);assert.equal(duplicate.room.pause_version,version);assert.equal(duplicate.room.pause_id,pauseId);
   await assert.rejects(pause(HOST,0),/pause state has changed/);
   await assert.rejects(save(HOST),/room is paused/);await assert.rejects(finish(GUEST),/room is paused/);
   await assert.rejects(user(HOST,()=>rpc('public.numora_save_progress',[code,board.givens,JSON.stringify(notes),round],['','::int[]','::jsonb'])),/pause state has changed/);
   await assert.rejects(user(FINISHED,()=>rpc('public.numora_spectate_player',[code,GUEST,round,version])),/room is paused/);
   await assert.rejects(vote(OUTSIDER),/Join this room/);
   await assert.rejects(vote(HOST,true,OUTSIDER),/pause state has changed/);
  });
  await t.test('all active members including finishers must resume; the final vote schedules exactly three seconds',async()=>{
   state=await vote(HOST);assert.equal(state.room.resumes_at,null);
   state=await vote(GUEST);assert.equal(state.room.resumes_at,null);
   assert.equal(state.players.find(p=>p.user_id===FINISHED)?.resume_ready,false);
   state=await vote(FINISHED);version=state.room.pause_version;
   assert.ok(state.room.resumes_at);assert.ok(Math.abs(Date.parse(state.room.resumes_at!)-Date.parse(state.server_now)-3000)<100);
   const repeat=await vote(FINISHED);assert.equal(repeat.room.resumes_at,state.room.resumes_at);assert.equal(repeat.room.pause_version,version);
   await assert.rejects(save(HOST),/room is paused/);await assert.rejects(finish(GUEST),/room is paused/);
   const cancelled=await vote(FINISHED,false);assert.equal(cancelled.room.resumes_at,null);
   assert.ok(cancelled.room.pause_version>version);
   state=await vote(FINISHED);version=state.room.pause_version;
   assert.ok(state.room.resumes_at);assert.ok(Date.parse(state.room.resumes_at!)>=Date.parse(repeat.room.resumes_at!));
  });
  await t.test('countdown completion adds paused duration once and legacy or pre-pause writes stay rejected',async()=>{
   await endResume();state=await read();assert.equal(state.room.paused_at,null);assert.equal(state.room.resumes_at,null);assert.equal(state.room.pause_id,null);
   assert.ok(state.room.paused_ms>=18900&&state.room.paused_ms<=19100);assert.equal(state.room.pause_version,version);
   assert.ok(state.players.every(p=>!p.resume_ready));
   const again=await read();assert.equal(again.room.paused_ms,state.room.paused_ms);
   await save(HOST);await assert.rejects(save(HOST,0),/pause state has changed/);
   await assert.rejects(user(HOST,()=>rpc('public.numora_submit_solution',[code,board.solution,JSON.stringify(notes),round],['','::int[]','::jsonb'])),/pause state has changed/);
   await assert.rejects(vote(HOST),/pause state has changed/);
  });
  await t.test('later pause cycles reject old votes; explicit leave excludes a voter and rejoin cancels a pending resume',async()=>{
   const oldId=pauseId;state=await pause();version=state.room.pause_version;pauseId=state.room.pause_id!;
   assert.notEqual(pauseId,oldId);await assert.rejects(vote(HOST,true,oldId),/pause state has changed/);
   await vote(HOST);state=await vote(GUEST);assert.equal(state.room.resumes_at,null);
   // Reading/syncing a disconnected member never silently removes their vote requirement.
   assert.equal((await read()).players.find(p=>p.user_id===FINISHED)?.active,true);
   await user(FINISHED,()=>rpc('public.numora_leave_room',[code,round]));state=await read();assert.ok(state.room.resumes_at);
   assert.equal(state.players.find(p=>p.user_id===FINISHED)?.active,false);
   await assert.rejects(vote(FINISHED),/Join this room/);
   const oldMembershipCycle=pauseId;
   state=await user(FINISHED,()=>rpc('public.numora_join_room',[code,'Finisher']));assert.equal(state.room.resumes_at,null);
   assert.ok(state.players.every(p=>!p.resume_ready));assert.notEqual(state.room.pause_id,oldMembershipCycle);
   pauseId=state.room.pause_id!;
   await assert.rejects(vote(FINISHED,true,oldMembershipCycle),/pause state has changed/);
   for(const id of [HOST,GUEST,FINISHED])state=await vote(id);
   version=state.room.pause_version;
   const originalPauseAt=state.room.paused_at;
   state=await pause(GUEST,version);version=state.room.pause_version;
   assert.equal(state.room.paused_at,originalPauseAt);assert.equal(state.room.resumes_at,null);assert.notEqual(state.room.pause_id,pauseId);
   pauseId=state.room.pause_id!;assert.ok(state.players.every(p=>!p.resume_ready));
   for(const id of [HOST,GUEST,FINISHED])state=await vote(id);
   version=state.room.pause_version;await endResume();state=await read();
   assert.ok(state.room.paused_ms>=37800&&state.room.paused_ms<=38200);
  });
  await t.test('official finish times subtract pauses and prior finishes remain immutable',async()=>{
   state=await finish(HOST);
   const host=state.players.find(p=>p.user_id===HOST)!;
   const expected=Date.parse(host.finished_at!)-Date.parse(state.room.starts_at!)-state.room.paused_ms;
   assert.ok(Math.abs(host.elapsed_ms!-expected)<=1);
   assert.ok(host.elapsed_ms!>=20000&&host.elapsed_ms!<30000);
   assert.equal(state.players.find(p=>p.user_id===FINISHED)?.elapsed_ms,originalFinish);
   const repeat=await finish(HOST);assert.equal(repeat.players.find(p=>p.user_id===HOST)?.elapsed_ms,host.elapsed_ms);
   state=await finish(GUEST);assert.equal(state.room.status,'finished');await assert.rejects(pause(),/active unfinished/);
  });
  await t.test('rematches reset all pause metadata and stale controls cannot affect the next round',async()=>{
   const oldRound=round,oldPause=pauseId;
   await asRole('service_role',null,()=>rpc<string>('public.numora_rematch_room',[HOST,code,round,JSON.stringify(nextBoard)],['','','','::jsonb']));
   state=await read();round=state.room.round_id;version=0;
   assert.notEqual(round,oldRound);assert.equal(state.room.pause_id,null);assert.equal(state.room.paused_at,null);assert.equal(state.room.resumes_at,null);
   assert.equal(state.room.paused_ms,0);assert.equal(state.room.pause_version,0);assert.ok(state.players.every(p=>!p.resume_ready));
   await assert.rejects(pause(HOST,0,oldRound),/round has changed/);await assert.rejects(vote(HOST,true,oldPause,oldRound),/round has changed/);
  });
  await t.test('migration replay preserves an ongoing pause and guarded RPC permissions',async()=>{
   for(const id of [HOST,GUEST,FINISHED])await ready(id);
   await user(HOST,()=>rpc('public.numora_start_room',[code,round]));await release();
   state=await pause(HOST,0);version=state.room.pause_version;pauseId=state.room.pause_id!;
   const before={...state.room};
   await db.exec(pauseMigration);assert.deepEqual((await read()).room,before);
   await db.exec(migration);assert.deepEqual((await read()).room,before);
   await assert.rejects(user(HOST,()=>db.query('update public.numora_rooms set paused_ms=0 where code=$1',[code])),/permission denied/);
   await assert.rejects(user(HOST,()=>rpc('numora_private.settle_room_pause',[state.room.id])),/permission denied/);
   await assert.rejects(user(HOST,()=>rpc('public.numora_save_progress',[code,nextBoard.givens,JSON.stringify(notes),round],['','::int[]','::jsonb'])),/pause state has changed/);
  });
 }finally{await db.close();}
});
