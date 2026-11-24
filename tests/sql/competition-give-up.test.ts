import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { generatePuzzle } from '../../src/game/generator';

const HOST='82000000-0000-4000-8000-000000000001';
const GUEST='82000000-0000-4000-8000-000000000002';
const FINISHER='82000000-0000-4000-8000-000000000003';
const OUTSIDER='82000000-0000-4000-8000-000000000004';
const board=generatePuzzle({size:5,difficulty:'Easy',seed:'give-up-contract'});
const notes=Array.from({length:25},()=>[] as number[]);
const directory=new URL('../../supabase/migrations/',import.meta.url);
const migrations=readdirSync(directory).filter(name=>name.endsWith('.sql')).sort()
 .map(name=>readFileSync(new URL(name,directory),'utf8')).join('\n');
const giveUpMigration=readFileSync(new URL(readdirSync(directory).find(name=>name.endsWith('_numora_competition_give_up.sql'))!,directory),'utf8');
type State={room:{id:string;code:string;round_id:string;status:string;starts_at:string|null;paused_at:string|null;resumes_at:string|null;pause_id:string|null;pause_version:number};players:{user_id:string;given_up_at:string|null;finished_at:string|null;elapsed_ms:number|null;resume_ready:boolean;ready:boolean;progress_count:number}[];self:{values:number[];notes:number[][]}|null;server_now:string};

