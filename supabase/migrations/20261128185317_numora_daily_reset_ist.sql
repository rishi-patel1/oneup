-- One shared daily period: 09:30 Asia/Kolkata is 04:00 UTC, without DST.
-- Keep existing puzzle date keys, attempts, timer anchors and ranked history.
create or replace function numora_private.daily_day(p_now timestamptz)
returns date language sql immutable strict security invoker set search_path='' as $$
  select ((p_now at time zone 'UTC')-interval '4 hours')::date;
$$;
create or replace function numora_private.daily_reset_at(p_day date)
returns timestamptz language sql immutable strict security invoker set search_path='' as $$
  select ((p_day+1)::timestamp+interval '4 hours') at time zone 'UTC';
$$;
revoke execute on function numora_private.daily_day(timestamptz),numora_private.daily_reset_at(date)
  from public,anon,authenticated,service_role;


create or replace function numora_private.ensure_daily(p_date date,p_puzzle jsonb)
returns void language plpgsql security definer set search_path='' as $$
begin
  if p_date is distinct from numora_private.daily_day(clock_timestamp()) then
    raise exception using errcode='22023',message='Only the current daily puzzle can be created.';
  end if;
  if not numora_private.puzzle_valid(p_puzzle) or (p_puzzle->>'size')::integer <> 6
    or p_puzzle->>'difficulty' <> 'Medium' then
    raise exception using errcode='22023',message='The daily puzzle must be a valid 6 by 6 Medium puzzle.';
  end if;
  insert into numora_private.daily_puzzles(date,data) values(p_date,p_puzzle) on conflict (date) do nothing;
  -- An insert may wait for a concurrent generator across the reset boundary.
  if p_date is distinct from numora_private.daily_day(clock_timestamp()) then
    raise exception using errcode='22023',message='Only the current daily puzzle can be created.';
  end if;
end;
$$;

create or replace function numora_private.get_daily_timed()
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_user uuid := numora_private.require_user();
  v_profile jsonb := numora_private.daily_profile();
  v_now timestamptz := clock_timestamp();
  v_today date := numora_private.daily_day(v_now);
  d numora_private.daily_puzzles%rowtype;
  a numora_private.daily_attempts%rowtype;
  v_daily jsonb; v_attempt jsonb; v_puzzle jsonb;
begin
  select * into d from numora_private.daily_puzzles where date=v_today;
  if found then
    v_daily := jsonb_build_object('id',d.id,'date',d.date,'size',6,'difficulty','Medium');
    -- A pause/write and its timed snapshot cannot cross one another.
    select * into a from numora_private.daily_attempts where daily_id=d.id and user_id=v_user for share;
    v_now := clock_timestamp();
    if v_today <> numora_private.daily_day(v_now) then return numora_private.get_daily_timed(); end if;
    if a.id is not null then
      v_attempt := jsonb_build_object('id',a.id,'started_at',a.started_at,'finished_at',a.finished_at,
        'elapsed_ms',a.elapsed_ms,'ranked',a.ranked,'values',a.values,'notes',a.notes,
        'paused_at',a.paused_at,'paused_ms',a.paused_ms,'timing_version',a.timing_version);
      v_puzzle := jsonb_build_object('id','daily-' || d.id::text,'title','Daily ' || d.date::text,
        'description','The shared daily challenge. A new puzzle arrives at 9:30 AM IST.',
        'size',6,'difficulty','Medium','givens',d.data->'givens','rightWalls',d.data->'rightWalls',
        'bottomWalls',d.data->'bottomWalls');
    end if;
  end if;
  return jsonb_build_object('date',v_today,'resets_at',numora_private.daily_reset_at(v_today),
    'server_now',v_now,'daily',v_daily,'puzzle',v_puzzle,'attempt',v_attempt,'profile',v_profile);
end;
$$;

-- Keep the legacy DTO shape while sharing timed reads and their boundary checks.
create or replace function numora_private.get_daily()
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_state jsonb := numora_private.get_daily_timed();
begin
  if v_state->'attempt' <> 'null'::jsonb then
    v_state := jsonb_set(v_state,'{attempt}',(v_state->'attempt')-'paused_at'-'paused_ms'-'timing_version');
  end if;
  return v_state;
end;
$$;


create or replace function numora_private.start_daily()
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_user uuid := numora_private.require_user();
  v_today date := numora_private.daily_day(clock_timestamp());
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
  if v_today <> numora_private.daily_day(clock_timestamp()) then
    raise exception using errcode='P0001',message='This daily puzzle has expired. Start today''s puzzle.';
  end if;
  return numora_private.get_daily();
end;
$$;

