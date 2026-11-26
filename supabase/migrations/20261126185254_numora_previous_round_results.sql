-- Previous standings remain available in the shared lobby after a rematch or
-- grid change. Keep the archive private and return only allowlisted score data
-- through the existing live-room, kick and membership checks.
create index if not exists numora_round_results_latest
  on numora_private.room_round_results(room_id,recorded_at desc,finished_at desc,round_id desc);

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
    ),'[]'::jsonb),'previous_round',(
      select jsonb_build_object('round_id',a.round_id,'size',a.size,'difficulty',a.difficulty,
        'starts_at',a.starts_at,'finished_at',a.finished_at,
        'results',coalesce((select jsonb_agg(jsonb_build_object(
          'user_id',entry->'user_id','nickname',entry->'nickname','finished_at',entry->'finished_at',
          'given_up_at',entry->'given_up_at','elapsed_ms',entry->'elapsed_ms') order by position)
          from jsonb_array_elements(a.results) with ordinality as archived(entry,position)),'[]'::jsonb))
      from numora_private.room_round_results a where a.room_id=r.id
      order by a.recorded_at desc,a.finished_at desc,a.round_id desc limit 1
    ),'self',v_progress,'puzzle',v_puzzle,'server_now',v_now
  );
end;
$$;

notify pgrst,'reload schema';
