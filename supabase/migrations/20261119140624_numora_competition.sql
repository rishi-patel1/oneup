-- Numora private-room competitions. Re-runnable without dropping game data.
-- Public RPCs are SECURITY INVOKER; privileged implementations stay unexposed.
create schema if not exists numora_private;
revoke all on schema numora_private from public, anon, authenticated, service_role;
grant usage on schema numora_private to authenticated, service_role;
alter default privileges in schema numora_private revoke execute on functions from public;

create table if not exists public.numora_rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z0-9]{6}$'),
  host_id uuid not null references auth.users(id),
  status text not null default 'lobby' check (status in ('lobby', 'racing', 'finished')),
  size integer not null check (size between 5 and 8),
  difficulty text not null check (difficulty in ('Easy', 'Medium', 'Hard')),
  starts_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);
create index if not exists numora_rooms_host_idx on public.numora_rooms(host_id, created_at);

create table if not exists public.numora_players (
  room_id uuid not null references public.numora_rooms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  nickname text not null check (char_length(nickname) between 2 and 24),
  ready boolean not null default false,
  active boolean not null default true,
  progress_count integer not null default 0 check (progress_count between 0 and 64),
  finished_at timestamptz,
  elapsed_ms bigint check (elapsed_ms >= 0),
  joined_at timestamptz not null default clock_timestamp(),
  last_seen_at timestamptz not null default clock_timestamp(),
  primary key (room_id, user_id),
  check ((finished_at is null) = (elapsed_ms is null))
);
create index if not exists numora_players_user_idx on public.numora_players(user_id, room_id);
create unique index if not exists numora_players_nickname_idx on public.numora_players(room_id, lower(nickname));

create table if not exists numora_private.puzzles (
  room_id uuid primary key references public.numora_rooms(id) on delete cascade,
  data jsonb not null
);
create table if not exists numora_private.progress (
  room_id uuid not null,
  user_id uuid not null,
  values integer[] not null,
  notes jsonb not null,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (room_id, user_id),
  foreign key (room_id, user_id) references public.numora_players(room_id, user_id) on delete cascade
);
create index if not exists numora_progress_user_idx on numora_private.progress(user_id, room_id);
create table if not exists numora_private.rate_limits (
  user_id uuid not null references auth.users(id) on delete cascade,
  action text not null,
  window_started timestamptz not null,
  request_count integer not null,
  primary key (user_id, action)
);

alter table public.numora_rooms enable row level security;
alter table public.numora_players enable row level security;
alter table numora_private.puzzles enable row level security;
alter table numora_private.progress enable row level security;
alter table numora_private.rate_limits enable row level security;
revoke all on public.numora_rooms, public.numora_players from public, anon, authenticated;
revoke all on numora_private.puzzles, numora_private.progress, numora_private.rate_limits from public, anon, authenticated, service_role;
grant select on public.numora_rooms, public.numora_players to authenticated;

