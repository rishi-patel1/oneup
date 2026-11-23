-- Derive streaks from authoritative ranked results, including existing history.
-- A separate RPC preserves the deployed daily-state response contract.
create or replace function numora_private.daily_streaks()
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_user uuid := numora_private.require_user();
  v_today date := (clock_timestamp() at time zone 'UTC')::date;
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

create or replace function public.numora_daily_streaks()
returns jsonb language sql security invoker set search_path='' as $$
  select numora_private.daily_streaks();
$$;
revoke execute on function numora_private.daily_streaks(),public.numora_daily_streaks()
  from public,anon,authenticated,service_role;
grant execute on function numora_private.daily_streaks(),public.numora_daily_streaks() to authenticated;
notify pgrst,'reload schema';
