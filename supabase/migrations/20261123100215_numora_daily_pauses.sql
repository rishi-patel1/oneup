-- Server-owned daily pause clocks. Legacy DTOs stay unchanged during rollout.
alter table numora_private.daily_attempts add column if not exists paused_at timestamptz;
alter table numora_private.daily_attempts add column if not exists paused_ms bigint not null default 0 check (paused_ms >= 0);
alter table numora_private.daily_attempts add column if not exists timing_version bigint not null default 0 check (timing_version >= 0);

create or replace function numora_private.get_daily_timed()
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
    -- A pause/write and its timed snapshot cannot cross one another.
    select * into a from numora_private.daily_attempts where daily_id=d.id and user_id=v_user for share;
    v_now := clock_timestamp();
    if v_today <> (v_now at time zone 'UTC')::date then return numora_private.get_daily_timed(); end if;
    if a.id is not null then
      v_attempt := jsonb_build_object('id',a.id,'started_at',a.started_at,'finished_at',a.finished_at,
        'elapsed_ms',a.elapsed_ms,'ranked',a.ranked,'values',a.values,'notes',a.notes,
        'paused_at',a.paused_at,'paused_ms',a.paused_ms,'timing_version',a.timing_version);
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

create or replace function numora_private.start_daily_timed()
returns jsonb language plpgsql security invoker set search_path='' as $$
begin
  perform numora_private.start_daily();
  return numora_private.get_daily_timed();
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

-- Old clients remain usable until this attempt has used the new pause controls.
-- They cannot overwrite a resumed attempt using a pre-pause board snapshot.
create or replace function numora_private.write_daily(p_date date,p_values integer[],p_notes jsonb,p_submit boolean)
returns jsonb language plpgsql security invoker set search_path='' as $$
begin
  perform numora_private.write_daily_timed(p_date,p_values,p_notes,p_submit,null::bigint);
  return numora_private.get_daily();
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
  if p_date is distinct from (clock_timestamp() at time zone 'UTC')::date then
    raise exception using errcode='P0001',message='This daily puzzle has expired. Start today''s puzzle.';
  end if;
  select * into d from numora_private.daily_puzzles where date=p_date;
  if not found then raise exception using errcode='42501',message='Start today''s puzzle before pausing.'; end if;
  select * into a from numora_private.daily_attempts where daily_id=d.id and user_id=v_user for update;
  if not found or a.id <> p_attempt_id then
    raise exception using errcode='42501',message='Pause only your current daily attempt.';
  end if;
  v_now := clock_timestamp();
  if p_date <> (v_now at time zone 'UTC')::date then
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

create or replace function public.numora_get_daily_timed()
returns jsonb language sql security invoker set search_path='' as $$ select numora_private.get_daily_timed(); $$;
create or replace function public.numora_start_daily_timed()
returns jsonb language sql security invoker set search_path='' as $$ select numora_private.start_daily_timed(); $$;
create or replace function public.numora_save_daily_timed(p_date date,p_values integer[],p_notes jsonb,p_timing_version bigint)
returns jsonb language sql security invoker set search_path='' as $$ select numora_private.write_daily_timed(p_date,p_values,p_notes,false,p_timing_version); $$;
create or replace function public.numora_submit_daily_timed(p_date date,p_values integer[],p_notes jsonb,p_timing_version bigint)
returns jsonb language sql security invoker set search_path='' as $$ select numora_private.write_daily_timed(p_date,p_values,p_notes,true,p_timing_version); $$;
create or replace function public.numora_set_daily_paused(p_date date,p_attempt_id uuid,p_paused boolean,p_timing_version bigint)
returns jsonb language sql security invoker set search_path='' as $$ select numora_private.set_daily_paused(p_date,p_attempt_id,p_paused,p_timing_version); $$;

revoke execute on function numora_private.get_daily_timed(),numora_private.start_daily_timed(),
  numora_private.write_daily_timed(date,integer[],jsonb,boolean,bigint),numora_private.set_daily_paused(date,uuid,boolean,bigint),
  public.numora_get_daily_timed(),public.numora_start_daily_timed(),public.numora_save_daily_timed(date,integer[],jsonb,bigint),
  public.numora_submit_daily_timed(date,integer[],jsonb,bigint),public.numora_set_daily_paused(date,uuid,boolean,bigint)
  from public,anon,authenticated,service_role;
grant execute on function numora_private.get_daily_timed(),numora_private.start_daily_timed(),
  numora_private.write_daily_timed(date,integer[],jsonb,boolean,bigint),numora_private.set_daily_paused(date,uuid,boolean,bigint),
  public.numora_get_daily_timed(),public.numora_start_daily_timed(),public.numora_save_daily_timed(date,integer[],jsonb,bigint),
  public.numora_submit_daily_timed(date,integer[],jsonb,bigint),public.numora_set_daily_paused(date,uuid,boolean,bigint)
  to authenticated;
notify pgrst,'reload schema';
