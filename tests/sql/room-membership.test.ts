import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { generatePuzzle } from '../../src/game/generator';

const board=generatePuzzle({size:5,difficulty:'Easy',seed:'observer-and-away-contract'});
const nextBoard=generatePuzzle({size:6,difficulty:'Medium',seed:'observer-next-round'});
const notes=board.givens.map(()=>[] as number[]);
const directory=new URL('../../supabase/migrations/',import.meta.url);
const files=readdirSync(directory).filter(name=>name.endsWith('.sql')).sort();
const migrations=files.map(name=>readFileSync(new URL(name,directory),'utf8')).join('\n');
const membership=readFileSync(new URL(files.find(name=>name.endsWith('_numora_room_spectators_and_kicks.sql'))!,directory),'utf8');
type Player={user_id:string;nickname:string;active:boolean;is_spectator:boolean;is_away:boolean;ready:boolean;resume_ready:boolean;finished_at:string|null;given_up_at:string|null;elapsed_ms:number|null;grid_vote:{size:number;difficulty:string}|null};
type State={room:{id:string;round_id:string;code:string;host_id:string;status:string;size:number;starts_at:string|null;paused_at:string|null;resumes_at:string|null;pause_id:string|null;pause_version:number};players:Player[];removed_results:{user_id:string;nickname:string;finished_at:string|null;given_up_at:string|null;elapsed_ms:number|null;removed_at:string}[];self:{values:number[];notes:number[][]}|null;puzzle:Record<string,unknown>|null;server_now:string};

