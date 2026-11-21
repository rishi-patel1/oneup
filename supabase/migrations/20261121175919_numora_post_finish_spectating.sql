-- Spectating is a read-only server privilege earned by finishing this race.
-- Keep private progress tables inaccessible to client roles; expose one checked DTO.
create or replace function numora_private.spectate_player(p_code text, p_player_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := numora_private.require_user();
  r public.numora_rooms%rowtype;
  v_finished_at timestamptz;
  v_progress numora_private.progress%rowtype;
begin
  select * into r from public.numora_rooms
    where code = numora_private.normalized_code(p_code);
  if not found then
    raise exception using errcode = '42501', message = 'Join this room before spectating.';
  end if;

  select finished_at into v_finished_at from public.numora_players
    where room_id = r.id and user_id = v_user;
  if not found then
    raise exception using errcode = '42501', message = 'Join this room before spectating.';
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

create or replace function public.numora_spectate_player(p_code text, p_player_id uuid)
returns jsonb language sql security invoker set search_path = '' as $$
  select numora_private.spectate_player(p_code, p_player_id);
$$;

revoke execute on function numora_private.spectate_player(text,uuid)
  from public,anon,authenticated,service_role;
revoke execute on function public.numora_spectate_player(text,uuid)
  from public,anon,authenticated,service_role;
grant execute on function numora_private.spectate_player(text,uuid) to authenticated;
grant execute on function public.numora_spectate_player(text,uuid) to authenticated;

notify pgrst, 'reload schema';
