-- Giving up ends only this player's round, with no finish time or solved score.
alter table public.numora_players add column if not exists given_up_at timestamptz;
do $$ begin
  if not exists(select 1 from pg_constraint where conname='numora_player_terminal_state' and conrelid='public.numora_players'::regclass) then
    alter table public.numora_players add constraint numora_player_terminal_state
      check (given_up_at is null or (finished_at is null and elapsed_ms is null));
  end if;
end $$;

-- Completed and given-up players are spectators, never resume blockers.
create or replace function numora_private.reconcile_room_resume(p_room uuid)
returns void language plpgsql security invoker set search_path='' as $$
declare r public.numora_rooms%rowtype;
begin
  select * into r from public.numora_rooms where id=p_room for update;
  if r.paused_at is null then return; end if;
  if exists(select 1 from public.numora_players where room_id=r.id and active and finished_at is null and given_up_at is null and not resume_ready) then
    if r.resumes_at is not null then
      update public.numora_rooms set resumes_at=null,pause_version=pause_version+1,updated_at=clock_timestamp() where id=r.id;
    end if;
  elsif exists(select 1 from public.numora_players where room_id=r.id and active and finished_at is null and given_up_at is null) and r.resumes_at is null then
    update public.numora_rooms set resumes_at=clock_timestamp()+interval '3 seconds',
      pause_version=pause_version+1,updated_at=clock_timestamp() where id=r.id;
  end if;
end;
$$;

