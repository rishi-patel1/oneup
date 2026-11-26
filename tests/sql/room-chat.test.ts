import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { generatePuzzle } from '../../src/game/generator';

const directory=new URL('../../supabase/migrations/',import.meta.url);
const files=readdirSync(directory).filter(name=>name.endsWith('.sql')).sort();
const migrations=files.map(name=>readFileSync(new URL(name,directory),'utf8')).join('\n');
const chatMigration=readFileSync(new URL(files.find(name=>name.endsWith('_numora_room_chat_and_expiry.sql'))!,directory),'utf8');
const board=generatePuzzle({size:5,difficulty:'Easy',seed:'room-chat-contract'});
type State={room:{id:string;code:string;round_id:string;pause_version:number;status:string};players:{user_id:string;is_spectator:boolean}[]};
type Chat={room_id:string;expires_at:string;server_now:string;messages:{id:string;client_id:string;user_id:string;nickname:string;body:string;created_at:string}[]};
const expired=/This room has expired\. Create or join another room\./;

test('room chat is private, retry-safe, bounded, live across rounds, and deleted with expired rooms',async t=>{
 const db=new PGlite();
 try{
  await db.exec(`create role anon;create role authenticated;create role service_role;
    create schema auth;create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;$$;
    grant usage on schema auth to anon,authenticated,service_role;
    create schema realtime;create table realtime.messages(extension text,topic text);alter table realtime.messages enable row level security;
    create function realtime.topic() returns text language sql stable as $$select current_setting('realtime.topic',true);$$;
    create table realtime.chat_notifications(payload jsonb,event text,topic text,private boolean);
    create function realtime.send(jsonb,text,text,boolean) returns void language sql as $$insert into realtime.chat_notifications values($1,$2,$3,$4);$$;`);
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
   const [host,guest,late,outsider]=Array.from({length:4},()=>randomUUID());
   for(const id of[host,guest,late,outsider])await db.query('insert into auth.users values($1)',[id]);
   const code=await asRole('service_role',null,()=>rpc<string>('public.numora_create_room',[host,'Hungry Goose',JSON.stringify(board)],['','','::jsonb']));
   const state=await user(host,()=>rpc('public.numora_get_room',[code]));
   const id=state.room.id,round=state.room.round_id;
   const f={host,guest,late,outsider,code,id,round,
    join:(who:string,name:string)=>user(who,()=>rpc('public.numora_join_room',[code,name])),
    read:(who=host)=>user(who,()=>rpc<Chat>('public.numora_get_room_chat',[code,id])),
    send:(body:string,who=host,nonce=randomUUID())=>user(who,()=>rpc<Chat>('public.numora_send_room_message',[code,id,nonce,body])),
    start:async()=>{for(const who of[host,guest])await user(who,()=>rpc('public.numora_set_ready',[code,true,round]));await user(host,()=>rpc('public.numora_start_room',[code,round]));await db.query("update public.numora_rooms set starts_at=clock_timestamp()-interval '60 seconds' where id=$1",[id]);},
    leave:(who:string)=>user(who,()=>rpc('public.numora_leave_room',[code,round])),
    age:()=>db.query("update public.numora_rooms set last_activity_at=clock_timestamp()-interval '25 hours' where id=$1",[id]),
   };
   await f.join(guest,'Sleepy Stonebreaker');return f;
  };

  await t.test('membership, active status, room identity, kick receipts, and private table ACLs authorize every read and send',async()=>{
   const f=await fixture();
   for(const[role,who]of[['anon',null],['authenticated',null],['authenticated',f.outsider],['service_role',null]]as const){
    await assert.rejects(asRole(role,who,()=>rpc('public.numora_get_room_chat',[f.code,f.id])),/permission denied|Sign in|Join this room/);
    await assert.rejects(asRole(role,who,()=>rpc('public.numora_send_room_message',[f.code,f.id,randomUUID(),'hi'])),/permission denied|Sign in|Join this room/);
   }
   await assert.rejects(user(f.host,()=>rpc('public.numora_get_room_chat',[f.code,randomUUID()])),expired);
   for(const role of['anon','authenticated','service_role']){
    await assert.rejects(asRole(role,f.host,()=>db.query('select * from numora_private.chat_messages')),/permission denied/);
    for(const[fn,args]of[['numora_private.room_chat_snapshot',[f.id]],['numora_private.assert_live_room',[f.id]],['numora_private.lock_chat_room',[f.code,f.id]],['numora_private.cleanup_expired_rooms',[]]]as const)
     await assert.rejects(asRole(role,f.host,()=>rpc(fn,[...args])),/permission denied/);
   }
   await f.start();await f.send('Guest was here',f.guest);await f.leave(f.guest);
   await assert.rejects(f.read(f.guest),/Join this room/);await assert.rejects(f.send('gone',f.guest),/Join this room/);
   await f.join(f.guest,'New ignored name');assert.equal((await f.read(f.guest)).messages.length,1);
   await db.query("update public.numora_players set last_seen_at=clock_timestamp()-interval '61 seconds' where room_id=$1 and user_id=$2",[f.id,f.guest]);
   await user(f.host,()=>rpc('public.numora_kick_player',[f.code,f.guest,f.round]));
   await assert.rejects(f.read(f.guest),/You were removed from this room by the host/);
   await assert.rejects(f.send('removed',f.guest),/You were removed from this room by the host/);
   assert.equal((await f.read()).messages[0].body,'Guest was here');
   const state=await f.join(f.late,'Angry Goose');assert.equal(state.players.find(p=>p.user_id===f.late)?.is_spectator,true);
   assert.equal((await f.send('Watching!',f.late)).messages.at(-1)?.nickname,'Angry Goose');
  });

  await t.test('server captures identity, stores literal normalized Unicode plaintext and emits only room metadata',async()=>{
   const f=await fixture(),nonce=randomUUID();
   await db.exec('truncate realtime.chat_notifications');
   const snapshot=await f.send('\ufeff\u00a0 Cafe\u0301\n\t<script>alert("x")</script> \u3000',f.host,nonce);
   assert.equal(snapshot.room_id,f.id);assert.ok(Date.parse(snapshot.expires_at)>Date.parse(snapshot.server_now));
   const message=snapshot.messages[0];assert.equal(message.body,'Café\n\t<script>alert("x")</script>');
   assert.equal(message.user_id,f.host);assert.equal(message.nickname,'Hungry Goose');assert.equal(message.client_id,nonce);
   assert.notEqual(message.id,nonce);assert.ok(Math.abs(Date.parse(message.created_at)-Date.parse(snapshot.server_now))<5000);
   const notice=(await db.query('select * from realtime.chat_notifications')).rows;
   assert.deepEqual(notice,[{payload:{room_id:f.id},event:'room-chat',topic:`numora-room:${f.id}`,private:true}]);
   assert.equal(JSON.stringify(snapshot).includes('solution'),false);
   for(const body of['',' \n\t ','a'.repeat(501),'a\u0001b','a\u000bb','a\u000cb','a\u007fb'])await assert.rejects(f.send(body),/1 to 500 characters/);
   assert.equal((await f.send('😀'.repeat(500))).messages.at(-1)?.body.length,1000);
   await assert.rejects(user(f.host,()=>rpc('public.numora_send_room_message',[f.code,f.id,null,'hi'])),/retry ID/);
   await assert.rejects(user(f.host,()=>rpc('public.numora_send_room_message',[f.code,f.id,randomUUID(),null])),/1 to 500 characters/);
  });

  await t.test('idempotent retries precede rate limiting and cannot change an already sent message',async()=>{
   const f=await fixture(),nonce=randomUUID(),first=await f.send('hello',f.host,nonce);
   assert.equal((await f.send(' hello ',f.host,nonce)).messages[0].id,first.messages[0].id);
   await assert.rejects(f.send('changed',f.host,nonce),/retry does not match/);
   for(let i=1;i<20;i++)await f.send(`message ${i}`);
   await assert.rejects(f.send('too many'),/Too many requests/);
   const retry=await f.send('hello',f.host,nonce);assert.equal(retry.messages.length,20);assert.equal(retry.messages[0].id,first.messages[0].id);
   const limits=(await db.query<{request_count:number}>("select request_count from numora_private.rate_limits where user_id=$1 and action='room_chat'",[f.host])).rows[0];
   assert.equal(limits.request_count,20);
  });

  await t.test('latest 100 messages are ascending and stable on timestamp ties, while retained nonce history still prevents duplicates',async()=>{
   const f=await fixture(),oldNonce=randomUUID();await f.send('old message',f.host,oldNonce);
   await db.query(`insert into numora_private.chat_messages(room_id,client_id,user_id,nickname,body,created_at)
    select $1,gen_random_uuid(),$2,'Hungry Goose','history '||n,
      (select created_at+interval '1 second' from numora_private.chat_messages where room_id=$1 and client_id=$3)
    from generate_series(1,110)n`,[f.id,f.host,oldNonce]);
   const snapshot=await f.read();assert.equal(snapshot.messages.length,100);assert.equal(snapshot.messages.some(m=>m.client_id===oldNonce),false);
   const sorted=[...snapshot.messages].sort((a,b)=>Date.parse(a.created_at)-Date.parse(b.created_at)||a.id.localeCompare(b.id));
   assert.deepEqual(snapshot.messages,sorted);
   assert.equal(new Set(snapshot.messages.map(m=>m.created_at)).size,1);
   assert.equal((await f.send('old message',f.host,oldNonce)).messages.length,100);
   assert.equal((await db.query<{count:number}>('select count(*)::int as count from numora_private.chat_messages where room_id=$1',[f.id])).rows[0].count,111);
   const before=(await f.read()).messages.map(m=>m.id);
   await db.exec(chatMigration);assert.deepEqual((await f.read()).messages.map(m=>m.id),before);
  });

  await t.test('chat stays available through pause, finish and the next round, without entering round archives',async()=>{
   const f=await fixture();await f.send('lobby');await f.start();
   const paused=await user(f.host,()=>rpc('public.numora_pause_room',[f.code,f.round,0]));
   assert.ok(paused);await f.send('paused');
   await user(f.host,()=>rpc('public.numora_give_up_room',[f.code,f.round]));await user(f.guest,()=>rpc('public.numora_give_up_room',[f.code,f.round]));
   await f.send('finished');
   await asRole('service_role',null,()=>rpc('public.numora_prepare_room_grid',[f.host,f.code,f.round,'finished',JSON.stringify(board)],['','','','','::jsonb']));
   assert.deepEqual((await f.send('next lobby')).messages.map(m=>m.body),['lobby','paused','finished','next lobby']);
   assert.equal(JSON.stringify((await db.query('select * from numora_private.room_round_results where room_id=$1',[f.id])).rows).includes('next lobby'),false);
  });

  await t.test('expired rooms reject heartbeat, rejoin, spectate, chat and mutations without resurrection, and disappear behind RLS',async()=>{
   const f=await fixture();await f.start();await f.join(f.late,'Spectating Goose');await f.send('expires');await f.age();
   const activity=async()=>(await db.query<{activity:string}>('select last_activity_at::text as activity from public.numora_rooms where id=$1',[f.id])).rows[0].activity;
   const before=await activity();
   await assert.rejects(user(f.host,()=>rpc('public.numora_get_room',[f.code])),expired);
   const rejoin=await f.join(f.guest,'Guest') as unknown as {error:string;code:string};assert.equal(rejoin.code,'ROOM_EXPIRED');assert.match(rejoin.error,expired);
   await assert.rejects(user(f.late,()=>rpc('public.numora_spectate_player',[f.code,f.host,f.round,0])),expired);
   await assert.rejects(f.read(),expired);await assert.rejects(f.send('no resurrection'),expired);
   await assert.rejects(user(f.host,()=>rpc('public.numora_give_up_room',[f.code,f.round])),expired);
   await assert.rejects(db.query('update public.numora_rooms set last_activity_at=clock_timestamp() where id=$1',[f.id]),expired);
   await assert.rejects(db.query('update public.numora_players set last_seen_at=clock_timestamp() where room_id=$1',[f.id]),expired);
   assert.equal(await activity(),before);
   await user(f.host,async()=>{
    assert.equal((await db.query('select * from public.numora_rooms where id=$1',[f.id])).rows.length,0);
    assert.equal(await rpc<boolean>('numora_private.is_member',[f.id]),false);
    assert.equal(await rpc<boolean>('numora_private.can_use_channel',[`numora-room:${f.id}`]),false);
   });
   await db.exec(chatMigration);assert.equal(await activity(),before);
   assert.equal((await db.query<{count:number}>('select numora_private.cleanup_expired_rooms() as count')).rows[0].count,1);
   await assert.rejects(user(f.host,()=>rpc('public.numora_get_room',[f.code])),expired);
  });

  await t.test('cleanup cascades private chat and live state while preserving historical standings and active rooms',async()=>{
   const f=await fixture(),live=await fixture();await f.start();await f.send('private doomed text');
   await user(f.host,()=>rpc('public.numora_give_up_room',[f.code,f.round]));await user(f.guest,()=>rpc('public.numora_give_up_room',[f.code,f.round]));
   await asRole('service_role',null,()=>rpc('public.numora_prepare_room_grid',[f.host,f.code,f.round,'finished',JSON.stringify(board)],['','','','','::jsonb']));
   await db.query("update public.numora_players set last_seen_at=clock_timestamp()-interval '61 seconds' where room_id=$1 and user_id=$2",[f.id,f.guest]);
   const current=await user(f.host,()=>rpc('public.numora_get_room',[f.code]));await user(f.host,()=>rpc('public.numora_kick_player',[f.code,f.guest,current.room.round_id]));
   await f.age();assert.equal(await rpc<number>('numora_private.cleanup_expired_rooms'),1);
   for(const table of['public.numora_rooms','public.numora_players','numora_private.chat_messages','numora_private.puzzles','numora_private.progress','numora_private.room_kicks']){
    const column=table==='public.numora_rooms'?'id':'room_id';assert.equal((await db.query(`select * from ${table} where ${column}=$1`,[f.id])).rows.length,0);
   }
   const archive=(await db.query('select * from numora_private.room_round_results where room_id=$1',[f.id])).rows;assert.equal(archive.length,1);
   assert.equal(JSON.stringify(archive).includes('private doomed text'),false);assert.equal((await live.read()).room_id,live.id);
   assert.equal(await rpc<number>('numora_private.cleanup_expired_rooms'),0);
   // PGlite intentionally has no Cron extension. Its migration branch must be
   // portable while production registers exactly one named five-minute job.
   assert.match(chatMigration,/cron\.schedule\(\$1,\$2,\$3\)/);assert.match(chatMigration,/'numora-expire-rooms','\*\/5 \* \* \* \*'/);
   assert.match(chatMigration,/limit 200 for update skip locked/);
  });

  await t.test('cleanup removes at most 200 locked expired rooms in one call',async()=>{
   const f=await fixture();
   await db.query(`insert into public.numora_rooms(id,round_id,code,host_id,size,difficulty,last_activity_at)
     select gen_random_uuid(),gen_random_uuid(),'E'||lpad(n::text,5,'0'),$1,5,'Easy',clock_timestamp()-interval '25 hours'
     from generate_series(1,205)n`,[f.host]);
   assert.equal(await rpc<number>('numora_private.cleanup_expired_rooms'),200);
   assert.equal(await rpc<number>('numora_private.cleanup_expired_rooms'),5);
   assert.equal(await rpc<number>('numora_private.cleanup_expired_rooms'),0);
   assert.equal((await f.read()).room_id,f.id);
  });
 }finally{await db.close();}
});
