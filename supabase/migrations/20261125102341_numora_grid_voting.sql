-- Ballots are advisory and scoped to a round and its lobby/results phase.
-- Existing active rooms and their progress remain untouched by this migration.
alter table public.numora_players add column if not exists grid_vote_size integer;
alter table public.numora_players add column if not exists grid_vote_difficulty text;
alter table public.numora_players add column if not exists grid_vote_phase text;
alter table public.numora_players add column if not exists grid_vote_round_id uuid;
do $$ begin
  if not exists(select 1 from pg_constraint where conname='numora_player_grid_vote' and conrelid='public.numora_players'::regclass) then
    alter table public.numora_players add constraint numora_player_grid_vote check (
      (grid_vote_size is null and grid_vote_difficulty is null and grid_vote_phase is null and grid_vote_round_id is null)
      or (grid_vote_size is not null and grid_vote_difficulty is not null and grid_vote_phase is not null and grid_vote_round_id is not null
        and grid_vote_size between 5 and 8 and grid_vote_difficulty in ('Easy','Medium','Hard') and grid_vote_phase in ('lobby','finished'))
    );
  end if;
end $$;

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

create or replace function numora_private.vote_grid(p_code text,p_round_id uuid,p_phase text,p_size integer,p_difficulty text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user uuid := numora_private.require_user(); r public.numora_rooms%rowtype;
begin
  -- All race mutations acquire the room lock before player rows.
  select * into r from public.numora_rooms where code=numora_private.normalized_code(p_code) for update;
  if not found or not exists(select 1 from public.numora_players where room_id=r.id and user_id=v_user and active) then
    raise exception using errcode='42501', message='Join this room before voting for a grid.';
  end if;
  if p_round_id is null or p_round_id <> r.round_id then
    raise exception using errcode='22023', message='This round has changed. Refresh the room and try again.';
  end if;
  if p_phase is null or p_phase not in ('lobby','finished') or r.status <> p_phase then
    raise exception using errcode='22023', message='Grid voting has moved to a different phase. Refresh the room and try again.';
  end if;
  if not ((p_size is null and p_difficulty is null) or
    (p_size is not null and p_difficulty is not null and p_size between 5 and 8 and p_difficulty in ('Easy','Medium','Hard'))) then
    raise exception using errcode='22023', message='Choose a grid size from 5 to 8 and Easy, Medium, or Hard.';
  end if;
  perform numora_private.rate_limit(v_user,'grid_vote',60,60);
  update public.numora_players set grid_vote_size=p_size,grid_vote_difficulty=p_difficulty,
    grid_vote_phase=case when p_size is null then null else p_phase end,
    grid_vote_round_id=case when p_size is null then null else r.round_id end,last_seen_at=clock_timestamp()
    where room_id=r.id and user_id=v_user;
  -- A vote cannot change the selected board, readiness, or any player's progress.
  return numora_private.get_room(r.code);
end;
$$;

create or replace function public.numora_vote_grid(p_code text,p_round_id uuid,p_phase text,p_size integer,p_difficulty text)
returns jsonb language sql security invoker set search_path='' as $$
  select numora_private.vote_grid(p_code,p_round_id,p_phase,p_size,p_difficulty);
$$;
revoke execute on function public.numora_vote_grid(text,uuid,text,integer,text),numora_private.vote_grid(text,uuid,text,integer,text) from public,anon,authenticated,service_role;
grant execute on function public.numora_vote_grid(text,uuid,text,integer,text),numora_private.vote_grid(text,uuid,text,integer,text) to authenticated;

-- A verified Edge Function supplies the host identity and generates the board.
-- Members cannot call this trusted entry point directly or forge the host ID.
create or replace function numora_private.prepare_room_grid(p_host_id uuid,p_code text,p_round_id uuid,p_phase text,p_puzzle jsonb)
returns text language plpgsql security definer set search_path='' as $$
declare r public.numora_rooms%rowtype; v_now timestamptz; v_results jsonb; v_size integer; v_difficulty text;
begin
  select * into r from public.numora_rooms where code=numora_private.normalized_code(p_code) for update;
  if not found or p_host_id is null or r.host_id <> p_host_id or
    not exists(select 1 from public.numora_players where room_id=r.id and user_id=p_host_id) then
    raise exception using errcode='42501', message='Only the room host can choose the final grid.';
  end if;
  if p_round_id is null or p_round_id <> r.round_id then
    raise exception using errcode='22023', message='This round has changed. Refresh the room and try again.';
  end if;
  if p_phase is null or p_phase not in ('lobby','finished') or r.status <> p_phase then
    raise exception using errcode='22023', message='Grid choice has moved to a different phase. Refresh the room and try again.';
  end if;
  if r.status='finished' and (r.starts_at is null or
    exists(select 1 from public.numora_players where room_id=r.id and finished_at is null and given_up_at is null)) then
    raise exception using errcode='P0001', message='Wait until every player has finished or given up before choosing the next grid.';
  end if;
  if not numora_private.puzzle_valid(p_puzzle) then
    raise exception using errcode='22023', message='The generated puzzle failed its integrity checks.';
  end if;
  v_size:=(p_puzzle->>'size')::integer;
  v_difficulty:=p_puzzle->>'difficulty';
  perform numora_private.rate_limit(p_host_id,'grid_choice',10,600);
  v_now:=clock_timestamp();
  if r.status='finished' then
    select jsonb_agg(jsonb_build_object('user_id',user_id,'nickname',nickname,
      'finished_at',finished_at,'given_up_at',given_up_at,'elapsed_ms',elapsed_ms) order by elapsed_ms nulls last,user_id)
      into v_results from public.numora_players where room_id=r.id;
    -- Archive the original round's settings, never the host's new choice.
    insert into numora_private.room_round_results(room_id,round_id,size,difficulty,starts_at,finished_at,results)
      select r.id,r.round_id,r.size,r.difficulty,r.starts_at,max(coalesce(finished_at,given_up_at)),v_results
      from public.numora_players where room_id=r.id;
  end if;
  update numora_private.puzzles set data=p_puzzle where room_id=r.id;
  update numora_private.progress set values=numora_private.int_array(p_puzzle->'givens',v_size*v_size,v_size,true),
    notes=numora_private.empty_notes(v_size*v_size),updated_at=v_now where room_id=r.id;
  update public.numora_players set ready=false,resume_ready=false,progress_count=0,finished_at=null,given_up_at=null,elapsed_ms=null,
    grid_vote_size=null,grid_vote_difficulty=null,grid_vote_phase=null,grid_vote_round_id=null where room_id=r.id;
  -- Changing even a lobby grid retires its token, invalidating delayed readiness/start requests.
  update public.numora_rooms set round_id=gen_random_uuid(),status='lobby',size=v_size,difficulty=v_difficulty,
    starts_at=null,paused_at=null,resumes_at=null,paused_ms=0,pause_id=null,pause_version=0,updated_at=v_now where id=r.id;
  return r.code;
end;
$$;

create or replace function public.numora_prepare_room_grid(p_host_id uuid,p_code text,p_round_id uuid,p_phase text,p_puzzle jsonb)
returns text language sql security invoker set search_path='' as $$
  select numora_private.prepare_room_grid(p_host_id,p_code,p_round_id,p_phase,p_puzzle);
$$;
revoke execute on function public.numora_prepare_room_grid(uuid,text,uuid,text,jsonb),numora_private.prepare_room_grid(uuid,text,uuid,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.numora_prepare_room_grid(uuid,text,uuid,text,jsonb),numora_private.prepare_room_grid(uuid,text,uuid,text,jsonb) to service_role;

notify pgrst, 'reload schema';