create or replace function numora_private.get_room(p_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := numora_private.require_user();
  r public.numora_rooms%rowtype;
  v_puzzle jsonb; v_progress jsonb; v_players jsonb;
  v_now timestamptz := clock_timestamp();
begin
  select * into r from public.numora_rooms where code = numora_private.normalized_code(p_code) for update;
  if not found or not exists(select 1 from public.numora_players where room_id=r.id and user_id=v_user) then
    raise exception using errcode='42501', message='Join this room with its code first.';
  end if;
  perform numora_private.settle_room_pause(r.id);
  perform numora_private.reconcile_room_resume(r.id);
  select * into r from public.numora_rooms where id=r.id;
  v_now := clock_timestamp();
  select coalesce(jsonb_agg(jsonb_build_object(
    'user_id', p.user_id, 'nickname', p.nickname, 'ready', p.ready, 'active', p.active, 'resume_ready', p.resume_ready,
    'progress_count', p.progress_count, 'finished_at', p.finished_at, 'given_up_at', p.given_up_at, 'elapsed_ms', p.elapsed_ms,
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
      'size',r.size,'difficulty',r.difficulty,'starts_at',r.starts_at,'created_at',r.created_at,
      'paused_at',r.paused_at,'resumes_at',r.resumes_at,'paused_ms',r.paused_ms,'pause_id',r.pause_id,'pause_version',r.pause_version),
    'players',v_players,'self',v_progress,'puzzle',v_puzzle,'server_now',v_now
  );
end;
$$;

create or replace function numora_private.save_progress(p_code text, p_values integer[], p_notes jsonb, p_round_id uuid, p_pause_version bigint)
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
  if coalesce(p_pause_version,0) <> r.pause_version then
    raise exception using errcode='22023', message='The pause state has changed. Refresh the room and try again.';
  end if;
  perform numora_private.settle_room_pause(r.id);
  select * into r from public.numora_rooms where id=r.id;
  if r.paused_at is not null then
    raise exception using errcode='P0001', message='The room is paused. Wait for everyone and the resume countdown.';
  end if;
  if exists(select 1 from public.numora_players where room_id=r.id and user_id=v_user and (finished_at is not null or given_up_at is not null)) then return numora_private.get_room(r.code); end if;
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

create or replace function numora_private.submit_solution(p_code text, p_values integer[], p_notes jsonb, p_round_id uuid, p_pause_version bigint)
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
  if coalesce(p_pause_version,0) <> r.pause_version then
    raise exception using errcode='22023', message='The pause state has changed. Refresh the room and try again.';
  end if;
  perform numora_private.settle_room_pause(r.id);
  select * into r from public.numora_rooms where id=r.id;
  if r.paused_at is not null then
    raise exception using errcode='P0001', message='The room is paused. Wait for everyone and the resume countdown.';
  end if;
  if exists(select 1 from public.numora_players where room_id=r.id and user_id=v_user and (finished_at is not null or given_up_at is not null)) then return numora_private.get_room(r.code); end if;
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
    elapsed_ms=greatest(0,floor(extract(epoch from (v_now-r.starts_at))*1000)::bigint-r.paused_ms),last_seen_at=v_now
    where room_id=r.id and user_id=v_user;
  if (select count(*) from public.numora_players where room_id=r.id) >= 2 and
    not exists(select 1 from public.numora_players where room_id=r.id and finished_at is null and given_up_at is null) then
    update public.numora_rooms set status='finished',updated_at=v_now where id=r.id;
  end if;
  return numora_private.get_room(r.code);
end;
$$;

create or replace function numora_private.spectate_player(p_code text, p_player_id uuid, p_round_id uuid, p_pause_version bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := numora_private.require_user();
  r public.numora_rooms%rowtype;
  v_finished_at timestamptz;
  v_progress numora_private.progress%rowtype;
begin
  select * into r from public.numora_rooms
    where code = numora_private.normalized_code(p_code) for update;
  if not found then
    raise exception using errcode = '42501', message = 'Join this room before spectating.';
  end if;

  select coalesce(finished_at,given_up_at) into v_finished_at from public.numora_players
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
  if v_finished_at is null then
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

create or replace function numora_private.leave_room(p_code text, p_round_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_user uuid := numora_private.require_user(); r public.numora_rooms%rowtype; v_host uuid;
begin
  select * into r from public.numora_rooms where code=numora_private.normalized_code(p_code) for update;
  if not found or not exists(select 1 from public.numora_players where room_id=r.id and user_id=v_user) then return '{}'::jsonb; end if;
  if coalesce(p_round_id,r.id) <> r.round_id then
    raise exception using errcode='22023', message='This round has changed. Refresh the room and try again.';
  end if;
  perform numora_private.settle_room_pause(r.id);
  select * into r from public.numora_rooms where id=r.id;
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
    update public.numora_players set active=false,resume_ready=false,last_seen_at=clock_timestamp() where room_id=r.id and user_id=v_user;
  end if;
  if r.paused_at is not null and exists(select 1 from public.numora_players where room_id=r.id and user_id=v_user and finished_at is null and given_up_at is null) then
    update public.numora_rooms set pause_version=pause_version+1,updated_at=clock_timestamp() where id=r.id;
    perform numora_private.reconcile_room_resume(r.id);
  end if;
  return '{}'::jsonb;
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
  if exists(select 1 from public.numora_players where room_id=r.id and user_id=v_user) then
    perform numora_private.settle_room_pause(r.id);
    select * into r from public.numora_rooms where id=r.id;
    if r.paused_at is not null and exists(select 1 from public.numora_players where room_id=r.id and user_id=v_user and not active and finished_at is null and given_up_at is null) then
      -- Membership changed: require fresh consent and invalidate any old in-flight votes.
      update public.numora_players set resume_ready=false where room_id=r.id;
      update public.numora_rooms set pause_id=gen_random_uuid(),resumes_at=null,
        pause_version=pause_version+1,updated_at=clock_timestamp() where id=r.id;
    end if;
    update public.numora_players set active=true,last_seen_at=clock_timestamp() where room_id=r.id and user_id=v_user;
    perform numora_private.reconcile_room_resume(r.id);
    return numora_private.get_room(r.code);
  end if;
  if r.status <> 'lobby' then return jsonb_build_object('error','This race has already started.','code','RACE_STARTED'); end if;
  if (select count(*) from public.numora_players where room_id=r.id) >= 8 then
    return jsonb_build_object('error','This room is full. A room can have up to eight players.','code','ROOM_FULL');
  end if;
  begin
    insert into public.numora_players(room_id,user_id,nickname) values(r.id,v_user,v_name);
  exception when unique_violation then
    return jsonb_build_object('error','That nickname is already in use in this room.','code','NICKNAME_TAKEN');
  end;
  select data into v_puzzle from numora_private.puzzles where room_id=r.id;
  insert into numora_private.progress(room_id,user_id,values,notes)
    values(r.id,v_user,numora_private.int_array(v_puzzle->'givens',r.size*r.size,r.size,true),numora_private.empty_notes(r.size*r.size));
  return numora_private.get_room(r.code);
end;
$$;

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
    exists(select 1 from public.numora_players where room_id=r.id and finished_at is null and given_up_at is null) then
    raise exception using errcode='P0001', message='Wait until every player has finished or given up before creating the next round.';
  end if;
  if not numora_private.puzzle_valid(p_puzzle) or (p_puzzle->>'size')::integer <> r.size or
    p_puzzle->>'difficulty' <> r.difficulty then
    raise exception using errcode='22023', message='The generated puzzle does not match this room.';
  end if;
  perform numora_private.rate_limit(p_host_id,'rematch',10,600);
  select jsonb_agg(jsonb_build_object('user_id',user_id,'nickname',nickname,
    'finished_at',finished_at,'given_up_at',given_up_at,'elapsed_ms',elapsed_ms) order by elapsed_ms nulls last,user_id)
    into v_results from public.numora_players where room_id=r.id;
  insert into numora_private.room_round_results(room_id,round_id,size,difficulty,starts_at,finished_at,results)
    select r.id,r.round_id,r.size,r.difficulty,r.starts_at,max(coalesce(finished_at,given_up_at)),v_results
    from public.numora_players where room_id=r.id;
  update numora_private.puzzles set data=p_puzzle where room_id=r.id;
  update numora_private.progress set values=numora_private.int_array(p_puzzle->'givens',r.size*r.size,r.size,true),
    notes=numora_private.empty_notes(r.size*r.size),updated_at=v_now where room_id=r.id;
  update public.numora_players set ready=false,resume_ready=false,progress_count=0,finished_at=null,given_up_at=null,elapsed_ms=null
    where room_id=r.id;
  update public.numora_rooms set round_id=gen_random_uuid(),status='lobby',starts_at=null,paused_at=null,resumes_at=null,paused_ms=0,pause_id=null,pause_version=0,updated_at=v_now where id=r.id;
  return r.code;
end;
$$;

create or replace function numora_private.pause_room(p_code text,p_round_id uuid,p_pause_version bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user uuid := numora_private.require_user(); r public.numora_rooms%rowtype; v_now timestamptz;
begin
  select * into r from public.numora_rooms where code=numora_private.normalized_code(p_code) for update;
  if not found or not exists(select 1 from public.numora_players where room_id=r.id and user_id=v_user and active and finished_at is null and given_up_at is null) then
    raise exception using errcode='42501', message='Only an active unfinished player can pause this room.';
  end if;
  if p_round_id is null or p_round_id <> r.round_id then
    raise exception using errcode='22023', message='This round has changed. Refresh the room and try again.';
  end if;
  if p_pause_version is null or p_pause_version <> r.pause_version then
    raise exception using errcode='22023', message='The pause state has changed. Refresh the room and try again.';
  end if;
  perform numora_private.settle_room_pause(r.id);
  select * into r from public.numora_rooms where id=r.id;
  v_now := clock_timestamp();
  if r.status <> 'racing' or r.starts_at is null or v_now < r.starts_at then
    raise exception using errcode='P0001', message='The race must be running before it can be paused.';
  end if;
  if r.paused_at is not null and r.resumes_at is null then return numora_private.get_room(r.code); end if;
  -- Pausing a pending countdown cancels it without counting the same paused time twice.
  update public.numora_rooms set paused_at=coalesce(paused_at,v_now),resumes_at=null,pause_id=gen_random_uuid(),
    pause_version=pause_version+1,updated_at=v_now where id=r.id;
  update public.numora_players set resume_ready=false where room_id=r.id;
  return numora_private.get_room(r.code);
end;
$$;

create or replace function numora_private.set_resume_ready(p_code text,p_round_id uuid,p_pause_id uuid,p_ready boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user uuid := numora_private.require_user(); r public.numora_rooms%rowtype;
begin
  select * into r from public.numora_rooms where code=numora_private.normalized_code(p_code) for update;
  if not found or not exists(select 1 from public.numora_players where room_id=r.id and user_id=v_user and active) then
    raise exception using errcode='42501', message='Join this room before resuming.';
  end if;
  if p_round_id is null or p_round_id <> r.round_id then
    raise exception using errcode='22023', message='This round has changed. Refresh the room and try again.';
  end if;
  perform numora_private.settle_room_pause(r.id);
  select * into r from public.numora_rooms where id=r.id;
  if r.status <> 'racing' or r.paused_at is null or p_pause_id is null or p_pause_id <> r.pause_id then
    raise exception using errcode='22023', message='The pause state has changed. Refresh the room and try again.';
  end if;
  if exists(select 1 from public.numora_players where room_id=r.id and user_id=v_user and
    (finished_at is not null or given_up_at is not null)) then
    return numora_private.get_room(r.code);
  end if;
  if p_ready is null then raise exception using errcode='22023', message='Choose whether you are ready to resume.'; end if;
  if exists(select 1 from public.numora_players where room_id=r.id and user_id=v_user and (resume_ready is distinct from p_ready or not active)) then
    update public.numora_players set resume_ready=p_ready,active=true,last_seen_at=clock_timestamp() where room_id=r.id and user_id=v_user;
    update public.numora_rooms set pause_version=pause_version+1,updated_at=clock_timestamp() where id=r.id;
  end if;
  perform numora_private.reconcile_room_resume(r.id);
  return numora_private.get_room(r.code);
end;
$$;

create or replace function numora_private.give_up_room(p_code text,p_round_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user uuid := numora_private.require_user(); r public.numora_rooms%rowtype; v_now timestamptz;
begin
  -- Serialize against submissions, votes and rematches before inspecting membership.
  select * into r from public.numora_rooms where code=numora_private.normalized_code(p_code) for update;
  if not found or not exists(select 1 from public.numora_players where room_id=r.id and user_id=v_user) then
    raise exception using errcode='42501', message='Join this room before giving up.';
  end if;
  if p_round_id is null or p_round_id <> r.round_id then
    raise exception using errcode='22023', message='This round has changed. Refresh the room and try again.';
  end if;
  -- Retries and a simultaneous successful finish cannot overwrite the recorded outcome.
  if exists(select 1 from public.numora_players where room_id=r.id and user_id=v_user and
    (finished_at is not null or given_up_at is not null)) then return numora_private.get_room(r.code); end if;
  perform numora_private.settle_room_pause(r.id);
  select * into r from public.numora_rooms where id=r.id;
  v_now := clock_timestamp();
  if r.status <> 'racing' or r.starts_at is null or v_now < r.starts_at then
    raise exception using errcode='P0001', message='The race must be running before giving up.';
  end if;
  update public.numora_players set given_up_at=v_now,resume_ready=false,active=true,last_seen_at=v_now
    where room_id=r.id and user_id=v_user;
  if not exists(select 1 from public.numora_players where room_id=r.id and finished_at is null and given_up_at is null) then
    -- A paused all-terminal room needs no countdown; it is immediately ready for a rematch.
    update public.numora_rooms set status='finished',paused_at=null,resumes_at=null,pause_id=null,
      pause_version=pause_version+1,updated_at=v_now where id=r.id;
  elsif r.paused_at is not null then
    update public.numora_rooms set pause_version=pause_version+1,updated_at=v_now where id=r.id;
    perform numora_private.reconcile_room_resume(r.id);
  end if;
  return numora_private.get_room(r.code);
end;
$$;

create or replace function public.numora_give_up_room(p_code text,p_round_id uuid)
returns jsonb language sql security invoker set search_path='' as $$
  select numora_private.give_up_room(p_code,p_round_id);
$$;
revoke execute on function public.numora_give_up_room(text,uuid),numora_private.give_up_room(text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.numora_give_up_room(text,uuid),numora_private.give_up_room(text,uuid) to authenticated;


notify pgrst, 'reload schema';
