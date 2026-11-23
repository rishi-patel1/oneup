-- Keep the room and roster for another server-generated, independently timed round.
-- Initial round IDs equal room IDs so existing clients can finish their first round.
alter table public.numora_rooms add column if not exists round_id uuid;
update public.numora_rooms set round_id=id where round_id is null;
alter table public.numora_rooms alter column round_id set not null;

create table if not exists numora_private.room_round_results (
  -- Historical standings survive closing the empty next-round lobby.
  room_id uuid not null,
  round_id uuid not null,
  size integer not null check (size between 5 and 8),
  difficulty text not null check (difficulty in ('Easy','Medium','Hard')),
  starts_at timestamptz not null,
  finished_at timestamptz not null,
  results jsonb not null,
  recorded_at timestamptz not null default clock_timestamp(),
  primary key (room_id,round_id)
);
alter table numora_private.room_round_results enable row level security;
revoke all on numora_private.room_round_results from public,anon,authenticated,service_role;



create or replace function numora_private.get_room(p_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := numora_private.require_user();
  r public.numora_rooms%rowtype;
  v_puzzle jsonb; v_progress jsonb; v_players jsonb;
  v_now timestamptz := clock_timestamp();
begin
  select * into r from public.numora_rooms where code = numora_private.normalized_code(p_code) for share;
  if not found or not exists(select 1 from public.numora_players where room_id=r.id and user_id=v_user) then
    raise exception using errcode='42501', message='Join this room with its code first.';
  end if;
  v_now := clock_timestamp();
  select coalesce(jsonb_agg(jsonb_build_object(
    'user_id', p.user_id, 'nickname', p.nickname, 'ready', p.ready, 'active', p.active,
    'progress_count', p.progress_count, 'finished_at', p.finished_at, 'elapsed_ms', p.elapsed_ms,
    'joined_at', p.joined_at
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
      into v_progress from numora_private.progress pr where pr.room_id=r.id and pr.user_id=v_user;
  end if;
  return jsonb_build_object(
    'room', jsonb_build_object('id',r.id,'round_id',r.round_id,'code',r.code,'host_id',r.host_id,'status',r.status,
      'size',r.size,'difficulty',r.difficulty,'starts_at',r.starts_at,'created_at',r.created_at),
    'players',v_players,'self',v_progress,'puzzle',v_puzzle,'server_now',v_now
  );
end;
$$;

create or replace function numora_private.create_room(p_host_id uuid, p_nickname text, p_puzzle jsonb)
returns text language plpgsql security definer set search_path = '' as $$
declare v_id uuid := gen_random_uuid(); v_code text; v_name text; v_at integer;
begin
  -- Only the service-role wrapper can execute this trusted Edge Function entry point.
  if p_host_id is null or not exists(select 1 from auth.users where id=p_host_id) then
    raise exception using errcode='42501', message='A valid signed-in host is required.';
  end if;
  v_name := numora_private.checked_nickname(p_nickname);
  if not numora_private.puzzle_valid(p_puzzle) then
    raise exception using errcode='22023', message='The generated puzzle failed its integrity checks.';
  end if;
  perform numora_private.rate_limit(p_host_id,'create',5,600);
  if (select count(*) from public.numora_rooms r where r.host_id=p_host_id and r.status in ('lobby','racing') and r.created_at>clock_timestamp()-interval '1 day' and exists(select 1 from public.numora_players p where p.room_id=r.id and p.active)) >= 5 then
    raise exception using errcode='P0001', message='You already have five open rooms. Reuse a room or try again later.';
  end if;
  for v_at in 1..10 loop
    v_code := upper(substr(replace(gen_random_uuid()::text,'-',''),1,6));
    begin
      insert into public.numora_rooms(id,round_id,code,host_id,size,difficulty)
      values(v_id,v_id,v_code,p_host_id,(p_puzzle->>'size')::integer,p_puzzle->>'difficulty');
      exit;
    exception when unique_violation then
      if v_at=10 then raise exception 'Could not allocate a room code. Please try again.'; end if;
    end;
  end loop;
  insert into numora_private.puzzles(room_id,data) values(v_id,p_puzzle);
  insert into public.numora_players(room_id,user_id,nickname) values(v_id,p_host_id,v_name);
  insert into numora_private.progress(room_id,user_id,values,notes)
  values(v_id,p_host_id,numora_private.int_array(p_puzzle->'givens',((p_puzzle->>'size')::integer*(p_puzzle->>'size')::integer),(p_puzzle->>'size')::integer,true),
    numora_private.empty_notes(((p_puzzle->>'size')::integer*(p_puzzle->>'size')::integer)));
  return v_code;
end;
$$;

create or replace function numora_private.set_ready(p_code text, p_ready boolean, p_round_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_user uuid := numora_private.require_user(); r public.numora_rooms%rowtype;
begin
  select * into r from public.numora_rooms where code=numora_private.normalized_code(p_code) for update;
  if not found or not exists(select 1 from public.numora_players where room_id=r.id and user_id=v_user) then
    raise exception using errcode='42501', message='Join this room first.';
  end if;
  if coalesce(p_round_id,r.id) <> r.round_id then
    raise exception using errcode='22023', message='This round has changed. Refresh the room and try again.';
  end if;
  if r.status <> 'lobby' then raise exception using errcode='P0001', message='Readiness is locked after the race starts.'; end if;
  if p_ready is null then raise exception using errcode='22023', message='Choose a ready state.'; end if;
  update public.numora_players set ready=p_ready,active=true,last_seen_at=clock_timestamp() where room_id=r.id and user_id=v_user;
  return numora_private.get_room(r.code);
end;
$$;

create or replace function public.numora_set_ready(p_code text, p_ready boolean, p_round_id uuid)
returns jsonb language sql security invoker set search_path = '' as $$
  select numora_private.set_ready(p_code,p_ready,p_round_id);
$$;

revoke execute on function public.numora_set_ready(text,boolean,uuid),numora_private.set_ready(text,boolean,uuid) from public,anon,authenticated,service_role;
grant execute on function public.numora_set_ready(text,boolean,uuid),numora_private.set_ready(text,boolean,uuid) to authenticated;

create or replace function numora_private.set_ready(p_code text, p_ready boolean)
returns jsonb language sql security invoker set search_path = '' as $$
  select numora_private.set_ready(p_code,p_ready,null::uuid);
$$;
create or replace function public.numora_set_ready(p_code text, p_ready boolean)
returns jsonb language sql security invoker set search_path = '' as $$
  select numora_private.set_ready(p_code,p_ready,null::uuid);
$$;
revoke execute on function public.numora_set_ready(text,boolean),numora_private.set_ready(text,boolean) from public,anon,authenticated,service_role;
grant execute on function public.numora_set_ready(text,boolean),numora_private.set_ready(text,boolean) to authenticated;

create or replace function numora_private.start_room(p_code text, p_round_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_user uuid := numora_private.require_user(); r public.numora_rooms%rowtype; v_count integer;
begin
  select * into r from public.numora_rooms where code=numora_private.normalized_code(p_code) for update;
  if not found or r.host_id <> v_user or not exists(select 1 from public.numora_players where room_id=r.id and user_id=v_user) then
    raise exception using errcode='42501', message='Only the room host can start the race.';
  end if;
  if coalesce(p_round_id,r.id) <> r.round_id then
    raise exception using errcode='22023', message='This round has changed. Refresh the room and try again.';
  end if;
  if r.status <> 'lobby' then return numora_private.get_room(r.code); end if;
  select count(*) into v_count from public.numora_players where room_id=r.id;
  if v_count < 2 then raise exception using errcode='P0001', message='Invite at least one other player before starting.'; end if;
  if exists(select 1 from public.numora_players where room_id=r.id and not ready) then
    raise exception using errcode='P0001', message='Wait until every player is ready.';
  end if;
  update public.numora_rooms set status='racing',starts_at=clock_timestamp()+interval '5 seconds',updated_at=clock_timestamp() where id=r.id;
  return numora_private.get_room(r.code);
end;
$$;

create or replace function public.numora_start_room(p_code text, p_round_id uuid)
returns jsonb language sql security invoker set search_path = '' as $$
  select numora_private.start_room(p_code,p_round_id);
$$;

revoke execute on function public.numora_start_room(text,uuid),numora_private.start_room(text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.numora_start_room(text,uuid),numora_private.start_room(text,uuid) to authenticated;

create or replace function numora_private.start_room(p_code text)
returns jsonb language sql security invoker set search_path = '' as $$
  select numora_private.start_room(p_code,null::uuid);
$$;
create or replace function public.numora_start_room(p_code text)
returns jsonb language sql security invoker set search_path = '' as $$
  select numora_private.start_room(p_code,null::uuid);
$$;
revoke execute on function public.numora_start_room(text),numora_private.start_room(text) from public,anon,authenticated,service_role;
grant execute on function public.numora_start_room(text),numora_private.start_room(text) to authenticated;

create or replace function numora_private.save_progress(p_code text, p_values integer[], p_notes jsonb, p_round_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_user uuid := numora_private.require_user(); r public.numora_rooms%rowtype; v_puzzle jsonb; v_count integer;
begin
  select * into r from public.numora_rooms where code=numora_private.normalized_code(p_code) for update;
  if not found or not exists(select 1 from public.numora_players where room_id=r.id and user_id=v_user) then
    raise exception using errcode='42501', message='Join this room first.';
  end if;
  if coalesce(p_round_id,r.id) <> r.round_id then
    raise exception using errcode='22023', message='This round has changed. Refresh the room and try again.';
  end if;
  if exists(select 1 from public.numora_players where room_id=r.id and user_id=v_user and finished_at is not null) then return numora_private.get_room(r.code); end if;
  if r.status <> 'racing' or r.starts_at is null or clock_timestamp() < r.starts_at then
    raise exception using errcode='P0001', message='The race has not started yet.';
  end if;
  select data into v_puzzle from numora_private.puzzles where room_id=r.id;
  if not numora_private.board_valid(v_puzzle,p_values,false) or not numora_private.notes_valid(p_notes,p_values,r.size) then
    raise exception using errcode='22023', message='Progress must preserve the fixed clues and contain valid board digits and notes.';
  end if;
  select count(*) into v_count from generate_series(1,r.size*r.size) i
    where p_values[i] <> 0 and (v_puzzle->'givens'->>(i-1))::integer=0;
  update numora_private.progress set values=p_values,notes=p_notes,updated_at=clock_timestamp() where room_id=r.id and user_id=v_user;
  update public.numora_players set progress_count=v_count,active=true,last_seen_at=clock_timestamp() where room_id=r.id and user_id=v_user;
  return numora_private.get_room(r.code);
end;
$$;

create or replace function public.numora_save_progress(p_code text, p_values integer[], p_notes jsonb, p_round_id uuid)
returns jsonb language sql security invoker set search_path = '' as $$
  select numora_private.save_progress(p_code,p_values,p_notes,p_round_id);
$$;

revoke execute on function public.numora_save_progress(text,integer[],jsonb,uuid),numora_private.save_progress(text,integer[],jsonb,uuid) from public,anon,authenticated,service_role;
grant execute on function public.numora_save_progress(text,integer[],jsonb,uuid),numora_private.save_progress(text,integer[],jsonb,uuid) to authenticated;

create or replace function numora_private.save_progress(p_code text, p_values integer[], p_notes jsonb)
returns jsonb language sql security invoker set search_path = '' as $$
  select numora_private.save_progress(p_code,p_values,p_notes,null::uuid);
$$;
create or replace function public.numora_save_progress(p_code text, p_values integer[], p_notes jsonb)
returns jsonb language sql security invoker set search_path = '' as $$
  select numora_private.save_progress(p_code,p_values,p_notes,null::uuid);
$$;
revoke execute on function public.numora_save_progress(text,integer[],jsonb),numora_private.save_progress(text,integer[],jsonb) from public,anon,authenticated,service_role;
grant execute on function public.numora_save_progress(text,integer[],jsonb),numora_private.save_progress(text,integer[],jsonb) to authenticated;

create or replace function numora_private.submit_solution(p_code text, p_values integer[], p_notes jsonb, p_round_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_user uuid := numora_private.require_user(); r public.numora_rooms%rowtype; v_puzzle jsonb; v_count integer; v_now timestamptz;
begin
  -- Every write takes the room lock first, then the player/progress rows.
  select * into r from public.numora_rooms where code=numora_private.normalized_code(p_code) for update;
  if not found or not exists(select 1 from public.numora_players where room_id=r.id and user_id=v_user) then
    raise exception using errcode='42501', message='Join this room first.';
  end if;
  if coalesce(p_round_id,r.id) <> r.round_id then
    raise exception using errcode='22023', message='This round has changed. Refresh the room and try again.';
  end if;
  if exists(select 1 from public.numora_players where room_id=r.id and user_id=v_user and finished_at is not null) then return numora_private.get_room(r.code); end if;
  v_now := clock_timestamp();
  if r.status <> 'racing' or r.starts_at is null or v_now < r.starts_at then
    raise exception using errcode='P0001', message='The race has not started yet.';
  end if;
  select data into v_puzzle from numora_private.puzzles where room_id=r.id;
  if not numora_private.board_valid(v_puzzle,p_values,true) or not numora_private.notes_valid(p_notes,p_values,r.size) then
    raise exception using errcode='22023', message='The board is not complete or breaks a segment rule. Keep solving.';
  end if;
  select count(*) into v_count from generate_series(1,r.size*r.size) i where (v_puzzle->'givens'->>(i-1))::integer=0;
  update numora_private.progress set values=p_values,notes=p_notes,updated_at=v_now where room_id=r.id and user_id=v_user;
  update public.numora_players set progress_count=v_count,active=true,finished_at=v_now,
    elapsed_ms=greatest(0,floor(extract(epoch from (v_now-r.starts_at))*1000)::bigint),last_seen_at=v_now
    where room_id=r.id and user_id=v_user;
  if (select count(*) from public.numora_players where room_id=r.id) >= 2 and
    not exists(select 1 from public.numora_players where room_id=r.id and finished_at is null) then
    update public.numora_rooms set status='finished',updated_at=v_now where id=r.id;
  end if;
  return numora_private.get_room(r.code);
end;
$$;

create or replace function public.numora_submit_solution(p_code text, p_values integer[], p_notes jsonb, p_round_id uuid)
returns jsonb language sql security invoker set search_path = '' as $$
  select numora_private.submit_solution(p_code,p_values,p_notes,p_round_id);
$$;

revoke execute on function public.numora_submit_solution(text,integer[],jsonb,uuid),numora_private.submit_solution(text,integer[],jsonb,uuid) from public,anon,authenticated,service_role;
grant execute on function public.numora_submit_solution(text,integer[],jsonb,uuid),numora_private.submit_solution(text,integer[],jsonb,uuid) to authenticated;

create or replace function numora_private.submit_solution(p_code text, p_values integer[], p_notes jsonb)
returns jsonb language sql security invoker set search_path = '' as $$
  select numora_private.submit_solution(p_code,p_values,p_notes,null::uuid);
$$;
create or replace function public.numora_submit_solution(p_code text, p_values integer[], p_notes jsonb)
returns jsonb language sql security invoker set search_path = '' as $$
  select numora_private.submit_solution(p_code,p_values,p_notes,null::uuid);
$$;
revoke execute on function public.numora_submit_solution(text,integer[],jsonb),numora_private.submit_solution(text,integer[],jsonb) from public,anon,authenticated,service_role;
grant execute on function public.numora_submit_solution(text,integer[],jsonb),numora_private.submit_solution(text,integer[],jsonb) to authenticated;

create or replace function numora_private.leave_room(p_code text, p_round_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_user uuid := numora_private.require_user(); r public.numora_rooms%rowtype; v_host uuid;
begin
  select * into r from public.numora_rooms where code=numora_private.normalized_code(p_code) for update;
  if not found or not exists(select 1 from public.numora_players where room_id=r.id and user_id=v_user) then return '{}'::jsonb; end if;
  if coalesce(p_round_id,r.id) <> r.round_id then
    raise exception using errcode='22023', message='This round has changed. Refresh the room and try again.';
  end if;
  if r.status = 'lobby' then
    delete from public.numora_players where room_id=r.id and user_id=v_user;
    select user_id into v_host from public.numora_players where room_id=r.id order by joined_at,user_id limit 1;
    if v_host is null then
      delete from public.numora_rooms where id=r.id;
    elsif r.host_id=v_user then
      update public.numora_rooms set host_id=v_host,updated_at=clock_timestamp() where id=r.id;
    end if;
  else
    -- Keep match entries/results so refresh/rejoin cannot reset a player's clock.
    update public.numora_players set active=false,last_seen_at=clock_timestamp() where room_id=r.id and user_id=v_user;
  end if;
  return '{}'::jsonb;
end;
$$;

create or replace function public.numora_leave_room(p_code text, p_round_id uuid)
returns jsonb language sql security invoker set search_path = '' as $$
  select numora_private.leave_room(p_code,p_round_id);
$$;

revoke execute on function public.numora_leave_room(text,uuid),numora_private.leave_room(text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.numora_leave_room(text,uuid),numora_private.leave_room(text,uuid) to authenticated;

create or replace function numora_private.leave_room(p_code text)
returns jsonb language sql security invoker set search_path = '' as $$
  select numora_private.leave_room(p_code,null::uuid);
$$;
create or replace function public.numora_leave_room(p_code text)
returns jsonb language sql security invoker set search_path = '' as $$
  select numora_private.leave_room(p_code,null::uuid);
$$;
revoke execute on function public.numora_leave_room(text),numora_private.leave_room(text) from public,anon,authenticated,service_role;
grant execute on function public.numora_leave_room(text),numora_private.leave_room(text) to authenticated;

create or replace function numora_private.spectate_player(p_code text, p_player_id uuid, p_round_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := numora_private.require_user();
  r public.numora_rooms%rowtype;
  v_finished_at timestamptz;
  v_progress numora_private.progress%rowtype;
begin
  select * into r from public.numora_rooms
    where code = numora_private.normalized_code(p_code) for share;
  if not found then
    raise exception using errcode = '42501', message = 'Join this room before spectating.';
  end if;

  select finished_at into v_finished_at from public.numora_players
    where room_id = r.id and user_id = v_user;
  if not found then
    raise exception using errcode = '42501', message = 'Join this room before spectating.';
  end if;
  if coalesce(p_round_id,r.id) <> r.round_id then
    raise exception using errcode='22023', message='This round has changed. Refresh the room and try again.';
  end if;
  if v_finished_at is null then
    raise exception using errcode = '42501', message = 'Finish your puzzle before watching another player.';
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
    where pr.room_id = r.id and pr.user_id = p_player_id;
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

create or replace function public.numora_spectate_player(p_code text, p_player_id uuid, p_round_id uuid)
returns jsonb language sql security invoker set search_path = '' as $$
  select numora_private.spectate_player(p_code,p_player_id,p_round_id);
$$;

revoke execute on function public.numora_spectate_player(text,uuid,uuid),numora_private.spectate_player(text,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.numora_spectate_player(text,uuid,uuid),numora_private.spectate_player(text,uuid,uuid) to authenticated;

create or replace function numora_private.spectate_player(p_code text, p_player_id uuid)
returns jsonb language sql security invoker set search_path = '' as $$
  select numora_private.spectate_player(p_code,p_player_id,null::uuid);
$$;
create or replace function public.numora_spectate_player(p_code text, p_player_id uuid)
returns jsonb language sql security invoker set search_path = '' as $$
  select numora_private.spectate_player(p_code,p_player_id,null::uuid);
$$;
revoke execute on function public.numora_spectate_player(text,uuid),numora_private.spectate_player(text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.numora_spectate_player(text,uuid),numora_private.spectate_player(text,uuid) to authenticated;

create or replace function numora_private.rematch_room(p_host_id uuid,p_code text,p_round_id uuid,p_puzzle jsonb)
returns text language plpgsql security definer set search_path = '' as $$
declare r public.numora_rooms%rowtype; v_now timestamptz := clock_timestamp(); v_results jsonb;
begin
  -- Only the trusted Edge entry point supplies the verified host and generated board.
  select * into r from public.numora_rooms where code=numora_private.normalized_code(p_code) for update;
  if not found or p_host_id is null or r.host_id <> p_host_id or
    not exists(select 1 from public.numora_players where room_id=r.id and user_id=p_host_id) then
    raise exception using errcode='42501', message='Only the room host can create the next round.';
  end if;
  if p_round_id is null or p_round_id <> r.round_id then
    raise exception using errcode='22023', message='This round has changed. Refresh the room and try again.';
  end if;
  if r.status <> 'finished' or r.starts_at is null or
    exists(select 1 from public.numora_players where room_id=r.id and finished_at is null) then
    raise exception using errcode='P0001', message='Wait until every player has finished before creating the next round.';
  end if;
  if not numora_private.puzzle_valid(p_puzzle) or (p_puzzle->>'size')::integer <> r.size or
    p_puzzle->>'difficulty' <> r.difficulty then
    raise exception using errcode='22023', message='The generated puzzle does not match this room.';
  end if;
  perform numora_private.rate_limit(p_host_id,'rematch',10,600);
  select jsonb_agg(jsonb_build_object('user_id',user_id,'nickname',nickname,
    'finished_at',finished_at,'elapsed_ms',elapsed_ms) order by elapsed_ms,user_id)
    into v_results from public.numora_players where room_id=r.id;
  insert into numora_private.room_round_results(room_id,round_id,size,difficulty,starts_at,finished_at,results)
    select r.id,r.round_id,r.size,r.difficulty,r.starts_at,max(finished_at),v_results
    from public.numora_players where room_id=r.id;
  update numora_private.puzzles set data=p_puzzle where room_id=r.id;
  update numora_private.progress set values=numora_private.int_array(p_puzzle->'givens',r.size*r.size,r.size,true),
    notes=numora_private.empty_notes(r.size*r.size),updated_at=v_now where room_id=r.id;
  update public.numora_players set ready=false,progress_count=0,finished_at=null,elapsed_ms=null
    where room_id=r.id;
  update public.numora_rooms set round_id=gen_random_uuid(),status='lobby',starts_at=null,updated_at=v_now where id=r.id;
  return r.code;
end;
$$;

create or replace function public.numora_rematch_room(p_host_id uuid,p_code text,p_round_id uuid,p_puzzle jsonb)
returns text language sql security invoker set search_path = '' as $$
  select numora_private.rematch_room(p_host_id,p_code,p_round_id,p_puzzle);
$$;
revoke execute on function public.numora_rematch_room(uuid,text,uuid,jsonb),
  numora_private.rematch_room(uuid,text,uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.numora_rematch_room(uuid,text,uuid,jsonb),
  numora_private.rematch_room(uuid,text,uuid,jsonb) to service_role;

notify pgrst, 'reload schema';
