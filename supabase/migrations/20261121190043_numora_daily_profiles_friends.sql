-- Daily puzzles, Google-backed public profiles, and accepted friend requests.
-- Every table remains private. Client roles receive only checked RPC DTOs.
create table if not exists numora_private.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 2 and 24 and display_name !~ '[[:cntrl:]]'),
  friend_code text not null unique check (friend_code ~ '^[A-F0-9]{10}$'),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);
create table if not exists numora_private.daily_puzzles (
  id uuid primary key default gen_random_uuid(),
  date date not null unique,
  data jsonb not null,
  created_at timestamptz not null default clock_timestamp()
);
create table if not exists numora_private.daily_attempts (
  id uuid primary key default gen_random_uuid(),
  daily_id uuid not null references numora_private.daily_puzzles(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  started_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz,
  elapsed_ms bigint check (elapsed_ms >= 0),
  ranked boolean not null,
  values integer[] not null,
  notes jsonb not null,
  updated_at timestamptz not null default clock_timestamp(),
  unique (daily_id,user_id),
  check ((finished_at is null) = (elapsed_ms is null)),
  check (finished_at is null or finished_at >= started_at)
);
create index if not exists numora_daily_attempts_user_idx on numora_private.daily_attempts(user_id,daily_id);
create index if not exists numora_daily_ranked_idx on numora_private.daily_attempts(daily_id,elapsed_ms,user_id)
  where ranked and finished_at is not null;
create table if not exists numora_private.friendships (
  id uuid not null unique default gen_random_uuid(),
  user_low uuid not null references numora_private.profiles(user_id) on delete cascade,
  user_high uuid not null references numora_private.profiles(user_id) on delete cascade,
  requested_by uuid not null references numora_private.profiles(user_id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','accepted')),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (user_low,user_high),
  check (user_low < user_high),
  check (requested_by in (user_low,user_high))
);
create index if not exists numora_friendships_high_idx on numora_private.friendships(user_high,user_low);
create index if not exists numora_friendships_requester_idx on numora_private.friendships(requested_by);
alter table numora_private.profiles enable row level security;
alter table numora_private.daily_puzzles enable row level security;
alter table numora_private.daily_attempts enable row level security;
alter table numora_private.friendships enable row level security;
revoke all on numora_private.profiles,numora_private.daily_puzzles,numora_private.daily_attempts,
  numora_private.friendships from public,anon,authenticated,service_role;

-- auth.identities is maintained by GoTrue. User-editable JWT/profile metadata
-- cannot manufacture Google membership or change an already-started practice run.
create or replace function numora_private.is_google_user(p_user uuid)
returns boolean language plpgsql stable security invoker set search_path='' as $$
begin
  return exists(select 1 from auth.users u where u.id=p_user and u.is_anonymous=false
    and exists(select 1 from auth.identities i where i.user_id=u.id and i.provider='google'));
end;
$$;
create or replace function numora_private.require_google()
returns uuid language plpgsql stable security invoker set search_path='' as $$
declare v_user uuid := numora_private.require_user();
begin
  if not numora_private.is_google_user(v_user) then
    raise exception using errcode='42501',message='Sign in with Google to use profiles and friends.';
  end if;
  return v_user;
end;
$$;
create or replace function numora_private.daily_profile()
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user uuid := numora_private.require_user(); v_code text; v_at integer;
begin
  if not numora_private.is_google_user(v_user) then return null; end if;
  if not exists(select 1 from numora_private.profiles where user_id=v_user) then
    for v_at in 1..10 loop
      v_code := upper(substr(replace(gen_random_uuid()::text,'-',''),1,10));
      begin
        insert into numora_private.profiles(user_id,display_name,friend_code)
          values(v_user,'Player ' || right(v_code,6),v_code)
          on conflict (user_id) do nothing;
        exit;
      exception when unique_violation then
        if v_at=10 then raise exception 'Could not allocate a friend code. Please try again.'; end if;
      end;
    end loop;
  end if;
  return (select jsonb_build_object('id',user_id,'display_name',display_name,'friend_code',friend_code)
    from numora_private.profiles where user_id=v_user);
end;
$$;

-- Trusted Edge entry point; concurrent generators cannot replace the day's board.
create or replace function numora_private.ensure_daily(p_date date,p_puzzle jsonb)
returns void language plpgsql security definer set search_path='' as $$
begin
  if p_date is distinct from (clock_timestamp() at time zone 'UTC')::date then
    raise exception using errcode='22023',message='Only the current UTC daily puzzle can be created.';
  end if;
  if not numora_private.puzzle_valid(p_puzzle) or (p_puzzle->>'size')::integer <> 6
    or p_puzzle->>'difficulty' <> 'Medium' then
    raise exception using errcode='22023',message='The daily puzzle must be a valid 6 by 6 Medium puzzle.';
  end if;
  insert into numora_private.daily_puzzles(date,data) values(p_date,p_puzzle) on conflict (date) do nothing;
end;
$$;
create or replace function numora_private.get_daily()
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_user uuid := numora_private.require_user();
  v_profile jsonb := numora_private.daily_profile();
  v_now timestamptz := clock_timestamp();
  v_today date := (v_now at time zone 'UTC')::date;
  d numora_private.daily_puzzles%rowtype;
  a numora_private.daily_attempts%rowtype;
  v_daily jsonb; v_attempt jsonb; v_puzzle jsonb;
begin
  select * into d from numora_private.daily_puzzles where date=v_today;
  if found then
    v_daily := jsonb_build_object('id',d.id,'date',d.date,'size',6,'difficulty','Medium');
    select * into a from numora_private.daily_attempts where daily_id=d.id and user_id=v_user;
    if found then
      v_attempt := jsonb_build_object('id',a.id,'started_at',a.started_at,'finished_at',a.finished_at,
        'elapsed_ms',a.elapsed_ms,'ranked',a.ranked,'values',a.values,'notes',a.notes);
      v_puzzle := jsonb_build_object('id','daily-' || d.id::text,'title','Daily ' || d.date::text,
        'description','The shared daily challenge. A new puzzle arrives at midnight UTC.',
        'size',6,'difficulty','Medium','givens',d.data->'givens','rightWalls',d.data->'rightWalls',
        'bottomWalls',d.data->'bottomWalls');
    end if;
  end if;
  return jsonb_build_object('date',v_today,'resets_at',((v_today+1)::timestamp at time zone 'UTC'),
    'server_now',v_now,'daily',v_daily,'puzzle',v_puzzle,'attempt',v_attempt,'profile',v_profile);
end;
$$;
create or replace function numora_private.start_daily()
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_user uuid := numora_private.require_user();
  v_today date := (clock_timestamp() at time zone 'UTC')::date;
  d numora_private.daily_puzzles%rowtype;
begin
  perform numora_private.daily_profile();
  select * into d from numora_private.daily_puzzles where date=v_today;
  if not found then
    raise exception using errcode='P0001',message='Today''s puzzle is being prepared. Please try again.';
  end if;
  insert into numora_private.daily_attempts(daily_id,user_id,ranked,values,notes)
    values(d.id,v_user,numora_private.is_google_user(v_user),
      numora_private.int_array(d.data->'givens',36,6,true),numora_private.empty_notes(36))
    on conflict (daily_id,user_id) do nothing;
  if v_today <> (clock_timestamp() at time zone 'UTC')::date then
    raise exception using errcode='P0001',message='This daily puzzle has expired. Start today''s puzzle.';
  end if;
  return numora_private.get_daily();
end;
$$;

-- Each user's attempt row serializes saves and first finish, with no client timer.
create or replace function numora_private.write_daily(p_date date,p_values integer[],p_notes jsonb,p_submit boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_user uuid := numora_private.require_user();
  d numora_private.daily_puzzles%rowtype;
  a numora_private.daily_attempts%rowtype;
  v_now timestamptz;
begin
  if p_date is distinct from (clock_timestamp() at time zone 'UTC')::date then
    raise exception using errcode='P0001',message='This daily puzzle has expired. Start today''s puzzle.';
  end if;
  select * into d from numora_private.daily_puzzles where date=p_date;
  if not found then raise exception using errcode='42501',message='Start today''s puzzle before saving.'; end if;
  select * into a from numora_private.daily_attempts where daily_id=d.id and user_id=v_user for update;
  if not found then raise exception using errcode='42501',message='Start today''s puzzle before saving.'; end if;
  v_now := clock_timestamp();
  if p_date <> (v_now at time zone 'UTC')::date then
    raise exception using errcode='P0001',message='This daily puzzle has expired. Start today''s puzzle.';
  end if;
  if a.finished_at is not null then return numora_private.get_daily(); end if;
  if not numora_private.board_valid(d.data,p_values,false) or not numora_private.notes_valid(p_notes,p_values,6) then
    raise exception using errcode='22023',message='Entries must stay within the board range and preserve the clues and notes.';
  end if;
  if p_submit and not numora_private.board_valid(d.data,p_values,true) then
    raise exception using errcode='22023',message='The puzzle is not solved yet. Check each row and column segment.';
  end if;
  update numora_private.daily_attempts set values=p_values,notes=p_notes,updated_at=v_now,
    finished_at=case when p_submit then v_now else null end,
    elapsed_ms=case when p_submit then greatest(0,floor(extract(epoch from (v_now-a.started_at))*1000)::bigint) else null end
    where id=a.id;
  return numora_private.get_daily();
end;
$$;

create or replace function numora_private.update_profile(p_display_name text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user uuid := numora_private.require_google(); v_name text := numora_private.checked_nickname(p_display_name);
begin
  perform numora_private.daily_profile();
  perform numora_private.rate_limit(v_user,'profile_update',10,60);
  update numora_private.profiles set display_name=v_name,updated_at=clock_timestamp() where user_id=v_user;
  return numora_private.daily_profile();
end;
$$;
create or replace function numora_private.get_friends()
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user uuid := numora_private.require_google(); v_profile jsonb := numora_private.daily_profile();
  v_friends jsonb; v_incoming jsonb; v_outgoing jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object('user_id',p.user_id,'display_name',p.display_name,'friend_code',p.friend_code)
    order by lower(p.display_name),p.user_id),'[]'::jsonb) into v_friends
    from numora_private.friendships f join numora_private.profiles p
      on p.user_id=case when f.user_low=v_user then f.user_high else f.user_low end
    where (f.user_low=v_user or f.user_high=v_user) and f.status='accepted';
  select coalesce(jsonb_agg(jsonb_build_object('id',f.id,'user_id',p.user_id,'display_name',p.display_name,'friend_code',p.friend_code)
    order by f.created_at,f.id),'[]'::jsonb) into v_incoming
    from numora_private.friendships f join numora_private.profiles p on p.user_id=f.requested_by
    where (f.user_low=v_user or f.user_high=v_user) and f.status='pending' and f.requested_by<>v_user;
  select coalesce(jsonb_agg(jsonb_build_object('id',f.id,'user_id',p.user_id,'display_name',p.display_name,'friend_code',p.friend_code)
    order by f.created_at,f.id),'[]'::jsonb) into v_outgoing
    from numora_private.friendships f join numora_private.profiles p
      on p.user_id=case when f.user_low=v_user then f.user_high else f.user_low end
    where f.requested_by=v_user and f.status='pending';
  return jsonb_build_object('profile',v_profile,'friends',v_friends,'incoming',v_incoming,'outgoing',v_outgoing);
end;
$$;
create or replace function numora_private.request_friend(p_friend_code text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user uuid := numora_private.require_google(); v_code text := upper(btrim(p_friend_code)); v_other uuid;
  v_id uuid; f numora_private.friendships%rowtype;
begin
  perform numora_private.daily_profile();
  perform numora_private.rate_limit(v_user,'friend_request',30,60);
  -- Expected lookup failures commit their counter, including malformed guesses.
  if v_code is null or v_code !~ '^[A-F0-9]{10}$' then
    return jsonb_build_object('error','Enter the ten-character friend code.','code','INVALID_FRIEND_CODE');
  end if;
  select user_id into v_other from numora_private.profiles where friend_code=v_code;
  if v_other is null or not numora_private.is_google_user(v_other) then
    return jsonb_build_object('error','No player has that friend code.','code','FRIEND_NOT_FOUND');
  end if;
  if v_other=v_user then return jsonb_build_object('error','That is your own friend code.','code','SELF_REQUEST'); end if;
  if (select count(*) from numora_private.friendships where requested_by=v_user and status='pending') >= 50 then
    return jsonb_build_object('error','You have too many pending requests. Cancel one before sending another.','code','REQUEST_LIMIT');
  end if;
  insert into numora_private.friendships(user_low,user_high,requested_by)
    values(least(v_user,v_other),greatest(v_user,v_other),v_user)
    on conflict (user_low,user_high) do nothing returning id into v_id;
  if v_id is null then
    select * into f from numora_private.friendships where user_low=least(v_user,v_other) and user_high=greatest(v_user,v_other);
    if f.status='accepted' then return jsonb_build_object('error','You are already friends.','code','ALREADY_FRIENDS'); end if;
    if f.requested_by=v_user then return jsonb_build_object('error','Your friend request is already pending.','code','REQUEST_PENDING'); end if;
    return jsonb_build_object('error','This player has already sent you a request. Accept it from your incoming requests.','code','INCOMING_REQUEST');
  end if;
  return numora_private.get_friends();
end;
$$;
create or replace function numora_private.respond_friend(p_request_id uuid,p_accept boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user uuid := numora_private.require_google(); f numora_private.friendships%rowtype;
begin
  select * into f from numora_private.friendships where id=p_request_id for update;
  if not found or f.status<>'pending' or f.requested_by=v_user or v_user not in (f.user_low,f.user_high) then
    raise exception using errcode='42501',message='Only the recipient can respond to this pending friend request.';
  end if;
  if p_accept is null then raise exception using errcode='22023',message='Choose whether to accept this friend request.'; end if;
  if p_accept then
    update numora_private.friendships set status='accepted',updated_at=clock_timestamp() where id=f.id;
  else delete from numora_private.friendships where id=f.id;
  end if;
  return numora_private.get_friends();
end;
$$;
create or replace function numora_private.cancel_friend_request(p_request_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user uuid := numora_private.require_google(); f numora_private.friendships%rowtype;
begin
  select * into f from numora_private.friendships where id=p_request_id for update;
  if not found or f.status<>'pending' or f.requested_by<>v_user then
    raise exception using errcode='42501',message='Only the sender can cancel this pending friend request.';
  end if;
  delete from numora_private.friendships where id=f.id;
  return numora_private.get_friends();
end;
$$;
create or replace function numora_private.remove_friend(p_user_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user uuid := numora_private.require_google();
begin
  if p_user_id is null or p_user_id=v_user then
    raise exception using errcode='22023',message='Choose a friend to remove.';
  end if;
  delete from numora_private.friendships where user_low=least(v_user,p_user_id)
    and user_high=greatest(v_user,p_user_id) and status='accepted';
  return numora_private.get_friends();
end;
$$;

create or replace function numora_private.daily_leaderboard(p_date date default null,p_scope text default 'global')
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user uuid := numora_private.require_user(); v_date date := coalesce(p_date,(clock_timestamp() at time zone 'UTC')::date);
  v_entries jsonb; v_self jsonb; v_total integer;
begin
  if p_scope is null or p_scope not in ('global','friends') or v_date>(clock_timestamp() at time zone 'UTC')::date then
    raise exception using errcode='22023',message='Choose a valid daily date and leaderboard.';
  end if;
  if p_scope='friends' then perform numora_private.require_google(); end if;
  with ranked as (
    select rank() over(order by a.elapsed_ms) as place,
      row_number() over(order by a.elapsed_ms,a.user_id) as position,
      a.user_id,p.display_name,p.friend_code,a.elapsed_ms
    from numora_private.daily_attempts a
    join numora_private.daily_puzzles d on d.id=a.daily_id
    join numora_private.profiles p on p.user_id=a.user_id
    where d.date=v_date and a.ranked and a.finished_at is not null
      and (p_scope='global' or a.user_id=v_user or exists(
        select 1 from numora_private.friendships f where f.status='accepted'
          and f.user_low=least(v_user,a.user_id) and f.user_high=greatest(v_user,a.user_id)))
  ), rows as (
    select position,user_id,jsonb_build_object('rank',place,'user_id',user_id,'display_name',display_name,
      'friend_code',friend_code,'elapsed_ms',elapsed_ms) as dto from ranked
  ) select coalesce(jsonb_agg(dto order by position) filter(where position<=50),'[]'::jsonb),
    (jsonb_agg(dto) filter(where user_id=v_user))->0,count(*)::integer
    into v_entries,v_self,v_total from rows;
  return jsonb_build_object('date',v_date,'scope',p_scope,'entries',v_entries,'self',v_self,'total',v_total);
end;
$$;

create or replace function public.numora_ensure_daily(p_date date,p_puzzle jsonb)
returns void language sql security invoker set search_path='' as $$ select numora_private.ensure_daily(p_date,p_puzzle); $$;
create or replace function public.numora_get_daily()
returns jsonb language sql security invoker set search_path='' as $$ select numora_private.get_daily(); $$;
create or replace function public.numora_start_daily()
returns jsonb language sql security invoker set search_path='' as $$ select numora_private.start_daily(); $$;
create or replace function public.numora_save_daily(p_date date,p_values integer[],p_notes jsonb)
returns jsonb language sql security invoker set search_path='' as $$ select numora_private.write_daily(p_date,p_values,p_notes,false); $$;
create or replace function public.numora_submit_daily(p_date date,p_values integer[],p_notes jsonb)
returns jsonb language sql security invoker set search_path='' as $$ select numora_private.write_daily(p_date,p_values,p_notes,true); $$;
create or replace function public.numora_daily_leaderboard(p_date date default null,p_scope text default 'global')
returns jsonb language sql security invoker set search_path='' as $$ select numora_private.daily_leaderboard(p_date,p_scope); $$;
create or replace function public.numora_update_profile(p_display_name text)
returns jsonb language sql security invoker set search_path='' as $$ select numora_private.update_profile(p_display_name); $$;
create or replace function public.numora_get_friends()
returns jsonb language sql security invoker set search_path='' as $$ select numora_private.get_friends(); $$;
create or replace function public.numora_request_friend(p_friend_code text)
returns jsonb language sql security invoker set search_path='' as $$ select numora_private.request_friend(p_friend_code); $$;
create or replace function public.numora_respond_friend(p_request_id uuid,p_accept boolean)
returns jsonb language sql security invoker set search_path='' as $$ select numora_private.respond_friend(p_request_id,p_accept); $$;
create or replace function public.numora_remove_friend(p_user_id uuid)
returns jsonb language sql security invoker set search_path='' as $$ select numora_private.remove_friend(p_user_id); $$;
create or replace function public.numora_cancel_friend_request(p_request_id uuid)
returns jsonb language sql security invoker set search_path='' as $$ select numora_private.cancel_friend_request(p_request_id); $$;

-- Do not change ACLs on pre-existing room/spectator functions.
revoke execute on function numora_private.is_google_user(uuid),numora_private.require_google(),
  numora_private.daily_profile(),numora_private.ensure_daily(date,jsonb),numora_private.get_daily(),
  numora_private.start_daily(),numora_private.write_daily(date,integer[],jsonb,boolean),
  numora_private.daily_leaderboard(date,text),numora_private.update_profile(text),numora_private.get_friends(),
  numora_private.request_friend(text),numora_private.respond_friend(uuid,boolean),
  numora_private.remove_friend(uuid),numora_private.cancel_friend_request(uuid)
  from public,anon,authenticated,service_role;
revoke execute on function public.numora_ensure_daily(date,jsonb),public.numora_get_daily(),
  public.numora_start_daily(),public.numora_save_daily(date,integer[],jsonb),public.numora_submit_daily(date,integer[],jsonb),
  public.numora_daily_leaderboard(date,text),public.numora_update_profile(text),public.numora_get_friends(),
  public.numora_request_friend(text),public.numora_respond_friend(uuid,boolean),public.numora_remove_friend(uuid),
  public.numora_cancel_friend_request(uuid) from public,anon,authenticated,service_role;
grant execute on function numora_private.ensure_daily(date,jsonb),public.numora_ensure_daily(date,jsonb) to service_role;
grant execute on function numora_private.get_daily(),numora_private.start_daily(),
  numora_private.write_daily(date,integer[],jsonb,boolean),numora_private.daily_leaderboard(date,text),
  numora_private.update_profile(text),numora_private.get_friends(),numora_private.request_friend(text),
  numora_private.respond_friend(uuid,boolean),numora_private.remove_friend(uuid),numora_private.cancel_friend_request(uuid)
  to authenticated;
grant execute on function public.numora_get_daily(),public.numora_start_daily(),
  public.numora_save_daily(date,integer[],jsonb),public.numora_submit_daily(date,integer[],jsonb),
  public.numora_daily_leaderboard(date,text),public.numora_update_profile(text),public.numora_get_friends(),
  public.numora_request_friend(text),public.numora_respond_friend(uuid,boolean),public.numora_remove_friend(uuid),
  public.numora_cancel_friend_request(uuid) to authenticated;
notify pgrst,'reload schema';