test('giving up records an unscored terminal result, releases pause blockers and permits same-roster rematches',async t=>{
 const db=new PGlite();
 try {
  await db.exec(`create role anon;create role authenticated;create role service_role;
   create schema auth;create table auth.users(id uuid primary key);
   create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;$$;
   grant usage on schema auth to anon,authenticated,service_role;
   create schema realtime;create table realtime.messages(extension text,topic text);alter table realtime.messages enable row level security;
   create function realtime.topic() returns text language sql stable as $$select current_setting('realtime.topic',true);$$;`);
  await db.exec(migrations);
  for(const id of [HOST,GUEST,FINISHER,OUTSIDER])await db.query('insert into auth.users(id) values($1)',[id]);
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
  let state=await read(),round=state.room.round_id;
  const giveUp=(id:string,r:string|null=round)=>user(id,()=>rpc('public.numora_give_up_room',[code,r]));
  const ready=(id:string)=>user(id,()=>rpc('public.numora_set_ready',[code,true,round]));
  const release=()=>db.query("update public.numora_rooms set starts_at=clock_timestamp()-interval '60 seconds' where code=$1",[code]);
  const start=async()=>{for(const id of [HOST,GUEST,FINISHER])await ready(id);await user(HOST,()=>rpc('public.numora_start_room',[code,round]));};
  const finish=async(id:string)=>{const latest=await read(id);return user(id,()=>rpc('public.numora_submit_solution',[code,board.solution,JSON.stringify(notes),round,latest.room.pause_version],['','::int[]','::jsonb']));};
  const pause=async()=>{const latest=await read();return user(HOST,()=>rpc('public.numora_pause_room',[code,round,latest.room.pause_version]));};
  const vote=(id:string,ready=true)=>user(id,()=>rpc('public.numora_set_resume_ready',[code,round,state.room.pause_id,ready]));
  const rematch=()=>asRole('service_role',null,()=>rpc<string>('public.numora_rematch_room',[HOST,code,round,JSON.stringify(board)],['','','','::jsonb']));

  await t.test('only signed-in room members can give up after the shared start, with an explicit current round',async()=>{
   for(const id of [GUEST,FINISHER])await user(id,()=>rpc('public.numora_join_room',[code,id===GUEST?'Guest':'Finisher']));
   for(const [role,id] of [['anon',null],['authenticated',null],['authenticated',OUTSIDER],['service_role',null]] as const){
    await assert.rejects(asRole(role,id,()=>rpc('public.numora_give_up_room',[code,round])),/permission denied|Sign in|Join this room/);
   }
   await assert.rejects(giveUp(GUEST),/running/);
   await assert.rejects(giveUp(GUEST,null),/round has changed/);
   await assert.rejects(giveUp(GUEST,OUTSIDER),/round has changed/);
   await start();await assert.rejects(giveUp(GUEST),/running/);await release();
   await assert.rejects(user(GUEST,()=>db.query('update public.numora_players set given_up_at=clock_timestamp() where user_id=$1',[GUEST])),/permission denied/);
  });
  await t.test('give-up preserves the private draft, is idempotent, has no finish score, and locks future board writes',async()=>{
   const draft=[...board.givens];const index=draft.findIndex(value=>value===0);draft[index]=board.solution[index];
   await user(GUEST,()=>rpc('public.numora_save_progress',[code,draft,JSON.stringify(notes),round,0],['','::int[]','::jsonb']));
   const before=await read(GUEST);state=await giveUp(GUEST);
   const givenUp=state.players.find(p=>p.user_id===GUEST)!;
   assert.ok(givenUp.given_up_at);assert.equal(givenUp.finished_at,null);assert.equal(givenUp.elapsed_ms,null);
   assert.deepEqual(state.self,before.self);assert.equal(state.room.status,'racing');assert.equal(givenUp.progress_count,1);
   const repeat=await giveUp(GUEST);assert.deepEqual(repeat.players.find(p=>p.user_id===GUEST),givenUp);
   await user(GUEST,()=>rpc('public.numora_save_progress',[code,board.solution,JSON.stringify(notes),round,0],['','::int[]','::jsonb']));
   const attemptedFinish=await finish(GUEST);assert.deepEqual(attemptedFinish.players.find(p=>p.user_id===GUEST),givenUp);
   assert.deepEqual((await read(GUEST)).self,before.self);
   await assert.rejects(user(GUEST,()=>rpc('public.numora_pause_room',[code,round,0])),/active unfinished/);
   const watched=await user(GUEST,()=>rpc<Record<string,unknown>>('public.numora_spectate_player',[code,HOST,round,0]));
   assert.deepEqual(Object.keys(watched).sort(),['room_id','player_id','values','notes','updated_at','server_now'].sort());
   const finished=await finish(FINISHER),finisher=finished.players.find(p=>p.user_id===FINISHER)!;
   assert.deepEqual((await giveUp(FINISHER)).players.find(p=>p.user_id===FINISHER),finisher);
   await assert.rejects(rematch(),/every player has finished/);
   state=await finish(HOST);assert.equal(state.room.status,'finished');
  });
  await t.test('mixed solved/given-up standings archive correctly and the same roster starts fresh',async()=>{
   const firstRound=round;await rematch();state=await read();round=state.room.round_id;
   assert.notEqual(round,firstRound);assert.equal(state.room.status,'lobby');assert.equal(state.players.length,3);
   assert.ok(state.players.every(p=>p.given_up_at===null&&p.finished_at===null&&p.elapsed_ms===null&&!p.ready));
   assert.equal(state.self,null);
   assert.deepEqual((await db.query<{values:number[]}>('select values from numora_private.progress where room_id=$1 and user_id=$2',[state.room.id,HOST])).rows[0].values,board.givens);
   const archived=(await db.query<{results:{user_id:string;given_up_at:string|null;finished_at:string|null;elapsed_ms:number|null}[]}>('select results from numora_private.room_round_results where round_id=$1',[firstRound])).rows[0].results;
   assert.equal(archived.at(-1)?.user_id,GUEST);assert.ok(archived.at(-1)?.given_up_at);
   assert.equal(archived.at(-1)?.finished_at,null);assert.equal(archived.at(-1)?.elapsed_ms,null);
   await assert.rejects(giveUp(HOST,firstRound),/round has changed/);
   await assert.rejects(giveUp(HOST),/running/);
  });
  await t.test('a paused solver can give up, releasing their vote without requiring finished or given-up players',async()=>{
   await start();await release();await finish(FINISHER);state=await pause();state=await vote(HOST);
   assert.equal(state.room.resumes_at,null);
   state=await giveUp(GUEST);assert.ok(state.room.resumes_at);
   assert.ok(Math.abs(Date.parse(state.room.resumes_at!)-Date.parse(state.server_now)-3000)<100);
   const countdown={...state.room};
   for(const id of [GUEST,FINISHER]){
    state=await vote(id,false);assert.deepEqual(state.room,countdown);
    await user(id,()=>rpc('public.numora_leave_room',[code,round]));
    state=await user(id,()=>rpc('public.numora_join_room',[code,id===GUEST?'Guest':'Finisher']));assert.deepEqual(state.room,countdown);
   }
   // Replaying the new migration must preserve both the outcome and the pending countdown.
   await db.exec(giveUpMigration);assert.deepEqual((await read()).room,countdown);
   state=await giveUp(HOST);assert.equal(state.room.status,'finished');assert.equal(state.room.paused_at,null);
   assert.equal(state.room.resumes_at,null);assert.equal(state.room.pause_id,null);
   assert.ok(state.players.every(p=>p.finished_at!==null||p.given_up_at!==null));
  });
  await t.test('an all-given-up paused round also finishes immediately and archives without fabricated solved scores',async()=>{
   await rematch();state=await read();round=state.room.round_id;await start();await release();state=await pause();
   for(const id of [HOST,GUEST,FINISHER])state=await giveUp(id);
   assert.equal(state.room.status,'finished');assert.equal(state.room.paused_at,null);
   assert.ok(state.players.every(p=>p.given_up_at!==null&&p.finished_at===null&&p.elapsed_ms===null));
   const oldRound=round;await rematch();state=await read();round=state.room.round_id;
   const archived=(await db.query<{finished_at:string;results:{given_up_at:string|null;elapsed_ms:number|null}[]}>('select finished_at,results from numora_private.room_round_results where round_id=$1',[oldRound])).rows[0];
   assert.ok(archived.finished_at);assert.ok(archived.results.every(p=>p.given_up_at&&p.elapsed_ms===null));
   assert.ok(state.players.every(p=>p.given_up_at===null));
   await assert.rejects(giveUp(HOST,oldRound),/round has changed/);
  });
 }finally{await db.close();}
});
