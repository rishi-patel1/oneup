import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { generatePuzzle } from '../../src/game/generator';

const HOST='83000000-0000-4000-8000-000000000001';
const GUEST='83000000-0000-4000-8000-000000000002';
const THIRD='83000000-0000-4000-8000-000000000003';
const OUTSIDER='83000000-0000-4000-8000-000000000004';
const players=[HOST,GUEST,THIRD];
const first=generatePuzzle({size:5,difficulty:'Easy',seed:'grid-vote-first'});
const large=generatePuzzle({size:8,difficulty:'Hard',seed:'grid-vote-host-override'});
const medium=generatePuzzle({size:6,difficulty:'Medium',seed:'grid-vote-next-round'});
const legacy=generatePuzzle({size:6,difficulty:'Medium',seed:'grid-vote-legacy-rematch'});
const directory=new URL('../../supabase/migrations/',import.meta.url);
const files=readdirSync(directory).filter(name=>name.endsWith('.sql')).sort();
const migrations=files.map(name=>readFileSync(new URL(name,directory),'utf8')).join('\n');
const votingMigration=readFileSync(new URL(files.find(name=>name.endsWith('_numora_grid_voting.sql'))!,directory),'utf8');
type State={room:{id:string;round_id:string;code:string;host_id:string;status:string;size:number;difficulty:string;starts_at:string|null;paused_at:string|null;resumes_at:string|null;paused_ms:number;pause_id:string|null;pause_version:number};players:{user_id:string;nickname:string;active:boolean;ready:boolean;resume_ready:boolean;progress_count:number;finished_at:string|null;given_up_at:string|null;elapsed_ms:number|null;grid_vote:{size:number;difficulty:string}|null}[];self:{values:number[];notes:number[][]}|null;puzzle:unknown;server_now:string};

