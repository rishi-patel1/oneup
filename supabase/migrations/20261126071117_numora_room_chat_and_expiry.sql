-- Rooms and their chat expire after 24 hours without player activity. Adding the
-- column grants existing rooms one grace period; replay never refreshes it.
alter table public.numora_rooms add column if not exists last_activity_at timestamptz not null default clock_timestamp();
create index if not exists numora_rooms_expiry on public.numora_rooms(last_activity_at,id);

create or replace function numora_private.assert_live_room(p_room uuid)
returns void language plpgsql security invoker set search_path='' as $$
begin
  if not exists(select 1 from public.numora_rooms where id=p_room and last_activity_at > clock_timestamp()-interval '24 hours') then
    raise exception using errcode='P0002',message='This room has expired. Create or join another room.';
  end if;
end;
$$;
revoke execute on function numora_private.assert_live_room(uuid) from public,anon,authenticated,service_role;

create or replace function numora_private.touch_live_room()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if old.last_activity_at <= clock_timestamp()-interval '24 hours' then
    raise exception using errcode='P0002',message='This room has expired. Create or join another room.';
  end if;
  -- Explicit timestamps are reserved for the table owner, e.g. administrative
  -- cleanup fixtures; authenticated clients have no direct update permission.
  if new.last_activity_at is not distinct from old.last_activity_at then
    new.last_activity_at := clock_timestamp();
  end if;
  return new;
end;
$$;
revoke execute on function numora_private.touch_live_room() from public,anon,authenticated,service_role;
drop trigger if exists numora_touch_live_room on public.numora_rooms;
create trigger numora_touch_live_room before update on public.numora_rooms for each row execute function numora_private.touch_live_room();

create or replace function numora_private.touch_player_room()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  update public.numora_rooms set last_activity_at=clock_timestamp() where id=new.room_id;
  return new;
end;
$$;
revoke execute on function numora_private.touch_player_room() from public,anon,authenticated,service_role;
drop trigger if exists numora_touch_player_room on public.numora_players;
create trigger numora_touch_player_room after insert or update on public.numora_players for each row execute function numora_private.touch_player_room();

