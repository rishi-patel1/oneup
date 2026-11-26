import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { generatePuzzle } from '../../src/game/generator';

const directory=new URL('../../supabase/migrations/',import.meta.url);
const files=readdirSync(directory).filter(name=>name.endsWith('.sql')).sort();
const migrations=files.map(name=>readFileSync(new URL(name,directory),'utf8')).join('\n');
const resultsMigration=readFileSync(new URL(files.find(name=>name.endsWith('_numora_previous_round_results.sql'))!,directory),'utf8');
const first=generatePuzzle({size:5,difficulty:'Easy',seed:'previous-standings-first'});
const next=generatePuzzle({size:6,difficulty:'Medium',seed:'previous-standings-next'});
type Result={user_id:string;nickname:string;finished_at:string|null;given_up_at:string|null;elapsed_ms:number|null};
type Previous={round_id:string;size:number;difficulty:string;starts_at:string;finished_at:string;results:Result[]};
type State={room:{id:string;code:string;round_id:string;status:string;pause_version:number};players:(Result&{is_spectator:boolean;ready:boolean})[];removed_results:Result[];previous_round:Previous|null;puzzle:unknown;self:unknown;server_now:string};

test('previous round standings are durable, scoped score-only data behind existing room authorization',async t=>{
 const db=new PGlite();
 try{
  await db.exec(`create role anon;create role authenticated;create role service_role;
   create schema auth;create table auth.users(id uuid primary key);
   create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;$$;
   grant usage on schema auth to anon,authenticated,service_role;
   create schema realtime;create table realtime.messages(extension text,topic text);alter table realtime.messages enable row level security;
   create function realtime.topic() returns text language sql stable as $$select current_setting('realtime.topic',true);$$;`);
  await db.exec(migrations);
  const asRole=async<T>(role:string,id:string|null,operation:()=>Promise<T>):Promise<T>=>{
   await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id??'']);await db.exec(`set role ${role}`);
   try{return await operation();}finally{await db.exec('reset role');}
  };
  const user=<T>(id:string,operation:()=>Promise<T>)=>asRole('authenticated',id,operation);
  const rpc=async<T=State>(name:string,args:unknown[]=[],casts:string[]=[])=>{
   const placeholders=args.map((_,i)=>`$${i+1}${casts[i]??''}`).join(',');
   return(await db.query<{data:T}>(`select ${name}(${placeholders}) as data`,args)).rows[0].data;
  };
  const fixture=async()=>{
   const[host,guest,removed,late,outsider]=Array.from({length:5},()=>randomUUID());
   for(const id of[host,guest,removed,late,outsider])await db.query('insert into auth.users values($1)',[id]);
   const code=await asRole('service_role',null,()=>rpc<string>('public.numora_create_room',[host,'Hungry Goose',JSON.stringify(first)],['','','::jsonb']));
   const read=(who=host)=>user(who,()=>rpc('public.numora_get_room',[code]));
   const state=await read();
   const f={host,guest,removed,late,outsider,code,id:state.room.id,round:state.room.round_id,
    board:first,read,
    join:(who:string,nickname:string)=>user(who,()=>rpc('public.numora_join_room',[code,nickname])),
    start:async()=>{const current=await read();for(const p of current.players.filter(p=>!p.is_spectator))await user(p.user_id,()=>rpc('public.numora_set_ready',[code,true,f.round]));await user(host,()=>rpc('public.numora_start_room',[code,f.round]));await db.query("update public.numora_rooms set starts_at=clock_timestamp()-interval '60 seconds' where id=$1",[f.id]);},
    finish:(who:string)=>user(who,()=>rpc('public.numora_submit_solution',[code,f.board.solution,JSON.stringify(f.board.givens.map(()=>[])),f.round,0],['','::int[]','::jsonb'])),
    giveUp:(who:string)=>user(who,()=>rpc('public.numora_give_up_room',[code,f.round])),
    kick:async(who:string)=>{await db.query("update public.numora_players set last_seen_at=clock_timestamp()-interval '61 seconds' where room_id=$1 and user_id=$2",[f.id,who]);return user(host,()=>rpc('public.numora_kick_player',[code,who,f.round]));},
    prepare:async(phase:'lobby'|'finished',board=next)=>{await asRole('service_role',null,()=>rpc('public.numora_prepare_room_grid',[host,code,f.round,phase,JSON.stringify(board)],['','','','','::jsonb']));const result=await read();f.round=result.room.round_id;f.board=board;return result;},
   };
   await f.join(guest,'Sleepy Goose');return f;
  };
  const score=(p:Result):Result=>({user_id:p.user_id,nickname:p.nickname,finished_at:p.finished_at,given_up_at:p.given_up_at,elapsed_ms:p.elapsed_ms});

  await t.test('new rooms have no prior round and never borrow a different room’s archive',async()=>{
   const own=await fixture(),other=await fixture();
   await other.start();await other.finish(other.host);await other.giveUp(other.guest);await other.prepare('finished');
   const snapshot=await own.read();assert.equal(snapshot.previous_round,null);assert.equal(snapshot.self,null);assert.equal(snapshot.puzzle,null);
   const otherPrevious=(await other.read()).previous_round!;assert.equal(otherPrevious.results.length,2);
   assert.equal(JSON.stringify(snapshot).includes(other.host),false);
   for(const[role,who]of[['anon',null],['authenticated',null],['authenticated',own.outsider],['service_role',null]]as const){
    await assert.rejects(asRole(role,who,()=>rpc('public.numora_get_room',[own.code])),/permission denied|Sign in|Join this room/);
   }
   for(const role of['anon','authenticated','service_role'])await assert.rejects(asRole(role,own.host,()=>db.query('select * from numora_private.room_round_results')),/permission denied/);
  });

  await t.test('rematch returns original solved, given-up and removed outcomes without spectators or private data',async()=>{
   const f=await fixture();await f.join(f.removed,'Removed Racer');await f.start();await f.join(f.late,'Watching Goose');
   await user(f.host,()=>rpc('public.numora_send_room_message',[f.code,f.id,randomUUID(),'private room chat text']));
   await f.kick(f.removed);await f.finish(f.host);const finished=await f.giveUp(f.guest);
   assert.equal(finished.room.status,'finished');assert.equal(finished.previous_round,null);
   const expected=[...finished.players.filter(p=>!p.is_spectator),...finished.removed_results].map(score);
   const snapshot=await f.prepare('finished'),previous=snapshot.previous_round!;
   assert.equal(snapshot.room.status,'lobby');assert.equal(snapshot.self,null);assert.equal(snapshot.puzzle,null);
   assert.notEqual(snapshot.room.round_id,finished.room.round_id);assert.equal(previous.round_id,finished.room.round_id);
   assert.equal(previous.size,5);assert.equal(previous.difficulty,'Easy');
   assert.deepEqual(Object.keys(previous).sort(),['round_id','size','difficulty','starts_at','finished_at','results'].sort());
   assert.deepEqual([...previous.results].sort((a,b)=>a.user_id.localeCompare(b.user_id)),expected.sort((a,b)=>a.user_id.localeCompare(b.user_id)));
   assert.equal(previous.results.some(p=>p.user_id===f.late),false);
   assert.equal(previous.results.find(p=>p.user_id===f.removed)?.finished_at,null);
   assert.ok(previous.results.find(p=>p.user_id===f.removed)?.given_up_at);
   for(const result of previous.results)assert.deepEqual(Object.keys(result).sort(),['user_id','nickname','finished_at','given_up_at','elapsed_ms'].sort());
   assert.ok(Date.parse(previous.starts_at)<=Date.parse(previous.finished_at));
   assert.ok(!/"(?:solution|generation|seed|givens|rightWalls|bottomWalls|values|notes|messages|body)"/.test(JSON.stringify(previous)));
   assert.equal(JSON.stringify(previous).includes('private room chat text'),false);
   assert.deepEqual((await f.read(f.guest)).previous_round,previous); // A separate page load gets the same durable score data.
   await f.join(f.outsider,'New Lobby Goose');assert.deepEqual((await f.read(f.outsider)).previous_round,previous);
   const refreshed=await f.prepare('lobby',first);assert.deepEqual(refreshed.previous_round,previous);
   assert.equal((await db.query<{count:number}>('select count(*)::int as count from numora_private.room_round_results where room_id=$1',[f.id])).rows[0].count,1);
   // Archive data is never returned wholesale: future private metadata cannot leak.
   await db.query("update numora_private.room_round_results set results=(select jsonb_agg(p||jsonb_build_object('solution',jsonb_build_array(1),'chat','secret')) from jsonb_array_elements(results)p) where room_id=$1",[f.id]);
   assert.deepEqual((await f.read()).previous_round,previous);
  });

  await t.test('latest selection uses a deterministic indexed order and replay preserves its data',async()=>{
   const f=await fixture();await f.start();await f.finish(f.host);await f.giveUp(f.guest);await f.prepare('finished');
   const original=(await f.read()).previous_round!;
   const earlier='90000000-0000-4000-8000-000000000001',later='90000000-0000-4000-8000-000000000002';
   for(const round of[earlier,later])await db.query(`insert into numora_private.room_round_results(room_id,round_id,size,difficulty,starts_at,finished_at,results,recorded_at)
    select room_id,$2,7,'Hard',starts_at,finished_at,results,recorded_at+interval '1 second'
    from numora_private.room_round_results where room_id=$1 and round_id=$3`,[f.id,round,original.round_id]);
   let selected=(await f.read()).previous_round!;assert.equal(selected.round_id,later);assert.equal(selected.size,7);assert.equal(selected.difficulty,'Hard');
   await db.query("update numora_private.room_round_results set finished_at=finished_at+interval '1 millisecond' where room_id=$1 and round_id=$2",[f.id,earlier]);
   selected=(await f.read()).previous_round!;assert.equal(selected.round_id,earlier);
   await db.exec(resultsMigration);assert.deepEqual((await f.read()).previous_round,selected);
   const definition=(await db.query<{indexdef:string}>("select indexdef from pg_indexes where schemaname='numora_private' and indexname='numora_round_results_latest'")).rows[0].indexdef;
   assert.match(definition,/room_id, recorded_at DESC, finished_at DESC, round_id DESC/);
  });

  await t.test('newly completed rounds replace the prior archive and expiry or removal still revokes access',async()=>{
   const f=await fixture();await f.start();await f.finish(f.host);await f.giveUp(f.guest);await f.prepare('finished');
   const firstRound=(await f.read()).previous_round!.round_id;await f.start();await f.giveUp(f.host);const finished=await f.finish(f.guest);
   assert.equal(finished.previous_round?.round_id,firstRound);const current=await f.prepare('finished',first);
   assert.equal(current.previous_round?.round_id,finished.room.round_id);assert.notEqual(current.previous_round?.round_id,firstRound);
   assert.equal(current.previous_round?.size,6);assert.equal(current.previous_round?.difficulty,'Medium');
   await f.kick(f.guest);await assert.rejects(f.read(f.guest),/You were removed from this room by the host/);
   await db.query("update public.numora_rooms set last_activity_at=clock_timestamp()-interval '25 hours' where id=$1",[f.id]);
   await assert.rejects(f.read(),/This room has expired/);
   assert.equal((await db.query<{count:number}>('select count(*)::int as count from numora_private.room_round_results where room_id=$1',[f.id])).rows[0].count,2);
  });
 }finally{await db.close();}
});