test('away removals and late spectators preserve access, clocks, standings and next-round participation',async t=>{
 const db=new PGlite();let nextId=1;
 try{
  await db.exec(`create role anon;create role authenticated;create role service_role;
   create schema auth;create table auth.users(id uuid primary key);
   create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;$$;
   grant usage on schema auth to anon,authenticated,service_role;
   create schema realtime;create table realtime.messages(extension text,topic text);alter table realtime.messages enable row level security;
   create function realtime.topic() returns text language sql stable as $$select current_setting('realtime.topic',true);$$;`);
  await db.exec(migrations);
  const asRole=async<T>(role:string,id:string|null,work:()=>Promise<T>):Promise<T>=>{
   await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id??'']);await db.exec(`set role ${role}`);
   try{return await work();}finally{await db.exec('reset role');}
  };
  const user=<T>(id:string,work:()=>Promise<T>)=>asRole('authenticated',id,work);
  const rpc=async<T=State>(name:string,args:unknown[]=[],casts:string[]=[])=>{
   const placeholders=args.map((_,i)=>`$${i+1}${casts[i]??''}`).join(',');
   return(await db.query<{data:T}>(`select ${name}(${placeholders}) as data`,args)).rows[0].data;
  };
  const fixture=async()=>{
   const ids=Array.from({length:10},()=>`84000000-0000-4000-8000-${String(nextId++).padStart(12,'0')}`);
   for(const id of ids)await db.query('insert into auth.users(id) values($1)',[id]);
   const [host,guest,third,late,outsider]=ids;
   const code=await asRole('service_role',null,()=>rpc<string>('public.numora_create_room',[host,'Host',JSON.stringify(board)],['','','::jsonb']));
   const read=(id=host)=>user(id,()=>rpc('public.numora_get_room',[code]));
   let state=await read();
   const f={host,guest,third,late,outsider,ids,code,id:state.room.id,round:state.room.round_id,read,
    join:(id:string,name:string)=>user(id,()=>rpc('public.numora_join_room',[code,name])),
    ready:(id:string,r=state.room.round_id)=>user(id,()=>rpc('public.numora_set_ready',[code,true,r])),
    start:async()=>{const current=await read();for(const p of current.players.filter(p=>!p.is_spectator))await user(p.user_id,()=>rpc('public.numora_set_ready',[code,true,f.round]));return user(host,()=>rpc('public.numora_start_room',[code,f.round]));},
    release:()=>db.query("update public.numora_rooms set starts_at=clock_timestamp()-interval '60 seconds' where id=$1",[state.room.id]),
    age:(id:string,seconds=61)=>db.query("update public.numora_players set last_seen_at=clock_timestamp()-make_interval(secs=>$3::int) where room_id=$1 and user_id=$2",[state.room.id,id,seconds]),
    kick:(target:string,id=host,r:string|null=state.room.round_id)=>user(id,()=>rpc('public.numora_kick_player',[code,target,r])),
    leave:(id:string)=>user(id,()=>rpc('public.numora_leave_room',[code,f.round])),
    finish:async(id:string)=>{const current=await read(id);return user(id,()=>rpc('public.numora_submit_solution',[code,board.solution,JSON.stringify(notes),f.round,current.room.pause_version],['','::int[]','::jsonb']));},
    giveUp:(id:string)=>user(id,()=>rpc('public.numora_give_up_room',[code,f.round])),
    pause:async()=>{const current=await read();return user(host,()=>rpc('public.numora_pause_room',[code,f.round,current.room.pause_version]));},
    resume:(id:string,pauseId:string)=>user(id,()=>rpc('public.numora_set_resume_ready',[code,f.round,pauseId,true])),
    prepare:(phase:string,puzzle=nextBoard)=>asRole('service_role',null,()=>rpc<string>('public.numora_prepare_room_grid',[host,code,f.round,phase,JSON.stringify(puzzle)],['','','','','::jsonb'])),
    legacy:()=>asRole('service_role',null,()=>rpc<string>('public.numora_rematch_room',[host,code,f.round,JSON.stringify(board)],['','','','::jsonb'])),
   };
   await f.join(guest,'Guest');return f;
  };

  await t.test('host-only removal enforces the grace period, explicit leave, current round and private receipt permissions',async()=>{
   const f=await fixture();
   for(const [role,id]of[['anon',null],['authenticated',null],['authenticated',f.guest],['authenticated',f.outsider],['service_role',null]]as const){
    await assert.rejects(asRole(role,id,()=>rpc('public.numora_kick_player',[f.code,f.guest,f.round])),/permission denied|Sign in|Only the room host/);
   }
   await assert.rejects(f.kick(f.host),/cannot remove themselves/);
   await assert.rejects(f.kick(f.guest,f.host,null),/round has changed/);
   await assert.rejects(f.kick(f.guest,f.host,f.outsider),/round has changed/);
   await assert.rejects(f.kick(f.outsider),/already left this room/);
   await f.age(f.guest,59);assert.equal((await f.read()).players.find(p=>p.user_id===f.guest)?.is_away,false);
   await assert.rejects(f.kick(f.guest),/still connected/);
   await f.age(f.guest);assert.equal((await f.read()).players.find(p=>p.user_id===f.guest)?.is_away,true);
   const state=await f.kick(f.guest);assert.equal(state.players.length,1);assert.deepEqual(state.removed_results,[]);
   const repeat=await f.kick(f.guest);assert.deepEqual(repeat.room,state.room);
   for(const role of ['anon','authenticated','service_role'])await assert.rejects(asRole(role,f.host,()=>db.query('select * from numora_private.room_kicks')),/permission denied/);
   await assert.rejects(user(f.host,()=>rpc('numora_private.archive_room_round',[f.id])),/permission denied/);
   await assert.rejects(user(f.host,()=>rpc('numora_private.finish_room_if_complete',[f.id])),/permission denied/);
   await assert.rejects(user(f.host,()=>db.query('update public.numora_players set is_spectator=true where room_id=$1',[f.id])),/permission denied/);
   await f.join(f.third,'Third');await f.start();await f.release();await f.leave(f.third);
   assert.equal((await f.read()).players.find(p=>p.user_id===f.third)?.is_away,true);
   await f.kick(f.third);assert.equal((await f.read()).players.length,1);
  });

  await t.test('GET heartbeats are throttled, restore presence before a kick, and never silently rejoin an inactive member',async()=>{
   const f=await fixture();await f.age(f.guest,61);
   const refreshed=await f.read(f.guest);assert.equal(refreshed.players.find(p=>p.user_id===f.guest)?.is_away,false);
   const seen=async()=>String((await db.query<{last_seen_at:string}>('select last_seen_at from public.numora_players where room_id=$1 and user_id=$2',[f.id,f.guest])).rows[0].last_seen_at);
   const firstSeen=await seen();await f.read(f.guest);assert.equal(await seen(),firstSeen);
   await assert.rejects(f.kick(f.guest),/still connected/);
   await f.start();await f.release();await f.leave(f.guest);
   const before=await seen(),left=await f.read(f.guest);assert.equal(left.players.find(p=>p.user_id===f.guest)?.active,false);
   assert.equal(left.players.find(p=>p.user_id===f.guest)?.is_away,true);assert.equal(await seen(),before);
  });

  await t.test('a kicked identity loses every current access path, cannot rejoin, and cannot recover private progress',async()=>{
   const f=await fixture();await f.start();await f.release();await f.age(f.guest);await f.kick(f.guest);
   await assert.rejects(f.read(f.guest),/You were removed from this room by the host/);
   await assert.rejects(f.join(f.guest,'Other nickname'),/You were removed from this room by the host/);
   const operations=[
    ()=>rpc('public.numora_save_progress',[f.code,board.givens,JSON.stringify(notes),f.round,0],['','::int[]','::jsonb']),
    ()=>rpc('public.numora_submit_solution',[f.code,board.solution,JSON.stringify(notes),f.round,0],['','::int[]','::jsonb']),
    ()=>rpc('public.numora_give_up_room',[f.code,f.round]),
    ()=>rpc('public.numora_pause_room',[f.code,f.round,0]),
    ()=>rpc('public.numora_set_resume_ready',[f.code,f.round,f.outsider,true]),
    ()=>rpc('public.numora_spectate_player',[f.code,f.host,f.round,0]),
    ()=>rpc('public.numora_set_ready',[f.code,true,f.round]),
    ()=>rpc('public.numora_vote_grid',[f.code,f.round,'finished',5,'Easy']),
   ];
   for(const operation of operations)await assert.rejects(user(f.guest,operation),/Join this room|active unfinished/);
   assert.equal((await user(f.guest,()=>db.query('select * from public.numora_rooms where id=$1',[f.id]))).rows.length,0);
   assert.equal((await user(f.guest,()=>db.query('select * from public.numora_players where room_id=$1',[f.id]))).rows.length,0);
   assert.equal((await db.query('select * from numora_private.progress where room_id=$1 and user_id=$2',[f.id,f.guest])).rows.length,0);
   assert.equal(await user(f.guest,()=>rpc<boolean>('numora_private.is_member',[f.id])),false);
   assert.equal(await user(f.guest,()=>rpc<boolean>('numora_private.can_use_channel',[`numora-room:${f.id}`])),false);
  });

  await t.test('late arrivals during countdown, race, pause and finished results are unscored observers with read-only spectating',async()=>{
   const f=await fixture();let state=await f.start();state=await f.join(f.late,'Late watcher');
   assert.equal(state.players.find(p=>p.user_id===f.late)?.is_spectator,true);assert.equal(state.self,null);assert.equal(state.puzzle,null);
   await assert.rejects(user(f.late,()=>rpc('public.numora_spectate_player',[f.code,f.host,f.round,0])),/not started/);
   await f.release();state=await f.read(f.late);assert.ok(state.puzzle);assert.equal(state.self,null);
   assert.equal(state.puzzle?.solution,undefined);assert.equal(state.puzzle?.seed,undefined);
   const watched=await user(f.late,()=>rpc<Record<string,unknown>>('public.numora_spectate_player',[f.code,f.host,f.round,0]));
   assert.deepEqual(Object.keys(watched).sort(),['room_id','player_id','values','notes','updated_at','server_now'].sort());
   for(const operation of [
    ()=>rpc('public.numora_save_progress',[f.code,board.givens,JSON.stringify(notes),f.round,0],['','::int[]','::jsonb']),
    ()=>rpc('public.numora_submit_solution',[f.code,board.solution,JSON.stringify(notes),f.round,0],['','::int[]','::jsonb']),
    ()=>rpc('public.numora_give_up_room',[f.code,f.round]),
    ()=>rpc('public.numora_pause_room',[f.code,f.round,0]),
    ()=>rpc('public.numora_set_ready',[f.code,true,f.round]),
    ()=>rpc('public.numora_set_resume_ready',[f.code,f.round,f.outsider,true]),
   ])await assert.rejects(user(f.late,operation),/joined as a spectator/);
   await assert.rejects(user(f.host,()=>rpc('public.numora_spectate_player',[f.code,f.guest,f.round,0])),/Finish or give up/);
   await f.finish(f.host);
   await assert.rejects(user(f.host,()=>rpc('public.numora_spectate_player',[f.code,f.late,f.round,0])),/not in this room/);
   state=await user(f.guest,()=>rpc('public.numora_pause_room',[f.code,f.round,0]));const pauseId=state.room.pause_id!;
   state=await f.join(f.third,'Paused watcher');assert.equal(state.players.find(p=>p.user_id===f.third)?.is_spectator,true);
   assert.equal(state.room.pause_id,pauseId);assert.equal(state.room.resumes_at,null);
   await assert.rejects(user(f.late,()=>rpc('public.numora_spectate_player',[f.code,f.guest,f.round,state.room.pause_version])),/room is paused/);
   state=await f.resume(f.guest,pauseId);assert.ok(state.room.resumes_at); // Neither observer votes.
   state=await f.join(f.late,'Late watcher');assert.equal(state.room.pause_id,pauseId);assert.ok(state.room.resumes_at);
   await db.query("update public.numora_rooms set paused_at=clock_timestamp()-interval '10 seconds',resumes_at=clock_timestamp()-interval '1 second' where id=$1",[f.id]);
   state=await f.read();await f.giveUp(f.guest);state=await f.join(f.outsider,'Results watcher');
   assert.equal(state.room.status,'finished');assert.equal(state.players.find(p=>p.user_id===f.outsider)?.is_spectator,true);
   assert.ok(state.players.filter(p=>p.is_spectator).every(p=>p.finished_at===null&&p.given_up_at===null&&p.elapsed_ms===null&&!p.ready));
   await user(f.late,()=>rpc('public.numora_vote_grid',[f.code,f.round,'finished',6,'Medium']));
  });

  await t.test('removing a paused blocker releases the shared countdown and removing the final unfinished racer ends the round',async()=>{
   const f=await fixture();await f.join(f.third,'Third');await f.start();await f.release();await f.join(f.late,'Watcher');
   let state=await f.pause();const pauseId=state.room.pause_id!;
   await f.resume(f.host,pauseId);await f.resume(f.third,pauseId);await f.age(f.guest);state=await f.kick(f.guest);
   assert.ok(state.room.resumes_at);assert.ok(Math.abs(Date.parse(state.room.resumes_at!)-Date.parse(state.server_now)-3000)<100);
   assert.equal(state.players.find(p=>p.user_id===f.late)?.resume_ready,false);
   await f.giveUp(f.third);await f.giveUp(f.host);state=await f.read();assert.equal(state.room.status,'finished');assert.equal(state.room.paused_at,null);
   const next=await fixture();await next.start();await next.release();await next.join(next.late,'Watcher');await next.finish(next.host);
   await next.age(next.guest);state=await next.kick(next.guest);assert.equal(state.room.status,'finished');
   assert.equal(state.players.length,2);assert.equal(state.players.filter(p=>!p.is_spectator).length,1);
   const single=await fixture();await single.start();await single.release();await single.age(single.guest);await single.kick(single.guest);
   state=await single.finish(single.host);assert.equal(state.room.status,'finished'); // Original >=2-row guard must not hang.
  });

  await t.test('removed racer standings survive privately and in the current receipt; observers and lobby removals never gain ranks',async()=>{
   const f=await fixture();await f.join(f.third,'Third');await f.start();await f.release();await f.join(f.late,'Watcher');
   const finished=(await f.finish(f.guest)).players.find(p=>p.user_id===f.guest)!;
   await f.age(f.guest);let state=await f.kick(f.guest);
   assert.deepEqual(state.removed_results.map(p=>[p.user_id,p.finished_at,p.elapsed_ms]),[[f.guest,finished.finished_at,finished.elapsed_ms]]);
   assert.deepEqual(Object.keys(state.removed_results[0]).sort(),['user_id','nickname','finished_at','given_up_at','elapsed_ms','removed_at'].sort());
   await f.age(f.late);state=await f.kick(f.late);assert.equal(state.removed_results.length,1);
   await f.age(f.third);state=await f.kick(f.third);const dnf=state.removed_results.find(p=>p.user_id===f.third)!;
   assert.ok(dnf.given_up_at);assert.equal(dnf.given_up_at,dnf.removed_at);assert.equal(dnf.finished_at,null);assert.equal(dnf.elapsed_ms,null);
   await f.finish(f.host);const oldRound=f.round;await f.prepare('finished');state=await f.read();f.round=state.room.round_id;
   assert.deepEqual(state.removed_results,[]);
   const archive=(await db.query<{results:{user_id:string;elapsed_ms:number|null}[]}>('select results from numora_private.room_round_results where room_id=$1 and round_id=$2',[f.id,oldRound])).rows[0].results;
   assert.equal(archive.length,3);assert.equal(archive.find(p=>p.user_id===f.guest)?.elapsed_ms,finished.elapsed_ms);
   assert.equal(archive.find(p=>p.user_id===f.late),undefined);assert.equal(archive.find(p=>p.user_id===f.third)?.elapsed_ms,null);
   await assert.rejects(f.join(f.guest,'Back again'),/removed from this room/);
   const lobby=await fixture();await lobby.age(lobby.guest);await lobby.kick(lobby.guest);await lobby.join(lobby.third,'Third');await lobby.start();await lobby.release();
   await lobby.giveUp(lobby.host);await lobby.giveUp(lobby.third);state=await lobby.read();assert.deepEqual(state.removed_results,[]);
   await lobby.legacy();const results=(await db.query<{results:{user_id:string}[]}>('select results from numora_private.room_round_results where room_id=$1',[lobby.id])).rows[0].results;
   assert.equal(results.length,2);assert.equal(results.find(p=>p.user_id===lobby.guest),undefined);
  });

  await t.test('both host grid paths promote observers for the next game and archives exclude their previous non-playing role',async()=>{
   for(const legacy of [false,true]){
    const f=await fixture();await f.start();await f.release();await f.join(f.late,'Next player');await f.giveUp(f.host);await f.giveUp(f.guest);
    const before=await f.read();const oldRound=f.round;
    if(legacy)await f.legacy();else await f.prepare('finished');
    let state=await f.read();f.round=state.room.round_id;assert.equal(state.room.status,'lobby');assert.equal(state.players.length,3);
    assert.ok(state.players.every(p=>!p.is_spectator&&!p.ready&&!p.resume_ready&&!p.finished_at&&!p.given_up_at&&p.elapsed_ms===null));
    const saved=(await db.query<{results:{user_id:string}[]}>('select results from numora_private.room_round_results where room_id=$1 and round_id=$2',[f.id,oldRound])).rows[0];
    assert.equal(saved.results.length,2);assert.equal(saved.results.find(p=>p.user_id===f.late),undefined);
    await assert.rejects(f.kick(f.guest,f.host,oldRound),/round has changed/);
    for(const p of state.players)await user(p.user_id,()=>rpc('public.numora_set_ready',[f.code,true,f.round]));
    state=await user(f.host,()=>rpc('public.numora_start_room',[f.code,f.round]));assert.equal(state.room.status,'racing');
    assert.notEqual(state.room.round_id,before.room.round_id);
   }
  });

  await t.test('observer leave frees slots and replay preserves scoped bans and role state',async()=>{
   const f=await fixture();await f.start();await f.release();
   for(const [i,id] of f.ids.slice(2,8).entries())await f.join(id,`Watcher ${i}`);
   const full=await f.join(f.ids[8],'One too many') as unknown as {error:string;code:string};assert.equal(full.code,'ROOM_FULL');
   await f.leave(f.late);assert.equal((await f.read()).players.length,7);await f.join(f.ids[8],'New watcher');
   await f.age(f.guest);await f.kick(f.guest);const before=await f.read();
   await db.exec(membership);const after=await f.read();assert.deepEqual(after.room,before.room);assert.deepEqual(after.players,before.players);assert.deepEqual(after.removed_results,before.removed_results);
   await db.exec(migrations);const replay=await f.read();assert.deepEqual(replay.room,before.room);assert.deepEqual(replay.players,before.players);
   await assert.rejects(f.join(f.guest,'Guest'),/removed from this room/);
  });
 }finally{await db.close();}
});