-- Expired rooms are inaccessible even before the cleanup job removes them.
create or replace function numora_private.is_member(p_room uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select (select auth.uid()) is not null and exists(
    select 1 from public.numora_players p join public.numora_rooms r on r.id=p.room_id
    where p.room_id=p_room and p.user_id=(select auth.uid()) and r.last_activity_at > clock_timestamp()-interval '24 hours'
  );
$$;
create or replace function numora_private.can_use_channel(p_topic text)
returns boolean language sql stable security definer set search_path='' as $$
  select (select auth.uid()) is not null and exists(
    select 1 from public.numora_players p join public.numora_rooms r on r.id=p.room_id
    where p.user_id=(select auth.uid()) and p.active and p_topic='numora-room:'||r.id::text
      and r.last_activity_at > clock_timestamp()-interval '24 hours'
  );
$$;

create table if not exists numora_private.chat_messages (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.numora_rooms(id) on delete cascade,
  client_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  nickname text not null,
  body text not null check(char_length(body) between 1 and 500),
  created_at timestamptz not null default clock_timestamp(),
  unique(room_id,user_id,client_id)
);
create index if not exists numora_chat_recent on numora_private.chat_messages(room_id,created_at desc,id desc);
alter table numora_private.chat_messages enable row level security;
revoke all on numora_private.chat_messages from public,anon,authenticated,service_role;

create or replace function numora_private.publish_room_chat()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  update public.numora_rooms set last_activity_at=clock_timestamp() where id=new.room_id;
  -- Broadcast only invalidation metadata: chat text must not be retained in
  -- Realtime's own message table after the room and its private chat are gone.
  if to_regprocedure('realtime.send(jsonb,text,text,boolean)') is not null then
    execute 'select realtime.send($1,$2,$3,$4)'
      using jsonb_build_object('room_id',new.room_id),'room-chat','numora-room:'||new.room_id::text,true;
  end if;
  return new;
end;
$$;
revoke execute on function numora_private.publish_room_chat() from public,anon,authenticated,service_role;
drop trigger if exists numora_publish_room_chat on numora_private.chat_messages;
create trigger numora_publish_room_chat after insert on numora_private.chat_messages for each row execute function numora_private.publish_room_chat();

-- Callers hold this room lock through membership checks, rate limiting and send.
create or replace function numora_private.lock_chat_room(p_code text,p_room_id uuid)
returns public.numora_rooms language plpgsql security invoker set search_path='' as $$
declare v_user uuid := numora_private.require_user(); r public.numora_rooms%rowtype;
begin
  select * into r from public.numora_rooms where code=numora_private.normalized_code(p_code) for update;
  if not found or r.id is distinct from p_room_id then
    raise exception using errcode='P0002',message='This room has expired. Create or join another room.';
  end if;
  perform numora_private.assert_live_room(r.id);
  if exists(select 1 from numora_private.room_kicks where room_id=r.id and user_id=v_user) then
    raise exception using errcode='42501',message='You were removed from this room by the host.';
  end if;
  if not exists(select 1 from public.numora_players where room_id=r.id and user_id=v_user and active) then
    raise exception using errcode='42501',message='Join this room with its code first.';
  end if;
  return r;
end;
$$;
revoke execute on function numora_private.lock_chat_room(text,uuid) from public,anon,authenticated,service_role;

create or replace function numora_private.room_chat_snapshot(p_room uuid)
returns jsonb language sql security invoker set search_path='' as $$
  select jsonb_build_object('room_id',r.id,'expires_at',r.last_activity_at+interval '24 hours','server_now',clock_timestamp(),
    'messages',coalesce((select jsonb_agg(jsonb_build_object('id',m.id,'client_id',m.client_id,'user_id',m.user_id,
      'nickname',m.nickname,'body',m.body,'created_at',m.created_at) order by m.created_at,m.id)
      from(select * from numora_private.chat_messages where room_id=r.id order by created_at desc,id desc limit 100)m),'[]'::jsonb))
  from public.numora_rooms r where r.id=p_room;
$$;
revoke execute on function numora_private.room_chat_snapshot(uuid) from public,anon,authenticated,service_role;

create or replace function numora_private.get_room_chat(p_code text,p_room_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  perform numora_private.lock_chat_room(p_code,p_room_id);
  return numora_private.room_chat_snapshot(p_room_id);
end;
$$;

create or replace function numora_private.send_room_message(p_code text,p_room_id uuid,p_client_id uuid,p_body text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user uuid := numora_private.require_user(); v_body text; v_existing text; v_name text;
begin
  perform numora_private.lock_chat_room(p_code,p_room_id);
  if p_client_id is null then raise exception using errcode='22023',message='A message retry ID is required.'; end if;
  -- Match JavaScript trim(), then NFC, counting Unicode characters rather than
  -- bytes. Interior newlines and tabs remain literal plain text.
  v_body := pg_catalog.normalize(btrim(p_body,U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'),'NFC');
  if v_body is null or char_length(v_body) not between 1 and 500
    or v_body ~ U&'[\0001-\0008\000B\000C\000E-\001F\007F]' then
    raise exception using errcode='22023',message='Messages must contain 1 to 500 characters without control characters.';
  end if;
  select body into v_existing from numora_private.chat_messages where room_id=p_room_id and user_id=v_user and client_id=p_client_id;
  if found then
    if v_existing <> v_body then
      raise exception using errcode='22023',message='This message retry does not match the original text.';
    end if;
    return numora_private.room_chat_snapshot(p_room_id);
  end if;
  perform numora_private.rate_limit(v_user,'room_chat',20,60);
  select nickname into v_name from public.numora_players where room_id=p_room_id and user_id=v_user;
  insert into numora_private.chat_messages(room_id,client_id,user_id,nickname,body) values(p_room_id,p_client_id,v_user,v_name,v_body);
  return numora_private.room_chat_snapshot(p_room_id);
end;
$$;

create or replace function public.numora_get_room_chat(p_code text,p_room_id uuid)
returns jsonb language sql security invoker set search_path='' as $$select numora_private.get_room_chat(p_code,p_room_id);$$;
create or replace function public.numora_send_room_message(p_code text,p_room_id uuid,p_client_id uuid,p_body text)
returns jsonb language sql security invoker set search_path='' as $$select numora_private.send_room_message(p_code,p_room_id,p_client_id,p_body);$$;
revoke execute on function public.numora_get_room_chat(text,uuid),numora_private.get_room_chat(text,uuid),
  public.numora_send_room_message(text,uuid,uuid,text),numora_private.send_room_message(text,uuid,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.numora_get_room_chat(text,uuid),numora_private.get_room_chat(text,uuid),
  public.numora_send_room_message(text,uuid,uuid,text),numora_private.send_room_message(text,uuid,uuid,text) to authenticated;

-- Check expiry before reads can heartbeat a room back to life.
create or replace function numora_private.get_room(p_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := numora_private.require_user();
  r public.numora_rooms%rowtype;
  v_puzzle jsonb; v_progress jsonb; v_players jsonb;
  v_now timestamptz := clock_timestamp();
begin
  select * into r from public.numora_rooms where code = numora_private.normalized_code(p_code) for update;
  if not found then
    raise exception using errcode='P0002',message='This room has expired. Create or join another room.';
  end if;
  perform numora_private.assert_live_room(r.id);
  if found and exists(select 1 from numora_private.room_kicks where room_id=r.id and user_id=v_user) then
    raise exception using errcode='42501', message='You were removed from this room by the host.';
  end if;
  if not found or not exists(select 1 from public.numora_players where room_id=r.id and user_id=v_user) then
    raise exception using errcode='42501', message='Join this room with its code first.';
  end if;
  -- Do not write on every poll: player writes broadcast room changes to other clients.
  update public.numora_players set last_seen_at=clock_timestamp()
    where room_id=r.id and user_id=v_user and active and last_seen_at < clock_timestamp()-interval '15 seconds';
  perform numora_private.settle_room_pause(r.id);
  perform numora_private.reconcile_room_resume(r.id);
  select * into r from public.numora_rooms where id=r.id;
  v_now := clock_timestamp();
  select coalesce(jsonb_agg(jsonb_build_object(
    'user_id', p.user_id, 'nickname', p.nickname, 'ready', p.ready, 'active', p.active, 'resume_ready', p.resume_ready,
    'is_spectator',p.is_spectator,'is_away',(not p.active or p.last_seen_at <= v_now-interval '60 seconds'),
    'progress_count', p.progress_count, 'finished_at', p.finished_at, 'given_up_at', p.given_up_at, 'elapsed_ms', p.elapsed_ms,
    'joined_at', p.joined_at,
    'grid_vote', case when p.active and p.grid_vote_round_id=r.round_id and p.grid_vote_phase=r.status
      then jsonb_build_object('size',p.grid_vote_size,'difficulty',p.grid_vote_difficulty) else null end
  ) order by p.joined_at, p.user_id), '[]'::jsonb)
  into v_players from public.numora_players p where p.room_id=r.id;
  -- Neither clues nor private entries are released before the shared start.
  if r.starts_at is not null and v_now >= r.starts_at then
    select jsonb_build_object(
      'id', 'match-' || r.round_id::text, 'title', data->>'title', 'size', r.size,
      'difficulty', r.difficulty, 'description', data->>'description',
      'givens', data->'givens', 'rightWalls', data->'rightWalls', 'bottomWalls', data->'bottomWalls'
    ) into v_puzzle from numora_private.puzzles where room_id=r.id;
    select jsonb_build_object('values', pr.values, 'notes', pr.notes)
      into v_progress from numora_private.progress pr where pr.room_id=r.id and pr.user_id=v_user and exists(select 1 from public.numora_players p where p.room_id=r.id and p.user_id=v_user and not p.is_spectator);
  end if;
  return jsonb_build_object(
    'room', jsonb_build_object('id',r.id,'round_id',r.round_id,'code',r.code,'host_id',r.host_id,'status',r.status,
      'size',r.size,'difficulty',r.difficulty,'starts_at',r.starts_at,'created_at',r.created_at,
      'paused_at',r.paused_at,'resumes_at',r.resumes_at,'paused_ms',r.paused_ms,'pause_id',r.pause_id,'pause_version',r.pause_version),
    'players',v_players,'removed_results',coalesce((
      select jsonb_agg(jsonb_build_object('user_id',user_id,'nickname',nickname,'finished_at',finished_at,
        'given_up_at',given_up_at,'elapsed_ms',elapsed_ms,'removed_at',removed_at) order by removed_at,user_id)
      from numora_private.room_kicks where room_id=r.id and round_id=r.round_id and was_participant
    ),'[]'::jsonb),'self',v_progress,'puzzle',v_puzzle,'server_now',v_now
  );
end;
$$;

create or replace function numora_private.join_room(p_code text, p_nickname text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_user uuid := numora_private.require_user(); v_name text; r public.numora_rooms%rowtype; v_puzzle jsonb;
begin
  v_name := numora_private.checked_nickname(p_nickname);
  perform numora_private.rate_limit(v_user,'join',30,60);
  select * into r from public.numora_rooms where code=numora_private.normalized_code(p_code) for update;
  if not found then return jsonb_build_object('error','Room not found. Check the code and try again.','code','ROOM_NOT_FOUND'); end if;
  if r.last_activity_at <= clock_timestamp()-interval '24 hours' then
    return jsonb_build_object('error','This room has expired. Create or join another room.','code','ROOM_EXPIRED');
  end if;
  if exists(select 1 from numora_private.room_kicks where room_id=r.id and user_id=v_user) then
    raise exception using errcode='42501', message='You were removed from this room by the host.';
  end if;
  if exists(select 1 from public.numora_players where room_id=r.id and user_id=v_user) then
    perform numora_private.settle_room_pause(r.id);
    select * into r from public.numora_rooms where id=r.id;
    if r.paused_at is not null and exists(select 1 from public.numora_players where room_id=r.id and user_id=v_user and not active and not is_spectator and finished_at is null and given_up_at is null) then
      -- Membership changed: require fresh consent and invalidate any old in-flight votes.
      update public.numora_players set resume_ready=false where room_id=r.id;
      update public.numora_rooms set pause_id=gen_random_uuid(),resumes_at=null,
        pause_version=pause_version+1,updated_at=clock_timestamp() where id=r.id;
    end if;
    update public.numora_players set active=true,last_seen_at=clock_timestamp() where room_id=r.id and user_id=v_user;
    perform numora_private.reconcile_room_resume(r.id);
    return numora_private.get_room(r.code);
  end if;
  if (select count(*) from public.numora_players where room_id=r.id) >= 8 then
    return jsonb_build_object('error','This room is full. A room can have up to eight players.','code','ROOM_FULL');
  end if;
  begin
    insert into public.numora_players(room_id,user_id,nickname,is_spectator) values(r.id,v_user,v_name,r.status <> 'lobby');
  exception when unique_violation then
    return jsonb_build_object('error','That nickname is already in use in this room.','code','NICKNAME_TAKEN');
  end;
  select data into v_puzzle from numora_private.puzzles where room_id=r.id;
  insert into numora_private.progress(room_id,user_id,values,notes)
    values(r.id,v_user,numora_private.int_array(v_puzzle->'givens',r.size*r.size,r.size,true),numora_private.empty_notes(r.size*r.size));
  return numora_private.get_room(r.code);
end;
$$;

create or replace function numora_private.spectate_player(p_code text, p_player_id uuid, p_round_id uuid, p_pause_version bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := numora_private.require_user();
  r public.numora_rooms%rowtype;
  v_finished_at timestamptz; v_observer boolean;
  v_progress numora_private.progress%rowtype;
begin
  select * into r from public.numora_rooms
    where code = numora_private.normalized_code(p_code) for update;
  if not found then
    raise exception using errcode = '42501', message = 'Join this room before spectating.';
  end if;

  perform numora_private.assert_live_room(r.id);

  select coalesce(finished_at,given_up_at),is_spectator into v_finished_at,v_observer from public.numora_players
    where room_id = r.id and user_id = v_user;
  if not found then
    raise exception using errcode = '42501', message = 'Join this room before spectating.';
  end if;
  if coalesce(p_round_id,r.id) <> r.round_id then
    raise exception using errcode='22023', message='This round has changed. Refresh the room and try again.';
  end if;
  if coalesce(p_pause_version,0) <> r.pause_version then
    raise exception using errcode='22023', message='The pause state has changed. Refresh the room and try again.';
  end if;
  perform numora_private.settle_room_pause(r.id);
  select * into r from public.numora_rooms where id=r.id;
  if r.paused_at is not null then
    raise exception using errcode='P0001', message='The room is paused. Wait for everyone and the resume countdown.';
  end if;
  if v_finished_at is null and not v_observer then
    raise exception using errcode = '42501', message = 'Finish or give up your puzzle before watching another player.';
  end if;
  if r.status not in ('racing', 'finished') or r.starts_at is null or clock_timestamp() < r.starts_at then
    raise exception using errcode = '42501', message = 'The race has not started yet.';
  end if;
  if p_player_id is null or p_player_id = v_user then
    raise exception using errcode = '22023', message = 'Choose another player in this room to watch.';
  end if;

  -- The composite membership/progress key prevents a target from another room.
  select pr.* into v_progress from numora_private.progress pr
    join public.numora_players p on p.room_id = pr.room_id and p.user_id = pr.user_id
    where pr.room_id = r.id and pr.user_id = p_player_id and not p.is_spectator;
  if not found then
    raise exception using errcode = '42501', message = 'That player is not in this room.';
  end if;

  return jsonb_build_object(
    'room_id', r.id,
    'player_id', p_player_id,
    'values', v_progress.values,
    'notes', v_progress.notes,
    'updated_at', v_progress.updated_at,
    'server_now', clock_timestamp()
  );
end;
$$;
-- Each run uses a bounded locked batch and rechecks the deadline when deleting.
-- Concurrent heartbeats either win before selection or fail the expiry guard;
-- a room can never be resurrected after its inactivity deadline.
create or replace function numora_private.cleanup_expired_rooms()
returns integer language plpgsql security definer set search_path='' as $$
declare v_deleted integer; v_cutoff timestamptz := clock_timestamp()-interval '24 hours';
begin
  with expired as materialized(
    select id from public.numora_rooms where last_activity_at <= v_cutoff
      order by last_activity_at,id limit 200 for update skip locked
  ), removed as(
    delete from public.numora_rooms r using expired e where r.id=e.id
      and r.last_activity_at <= v_cutoff returning r.id
  ) select count(*)::integer into v_deleted from removed;
  return v_deleted;
end;
$$;
revoke execute on function numora_private.cleanup_expired_rooms() from public,anon,authenticated,service_role;

-- pg_cron is available on Supabase. Embedded SQL test databases omit it, so keep
-- extension installation and Cron namespace references behind runtime checks.
do $$
begin
  if exists(select 1 from pg_available_extensions where name='pg_cron') then
    execute 'create extension if not exists pg_cron with schema pg_catalog';
    execute 'grant usage on schema cron to postgres';
    execute 'grant all privileges on all tables in schema cron to postgres';
    execute 'select cron.schedule($1,$2,$3)' using 'numora-expire-rooms','*/5 * * * *','select numora_private.cleanup_expired_rooms();';
  end if;
end;
$$;
notify pgrst,'reload schema';