create or replace function numora_private.is_member(p_room uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select (select auth.uid()) is not null and exists (
    select 1 from public.numora_players p
    where p.room_id = p_room and p.user_id = (select auth.uid())
  );
$$;

create or replace function numora_private.can_use_channel(p_topic text)
returns boolean language sql stable security definer set search_path = '' as $$
  select (select auth.uid()) is not null and exists (
    select 1 from public.numora_players p
    where p.user_id = (select auth.uid())
      and p_topic = 'numora-room:' || p.room_id::text
  );
$$;

drop policy if exists numora_member_rooms on public.numora_rooms;
create policy numora_member_rooms on public.numora_rooms for select to authenticated
  using (numora_private.is_member(id));
drop policy if exists numora_member_players on public.numora_players;
create policy numora_member_players on public.numora_players for select to authenticated
  using (numora_private.is_member(room_id));

-- Realtime is managed by Supabase: only policy changes, never ALTER its objects.
drop policy if exists numora_realtime_receive on realtime.messages;
create policy numora_realtime_receive on realtime.messages for select to authenticated
  using (extension in ('broadcast', 'presence') and
    (select numora_private.can_use_channel((select realtime.topic()))));
drop policy if exists numora_realtime_send on realtime.messages;
create policy numora_realtime_send on realtime.messages for insert to authenticated
  with check (extension in ('broadcast', 'presence') and
    (select numora_private.can_use_channel((select realtime.topic()))));

create or replace function numora_private.require_user()
returns uuid language plpgsql stable security invoker set search_path = '' as $$
declare v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception using errcode = '42501', message = 'Sign in before joining a room.';
  end if;
  return v_user;
end;
$$;

create or replace function numora_private.checked_nickname(p_name text)
returns text language plpgsql immutable security invoker set search_path = '' as $$
declare v_name text := btrim(p_name);
begin
  if v_name is null or char_length(v_name) not between 2 and 24 or v_name ~ '[[:cntrl:]]' then
    raise exception using errcode = '22023', message = 'Choose a nickname with 2 to 24 characters.';
  end if;
  return v_name;
end;
$$;

create or replace function numora_private.normalized_code(p_code text)
returns text language plpgsql immutable security invoker set search_path = '' as $$
declare v_code text := upper(btrim(p_code));
begin
  if v_code is null or v_code !~ '^[A-Z0-9]{6}$' then
    raise exception using errcode = '22023', message = 'Enter the six-character room code.';
  end if;
  return v_code;
end;
$$;

create or replace function numora_private.rate_limit(p_user uuid, p_action text, p_max integer, p_seconds integer)
returns void language plpgsql security invoker set search_path = '' as $$
declare v_count integer; v_now timestamptz := clock_timestamp();
begin
  insert into numora_private.rate_limits(user_id, action, window_started, request_count)
  values (p_user, p_action, v_now, 1)
  on conflict (user_id, action) do update set
    window_started = case when numora_private.rate_limits.window_started < v_now - make_interval(secs => p_seconds)
      then v_now else numora_private.rate_limits.window_started end,
    request_count = case when numora_private.rate_limits.window_started < v_now - make_interval(secs => p_seconds)
      then 1 else numora_private.rate_limits.request_count + 1 end
  returning request_count into v_count;
  if v_count > p_max then
    raise exception using errcode = 'P0001', message = 'Too many requests. Please wait a moment and try again.';
  end if;
end;
$$;

create or replace function numora_private.int_array(p_data jsonb, p_count integer, p_max integer, p_zero boolean)
returns integer[] language plpgsql immutable security invoker set search_path = '' as $$
declare v_item jsonb; v_value numeric; v_result integer[] := array[]::integer[];
begin
  if p_data is null or jsonb_typeof(p_data) <> 'array' or jsonb_array_length(p_data) <> p_count then
    raise exception using errcode = '22023', message = 'The puzzle array has an invalid length.';
  end if;
  for v_item in select value from jsonb_array_elements(p_data) loop
    if jsonb_typeof(v_item) <> 'number' then
      raise exception using errcode = '22023', message = 'Puzzle values must be integers.';
    end if;
    v_value := v_item::text::numeric;
    if v_value <> trunc(v_value) or v_value < (case when p_zero then 0 else 1 end) or v_value > p_max then
      raise exception using errcode = '22023', message = 'A puzzle value is outside the board range.';
    end if;
    v_result := array_append(v_result, v_value::integer);
  end loop;
  return v_result;
end;
$$;

create or replace function numora_private.board_valid(p_puzzle jsonb, p_values integer[], p_complete boolean)
returns boolean language plpgsql immutable security invoker set search_path = '' as $$
declare
  n integer := (p_puzzle->>'size')::integer;
  v_givens integer[];
  v_direction integer; v_line integer; v_offset integer; v_start integer; v_at integer;
  v_run_length integer; v_number integer; v_seen integer[];
begin
  if n not between 5 and 8 or p_values is null or array_ndims(p_values) <> 1 or
    array_lower(p_values, 1) <> 1 or cardinality(p_values) <> n*n then return false; end if;
  v_givens := numora_private.int_array(p_puzzle->'givens', n*n, n, true);
  for v_at in 1..n*n loop
    if p_values[v_at] is null or p_values[v_at] < 0 or p_values[v_at] > n or
      (v_givens[v_at] <> 0 and v_givens[v_at] <> p_values[v_at]) then return false; end if;
  end loop;
  if not p_complete then return true; end if;
  for v_direction in 0..1 loop
    for v_line in 0..n-1 loop
      v_start := 0;
      for v_offset in 0..n-1 loop
        v_at := case when v_direction = 0 then v_line*n+v_offset else v_offset*n+v_line end;
        if v_offset = n-1 or (case when v_direction = 0 then p_puzzle->'rightWalls' else p_puzzle->'bottomWalls' end ->> v_at)::boolean then
          v_run_length := v_offset-v_start+1;
          v_seen := array[]::integer[];
          for v_number in v_start..v_offset loop
            v_at := case when v_direction = 0 then v_line*n+v_number else v_number*n+v_line end;
            if p_values[v_at+1] < 1 or p_values[v_at+1] > v_run_length or p_values[v_at+1] = any(v_seen) then return false; end if;
            v_seen := array_append(v_seen, p_values[v_at+1]);
          end loop;
          v_start := v_offset+1;
        end if;
      end loop;
    end loop;
  end loop;
  return true;
exception when others then return false;
end;
$$;

create or replace function numora_private.puzzle_valid(p_puzzle jsonb)
returns boolean language plpgsql immutable security invoker set search_path = '' as $$
declare n integer; v_wall jsonb; v_solution integer[];
begin
  if p_puzzle is null or jsonb_typeof(p_puzzle) <> 'object' or jsonb_typeof(p_puzzle->'size') is distinct from 'number' then return false; end if;
  n := (p_puzzle->>'size')::integer;
  if n not between 5 and 8 or (p_puzzle->>'size')::numeric <> n or
    jsonb_typeof(p_puzzle->'difficulty') is distinct from 'string' or p_puzzle->>'difficulty' not in ('Easy','Medium','Hard') or
    jsonb_typeof(p_puzzle->'title') is distinct from 'string' or char_length(p_puzzle->>'title') not between 1 and 80 or
    jsonb_typeof(p_puzzle->'description') is distinct from 'string' or char_length(p_puzzle->>'description') > 300 then return false; end if;
  if jsonb_typeof(p_puzzle->'rightWalls') is distinct from 'array' or jsonb_array_length(p_puzzle->'rightWalls') <> n*n or
    jsonb_typeof(p_puzzle->'bottomWalls') is distinct from 'array' or jsonb_array_length(p_puzzle->'bottomWalls') <> n*n then return false; end if;
  for v_wall in select value from jsonb_array_elements(p_puzzle->'rightWalls') union all select value from jsonb_array_elements(p_puzzle->'bottomWalls') loop
    if jsonb_typeof(v_wall) <> 'boolean' then return false; end if;
  end loop;
  v_solution := numora_private.int_array(p_puzzle->'solution', n*n, n, false);
  return numora_private.board_valid(p_puzzle, v_solution, true);
exception when others then return false;
end;
$$;

create or replace function numora_private.notes_valid(p_notes jsonb, p_values integer[], p_size integer)
returns boolean language plpgsql immutable security invoker set search_path = '' as $$
declare v_at integer := 0; v_notes jsonb; v_note jsonb; v_number numeric; v_seen integer[];
begin
  if p_notes is null or jsonb_typeof(p_notes) <> 'array' or jsonb_array_length(p_notes) <> p_size*p_size then return false; end if;
  for v_notes in select value from jsonb_array_elements(p_notes) loop
    v_at := v_at+1;
    if jsonb_typeof(v_notes) <> 'array' or jsonb_array_length(v_notes) > p_size or
      (p_values[v_at] <> 0 and jsonb_array_length(v_notes) <> 0) then return false; end if;
    v_seen := array[]::integer[];
    for v_note in select value from jsonb_array_elements(v_notes) loop
      if jsonb_typeof(v_note) <> 'number' then return false; end if;
      v_number := v_note::text::numeric;
      if v_number <> trunc(v_number) or v_number < 1 or v_number > p_size or v_number::integer = any(v_seen) then return false; end if;
      v_seen := array_append(v_seen, v_number::integer);
    end loop;
  end loop;
  return true;
exception when others then return false;
end;
$$;

create or replace function numora_private.empty_notes(p_count integer)
returns jsonb language sql immutable security invoker set search_path = '' as $$
  select jsonb_agg('[]'::jsonb) from generate_series(1, p_count);
$$;

create or replace function numora_private.get_room(p_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := numora_private.require_user();
  r public.numora_rooms%rowtype;
  v_puzzle jsonb; v_progress jsonb; v_players jsonb;
  v_now timestamptz := clock_timestamp();
begin
  select * into r from public.numora_rooms where code = numora_private.normalized_code(p_code);
  if not found or not exists(select 1 from public.numora_players where room_id=r.id and user_id=v_user) then
    raise exception using errcode='42501', message='Join this room with its code first.';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'user_id', p.user_id, 'nickname', p.nickname, 'ready', p.ready, 'active', p.active,
    'progress_count', p.progress_count, 'finished_at', p.finished_at, 'elapsed_ms', p.elapsed_ms,
    'joined_at', p.joined_at
  ) order by p.joined_at, p.user_id), '[]'::jsonb)
  into v_players from public.numora_players p where p.room_id=r.id;
  -- Neither clues nor private entries are released before the shared start.
  if r.starts_at is not null and v_now >= r.starts_at then
    select jsonb_build_object(
      'id', 'match-' || r.id::text, 'title', data->>'title', 'size', r.size,
      'difficulty', r.difficulty, 'description', data->>'description',
      'givens', data->'givens', 'rightWalls', data->'rightWalls', 'bottomWalls', data->'bottomWalls'
    ) into v_puzzle from numora_private.puzzles where room_id=r.id;
    select jsonb_build_object('values', pr.values, 'notes', pr.notes)
      into v_progress from numora_private.progress pr where pr.room_id=r.id and pr.user_id=v_user;
  end if;
  return jsonb_build_object(
    'room', jsonb_build_object('id',r.id,'code',r.code,'host_id',r.host_id,'status',r.status,
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
      insert into public.numora_rooms(id,code,host_id,size,difficulty)
      values(v_id,v_code,p_host_id,(p_puzzle->>'size')::integer,p_puzzle->>'difficulty');
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

create or replace function numora_private.join_room(p_code text, p_nickname text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_user uuid := numora_private.require_user(); v_name text; r public.numora_rooms%rowtype; v_puzzle jsonb;
begin
  v_name := numora_private.checked_nickname(p_nickname);
  perform numora_private.rate_limit(v_user,'join',30,60);
  select * into r from public.numora_rooms where code=numora_private.normalized_code(p_code) for update;
  if not found then return jsonb_build_object('error','Room not found. Check the code and try again.','code','ROOM_NOT_FOUND'); end if;
  if exists(select 1 from public.numora_players where room_id=r.id and user_id=v_user) then
    update public.numora_players set active=true,last_seen_at=clock_timestamp() where room_id=r.id and user_id=v_user;
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

create or replace function numora_private.set_ready(p_code text, p_ready boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_user uuid := numora_private.require_user(); r public.numora_rooms%rowtype;
begin
  select * into r from public.numora_rooms where code=numora_private.normalized_code(p_code) for update;
  if not found or not exists(select 1 from public.numora_players where room_id=r.id and user_id=v_user) then
    raise exception using errcode='42501', message='Join this room first.';
  end if;
  if r.status <> 'lobby' then raise exception using errcode='P0001', message='Readiness is locked after the race starts.'; end if;
  if p_ready is null then raise exception using errcode='22023', message='Choose a ready state.'; end if;
  update public.numora_players set ready=p_ready,active=true,last_seen_at=clock_timestamp() where room_id=r.id and user_id=v_user;
  return numora_private.get_room(r.code);
end;
$$;

create or replace function numora_private.start_room(p_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_user uuid := numora_private.require_user(); r public.numora_rooms%rowtype; v_count integer;
begin
  select * into r from public.numora_rooms where code=numora_private.normalized_code(p_code) for update;
  if not found or r.host_id <> v_user or not exists(select 1 from public.numora_players where room_id=r.id and user_id=v_user) then
    raise exception using errcode='42501', message='Only the room host can start the race.';
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

create or replace function numora_private.save_progress(p_code text, p_values integer[], p_notes jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_user uuid := numora_private.require_user(); r public.numora_rooms%rowtype; v_puzzle jsonb; v_count integer;
begin
  select * into r from public.numora_rooms where code=numora_private.normalized_code(p_code) for update;
  if not found or not exists(select 1 from public.numora_players where room_id=r.id and user_id=v_user) then
    raise exception using errcode='42501', message='Join this room first.';
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

create or replace function numora_private.submit_solution(p_code text, p_values integer[], p_notes jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_user uuid := numora_private.require_user(); r public.numora_rooms%rowtype; v_puzzle jsonb; v_count integer; v_now timestamptz;
begin
  -- Every write takes the room lock first, then the player/progress rows.
  select * into r from public.numora_rooms where code=numora_private.normalized_code(p_code) for update;
  if not found or not exists(select 1 from public.numora_players where room_id=r.id and user_id=v_user) then
    raise exception using errcode='42501', message='Join this room first.';
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

create or replace function numora_private.leave_room(p_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_user uuid := numora_private.require_user(); r public.numora_rooms%rowtype; v_host uuid;
begin
  select * into r from public.numora_rooms where code=numora_private.normalized_code(p_code) for update;
  if not found or not exists(select 1 from public.numora_players where room_id=r.id and user_id=v_user) then return '{}'::jsonb; end if;
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

create or replace function public.numora_create_room(p_host_id uuid,p_nickname text,p_puzzle jsonb)
returns text language sql security invoker set search_path='' as $$ select numora_private.create_room(p_host_id,p_nickname,p_puzzle); $$;
create or replace function public.numora_join_room(p_code text,p_nickname text)
returns jsonb language sql security invoker set search_path='' as $$ select numora_private.join_room(p_code,p_nickname); $$;
create or replace function public.numora_get_room(p_code text)
returns jsonb language sql security invoker set search_path='' as $$ select numora_private.get_room(p_code); $$;
create or replace function public.numora_set_ready(p_code text,p_ready boolean)
returns jsonb language sql security invoker set search_path='' as $$ select numora_private.set_ready(p_code,p_ready); $$;
create or replace function public.numora_start_room(p_code text)
returns jsonb language sql security invoker set search_path='' as $$ select numora_private.start_room(p_code); $$;
create or replace function public.numora_save_progress(p_code text,p_values integer[],p_notes jsonb)
returns jsonb language sql security invoker set search_path='' as $$ select numora_private.save_progress(p_code,p_values,p_notes); $$;
create or replace function public.numora_submit_solution(p_code text,p_values integer[],p_notes jsonb)
returns jsonb language sql security invoker set search_path='' as $$ select numora_private.submit_solution(p_code,p_values,p_notes); $$;
create or replace function public.numora_leave_room(p_code text)
returns jsonb language sql security invoker set search_path='' as $$ select numora_private.leave_room(p_code); $$;

revoke execute on all functions in schema numora_private from public,anon,authenticated,service_role;
grant execute on function numora_private.is_member(uuid),numora_private.can_use_channel(text),
  numora_private.get_room(text),numora_private.join_room(text,text),numora_private.set_ready(text,boolean),
  numora_private.start_room(text),numora_private.save_progress(text,integer[],jsonb),
  numora_private.submit_solution(text,integer[],jsonb),numora_private.leave_room(text) to authenticated;
grant execute on function numora_private.create_room(uuid,text,jsonb) to service_role;

revoke execute on function public.numora_create_room(uuid,text,jsonb),public.numora_join_room(text,text),
  public.numora_get_room(text),public.numora_set_ready(text,boolean),public.numora_start_room(text),
  public.numora_save_progress(text,integer[],jsonb),public.numora_submit_solution(text,integer[],jsonb),
  public.numora_leave_room(text) from public,anon,authenticated,service_role;
grant execute on function public.numora_create_room(uuid,text,jsonb) to service_role;
grant execute on function public.numora_join_room(text,text),public.numora_get_room(text),
  public.numora_set_ready(text,boolean),public.numora_start_room(text),public.numora_save_progress(text,integer[],jsonb),
  public.numora_submit_solution(text,integer[],jsonb),public.numora_leave_room(text) to authenticated;

-- Only non-secret state participates in logical replication.
do $$ begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime') then
    if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='numora_rooms') then
      alter publication supabase_realtime add table public.numora_rooms;
    end if;
    if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='numora_players') then
      alter publication supabase_realtime add table public.numora_players;
    end if;
  end if;
end $$;

notify pgrst, 'reload schema';