test('grid votes are scoped advisory choices and only the host can apply a fresh grid',async t=>{
 const db=new PGlite();
 try{
  await db.exec(`create role anon;create role authenticated;create role service_role;
   create schema auth;create table auth.users(id uuid primary key);
   create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;$$;
   grant usage on schema auth to anon,authenticated,service_role;
   create schema realtime;create table realtime.messages(extension text,topic text);alter table realtime.messages enable row level security;
   create function realtime.topic() returns text language sql stable as $$select current_setting('realtime.topic',true);$$;`);
  await db.exec(migrations);
  for(const id of [...players,OUTSIDER])await db.query('insert into auth.users(id) values($1)',[id]);
  const role=async<T>(name:string,id:string|null,operation:()=>Promise<T>):Promise<T>=>{
   await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id??'']);await db.exec(`set role ${name}`);
   try{return await operation();}finally{await db.exec('reset role');}
  };
  const user=<T>(id:string,operation:()=>Promise<T>)=>role('authenticated',id,operation);
  const rpc=async<T=State>(name:string,args:unknown[]=[],casts:string[]=[])=>{
   const params=args.map((_,i)=>`$${i+1}${casts[i]??''}`).join(',');
   return(await db.query<{data:T}>(`select ${name}(${params}) as data`,args)).rows[0].data;
  };
  const code=await role('service_role',null,()=>rpc<string>('public.numora_create_room',[HOST,'Host',JSON.stringify(first)],['','','::jsonb']));
  const read=(id=HOST)=>user(id,()=>rpc('public.numora_get_room',[code]));
  let state=await read(),round=state.room.round_id;
  const vote=(id:string,size:number|null,difficulty:string|null,phase:string|null='lobby',token:string|null=round)=>user(id,()=>rpc('public.numora_vote_grid',[code,token,phase,size,difficulty]));
  const prepare=(board:unknown,phase:string|null='lobby',token:string|null=round,host:string|null=HOST)=>role('service_role',null,()=>rpc<string>('public.numora_prepare_room_grid',[host,code,token,phase,JSON.stringify(board)],['','','','','::jsonb']));
  const ready=(id:string,token=round)=>user(id,()=>rpc('public.numora_set_ready',[code,true,token]));
  const start=async()=>{for(const id of players)await ready(id);return user(HOST,()=>rpc('public.numora_start_room',[code,round]));};
  const release=()=>db.query("update public.numora_rooms set starts_at=clock_timestamp()-interval '20 seconds' where code=$1",[code]);
  const giveUp=(id:string)=>user(id,()=>rpc('public.numora_give_up_room',[code,round]));
  const privateProgress=()=>db.query<{values:number[];notes:number[][]}>('select values,notes from numora_private.progress where room_id=$1 order by user_id',[state.room.id]);
  const withoutTime=(snapshot:State)=>{const {server_now:_,...data}=snapshot;return data;};

  await t.test('vote and final-choice endpoints enforce identity, membership, role and explicit phase/round',async()=>{
   await user(GUEST,()=>rpc('public.numora_join_room',[code,'Guest']));await user(THIRD,()=>rpc('public.numora_join_room',[code,'Third']));
   for(const [name,id] of [['anon',null],['authenticated',null],['authenticated',OUTSIDER],['service_role',null]] as const){
    await assert.rejects(role(name,id,()=>rpc('public.numora_vote_grid',[code,round,'lobby',8,'Hard'])),/permission denied|Sign in|Join this room/);
   }
   for(const [name,id] of [['anon',null],['authenticated',HOST],['authenticated',GUEST],['authenticated',OUTSIDER]] as const){
    for(const schema of ['public','numora_private'])await assert.rejects(role(name,id,()=>rpc(`${schema}.${schema==='public'?'numora_':''}prepare_room_grid`,[HOST,code,round,'lobby',JSON.stringify(large)],['','','','','::jsonb'])),/permission denied/);
   }
   await assert.rejects(prepare(large,'lobby',round,GUEST),/Only the room host/);
   await assert.rejects(prepare(large,'lobby',null),/round has changed/);
   await assert.rejects(vote(HOST,8,'Hard','lobby',null),/round has changed/);
   await assert.rejects(vote(HOST,8,'Hard','lobby',OUTSIDER),/round has changed/);
   await assert.rejects(vote(HOST,8,'Hard','finished'),/different phase/);
   await assert.rejects(vote(HOST,8,'Hard',null),/different phase/);
   await assert.rejects(prepare(large,'finished'),/different phase/);
   await assert.rejects(prepare(large,null),/different phase/);
   await db.query('update public.numora_players set active=false where room_id=$1 and user_id=$2',[state.room.id,GUEST]);
   await assert.rejects(vote(GUEST,8,'Hard'),/Join this room/);
   await db.query('update public.numora_players set active=true where room_id=$1 and user_id=$2',[state.room.id,GUEST]);
   await assert.rejects(user(HOST,()=>db.query('update public.numora_players set grid_vote_size=8 where user_id=$1',[HOST])),/permission denied/);
  });
  await t.test('votes can be replaced or cleared without changing readiness, grid or private progress',async()=>{
   for(const id of players)await ready(id);
   const before=await read(),progress=await privateProgress();
   state=await vote(HOST,7,'Hard');state=await vote(GUEST,7,'Hard');
   assert.deepEqual(state.players.find(p=>p.user_id===GUEST)?.grid_vote,{size:7,difficulty:'Hard'});
   assert.equal(state.room.size,5);assert.equal(state.room.difficulty,'Easy');assert.ok(state.players.every(p=>p.ready));
   assert.equal(state.self,null);assert.equal(state.puzzle,null);assert.deepEqual((await privateProgress()).rows,progress.rows);
   assert.ok(!/"(?:solution|seed|generation|values|notes)"/.test(JSON.stringify(state)));
   state=await vote(GUEST,6,'Medium');assert.deepEqual(state.players.find(p=>p.user_id===GUEST)?.grid_vote,{size:6,difficulty:'Medium'});
   state=await vote(GUEST,null,null);assert.equal(state.players.find(p=>p.user_id===GUEST)?.grid_vote,null);
   for(const [size,difficulty] of [[null,'Easy'],[5,null],[4,'Easy'],[9,'Hard'],[5,'Unknown']] as const)await assert.rejects(vote(GUEST,size,difficulty),/Choose a grid size/);
   assert.deepEqual((await read()).room,before.room);
   await assert.rejects(db.query('update public.numora_players set grid_vote_size=5 where room_id=$1 and user_id=$2',[state.room.id,GUEST]),/numora_player_grid_vote/);
   await db.query('update public.numora_players set active=false where room_id=$1 and user_id=$2',[state.room.id,HOST]);
   assert.equal((await read(GUEST)).players.find(p=>p.user_id===HOST)?.grid_vote,null);
   await db.query('update public.numora_players set active=true where room_id=$1 and user_id=$2',[state.room.id,HOST]);
  });
  await t.test('the host may override a majority or tie, resize a lobby, and retire all prior readiness tokens',async()=>{
   await vote(GUEST,7,'Hard');await vote(THIRD,7,'Hard');
   assert.equal((await read()).room.size,5); // Even a unanimous preference never applies itself.
   await vote(HOST,5,'Easy');await vote(GUEST,6,'Medium');await vote(THIRD,7,'Hard');
   const before=await read();
   for(const invalid of [{},{...large,solution:[]},{...large,size:9}])await assert.rejects(prepare(invalid),/integrity checks/);
   assert.deepEqual(withoutTime(await read()),withoutTime(before));
   const oldRound=round;assert.equal(await prepare(large),code);state=await read();round=state.room.round_id;
   assert.notEqual(round,oldRound);assert.equal(state.room.id,before.room.id);assert.equal(state.room.code,before.room.code);
   assert.equal(state.room.size,8);assert.equal(state.room.difficulty,'Hard');assert.equal(state.room.status,'lobby');assert.equal(state.room.starts_at,null);
   assert.deepEqual(state.players.map(p=>[p.user_id,p.nickname]),before.players.map(p=>[p.user_id,p.nickname]));
   assert.ok(state.players.every(p=>!p.ready&&!p.resume_ready&&p.grid_vote===null&&p.progress_count===0&&p.finished_at===null&&p.given_up_at===null&&p.elapsed_ms===null));
   assert.equal(state.room.paused_at,null);assert.equal(state.room.resumes_at,null);assert.equal(state.room.paused_ms,0);assert.equal(state.room.pause_id,null);assert.equal(state.room.pause_version,0);
   for(const progress of (await privateProgress()).rows){assert.deepEqual(progress.values,large.givens);assert.equal(progress.notes.length,64);assert.ok(progress.notes.every(cell=>cell.length===0));}
   assert.equal((await db.query('select * from numora_private.room_round_results')).rows.length,0);
   await assert.rejects(ready(HOST,oldRound),/round has changed/);
   await assert.rejects(user(HOST,()=>rpc('public.numora_start_room',[code,oldRound])),/round has changed/);
   await assert.rejects(vote(HOST,5,'Easy','lobby',oldRound),/round has changed/);
   await assert.rejects(prepare(first,'lobby',oldRound),/round has changed/);
   await assert.rejects(user(HOST,()=>rpc('public.numora_save_progress',[code,first.solution,JSON.stringify(first.givens.map(()=>[])),oldRound,0],['','::int[]','::jsonb'])),/round has changed/);
  });
  await t.test('voting closes for the race and reopens with blank ballots only after every outcome is terminal',async()=>{
   await vote(HOST,5,'Easy');state=await start();assert.ok(state.players.every(p=>p.grid_vote===null));
   for(const phase of ['lobby','finished','racing'])await assert.rejects(vote(HOST,6,'Medium',phase),/different phase/);
   await assert.rejects(prepare(medium),/different phase/);
   await release();
   state=await user(HOST,()=>rpc('public.numora_submit_solution',[code,large.solution,JSON.stringify(large.givens.map(()=>[])),round,0],['','::int[]','::jsonb']));
   await assert.rejects(vote(HOST,6,'Medium','finished'),/different phase/);
   await giveUp(GUEST);state=await giveUp(THIRD);assert.equal(state.room.status,'finished');
   assert.ok(state.players.every(p=>p.grid_vote===null)); // Lobby ballots do not become next-grid ballots.
   await assert.rejects(vote(HOST,5,'Easy','lobby'),/different phase/);
   const results=state.players.map(p=>[p.user_id,p.finished_at,p.given_up_at,p.elapsed_ms]);
   state=await vote(HOST,6,'Medium','finished');state=await vote(GUEST,6,'Medium','finished');
   assert.deepEqual(state.players.map(p=>[p.user_id,p.finished_at,p.given_up_at,p.elapsed_ms]),results);
   assert.equal(state.room.size,8);assert.equal(state.room.difficulty,'Hard');
  });
  await t.test('next-grid selection archives original standings, clears ballots and resizes every private draft',async()=>{
   const previous=await read(),oldRound=round;
   assert.equal(await prepare(medium,'finished'),code);state=await read();round=state.room.round_id;
   assert.notEqual(round,oldRound);assert.equal(state.room.size,6);assert.equal(state.room.difficulty,'Medium');assert.equal(state.room.status,'lobby');
   assert.ok(state.players.every(p=>p.grid_vote===null&&!p.ready&&!p.finished_at&&!p.given_up_at&&p.elapsed_ms===null));
   for(const progress of (await privateProgress()).rows){assert.deepEqual(progress.values,medium.givens);assert.equal(progress.notes.length,36);}
   const archive=(await db.query<{size:number;difficulty:string;results:{user_id:string;elapsed_ms:number|null;given_up_at:string|null;finished_at:string|null}[]}>('select size,difficulty,results from numora_private.room_round_results where room_id=$1 and round_id=$2',[state.room.id,oldRound])).rows[0];
   assert.equal(archive.size,8);assert.equal(archive.difficulty,'Hard');assert.equal(archive.results.length,3);
   assert.deepEqual(archive.results.map(p=>[p.user_id,p.finished_at,p.given_up_at,p.elapsed_ms]).sort(),previous.players.map(p=>[p.user_id,p.finished_at,p.given_up_at,p.elapsed_ms]).sort());
   await assert.rejects(prepare(medium,'finished',oldRound),/round has changed/);
   assert.equal((await db.query('select * from numora_private.room_round_results')).rows.length,1);
   await assert.rejects(vote(HOST,8,'Hard','finished',oldRound),/round has changed/);
  });
  await t.test('legacy rematches cannot resurrect old next-grid ballots and migration replay preserves a current ballot',async()=>{
   await start();await release();for(const id of players)await giveUp(id);
   state=await vote(HOST,8,'Hard','finished');
   await role('service_role',null,()=>rpc<string>('public.numora_rematch_room',[HOST,code,round,JSON.stringify(legacy)],['','','','::jsonb']));
   state=await read();round=state.room.round_id;assert.ok(state.players.every(p=>p.grid_vote===null));
   await start();await release();for(const id of players)await giveUp(id);
   state=await read();assert.ok(state.players.every(p=>p.grid_vote===null));
   state=await vote(THIRD,7,'Medium','finished');const before=withoutTime(state);
   await db.exec(votingMigration);assert.deepEqual(withoutTime(await read()),before);
   await db.exec(migrations);assert.deepEqual(withoutTime(await read()),before);
   await assert.rejects(user(HOST,()=>rpc('public.numora_prepare_room_grid',[HOST,code,round,'finished',JSON.stringify(first)],['','','','','::jsonb'])),/permission denied/);
  });
 }finally{await db.close();}
});