create or replace function numora_private.write_daily_timed(p_date date,p_values integer[],p_notes jsonb,p_submit boolean,p_timing_version bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_user uuid := numora_private.require_user();
  d numora_private.daily_puzzles%rowtype;
  a numora_private.daily_attempts%rowtype;
  v_now timestamptz;
begin
  if p_date is distinct from numora_private.daily_day(clock_timestamp()) then
    raise exception using errcode='P0001',message='This daily puzzle has expired. Start today''s puzzle.';
  end if;
  select * into d from numora_private.daily_puzzles where date=p_date;
  if not found then raise exception using errcode='42501',message='Start today''s puzzle before saving.'; end if;
  select * into a from numora_private.daily_attempts where daily_id=d.id and user_id=v_user for update;
  if not found then raise exception using errcode='42501',message='Start today''s puzzle before saving.'; end if;
  v_now := clock_timestamp();
  if p_date <> numora_private.daily_day(v_now) then
    raise exception using errcode='P0001',message='This daily puzzle has expired. Start today''s puzzle.';
  end if;
  if a.finished_at is not null then return numora_private.get_daily_timed(); end if;
  if coalesce(p_timing_version,0) <> a.timing_version then
    raise exception using errcode='22023',message='The daily pause state has changed. Refresh the puzzle and try again.';
  end if;
  if a.paused_at is not null then
    raise exception using errcode='P0001',message='Resume the daily puzzle before entering or submitting answers.';
  end if;
  if not numora_private.board_valid(d.data,p_values,false) or not numora_private.notes_valid(p_notes,p_values,6) then
    raise exception using errcode='22023',message='Entries must stay within the board range and preserve the clues and notes.';
  end if;
  if p_submit and not numora_private.board_valid(d.data,p_values,true) then
    raise exception using errcode='22023',message='The puzzle is not solved yet. Check each row and column segment.';
  end if;
  update numora_private.daily_attempts set values=p_values,notes=p_notes,updated_at=v_now,
    finished_at=case when p_submit then v_now else null end,
    elapsed_ms=case when p_submit then greatest(0,floor(extract(epoch from (v_now-a.started_at))*1000)::bigint-a.paused_ms) else null end
    where id=a.id;
  return numora_private.get_daily_timed();
end;
$$;

create or replace function numora_private.set_daily_paused(p_date date,p_attempt_id uuid,p_paused boolean,p_timing_version bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_user uuid := numora_private.require_user();
  d numora_private.daily_puzzles%rowtype;
  a numora_private.daily_attempts%rowtype;
  v_now timestamptz;
begin
  if p_paused is null or p_timing_version is null or p_timing_version < 0 or p_attempt_id is null then
    raise exception using errcode='22023',message='Choose a pause state for the current daily attempt.';
  end if;
  if p_date is distinct from numora_private.daily_day(clock_timestamp()) then
    raise exception using errcode='P0001',message='This daily puzzle has expired. Start today''s puzzle.';
  end if;
  select * into d from numora_private.daily_puzzles where date=p_date;
  if not found then raise exception using errcode='42501',message='Start today''s puzzle before pausing.'; end if;
  select * into a from numora_private.daily_attempts where daily_id=d.id and user_id=v_user for update;
  if not found or a.id <> p_attempt_id then
    raise exception using errcode='42501',message='Pause only your current daily attempt.';
  end if;
  v_now := clock_timestamp();
  if p_date <> numora_private.daily_day(v_now) then
    raise exception using errcode='P0001',message='This daily puzzle has expired. Start today''s puzzle.';
  end if;
  if a.finished_at is not null then
    raise exception using errcode='P0001',message='This daily puzzle is already finished.';
  end if;
  if p_timing_version <> a.timing_version then
    raise exception using errcode='22023',message='The daily pause state has changed. Refresh the puzzle and try again.';
  end if;
  if p_paused = (a.paused_at is not null) then return numora_private.get_daily_timed(); end if;
  if p_paused then
    update numora_private.daily_attempts set paused_at=v_now,timing_version=timing_version+1,updated_at=v_now where id=a.id;
  else
    update numora_private.daily_attempts set paused_ms=paused_ms+greatest(0,floor(extract(epoch from(v_now-a.paused_at))*1000)::bigint),
      paused_at=null,timing_version=timing_version+1,updated_at=v_now where id=a.id;
  end if;
  return numora_private.get_daily_timed();
end;
$$;

create or replace function numora_private.daily_leaderboard(p_date date default null,p_scope text default 'global')
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user uuid := numora_private.require_user(); v_date date := coalesce(p_date,numora_private.daily_day(clock_timestamp()));
  v_entries jsonb; v_self jsonb; v_total integer;
begin
  if p_scope is null or p_scope not in ('global','friends') or v_date>numora_private.daily_day(clock_timestamp()) then
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

create or replace function numora_private.daily_streaks()
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_user uuid := numora_private.require_user();
  v_today date := numora_private.daily_day(clock_timestamp());
  v_current integer; v_max integer; v_completed boolean; v_last date;
begin
  with completed as (
    select distinct d.date
    from numora_private.daily_attempts a
    join numora_private.daily_puzzles d on d.id=a.daily_id
    where a.user_id=v_user and a.ranked and a.finished_at is not null and d.date<=v_today
  ), islands as (
    select date,date-row_number() over(order by date)::integer as run from completed
  ), runs as (
    select count(*)::integer as length,max(date) as ends from islands group by run
  )
  select coalesce(max(length) filter(where ends>=v_today-1),0),coalesce(max(length),0),
    coalesce(bool_or(ends=v_today),false),max(ends)
    into v_current,v_max,v_completed,v_last from runs;
  return jsonb_build_object('date',v_today,'current',v_current,'max',v_max,
    'completed_today',v_completed,'last_completed_date',v_last);
end;
$$;

notify pgrst,'reload schema';
