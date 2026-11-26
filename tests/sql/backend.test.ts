import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { generatePuzzle } from '../../src/game/generator';
import { getConflicts } from '../../src/game/engine';

type State = {
  room: { id: string; code: string; host_id: string; status: string; starts_at: string | null };
  players: { user_id: string; is_spectator: boolean; ready: boolean; progress_count: number; finished_at: string | null; elapsed_ms: number | null }[];
  self: { values: number[]; notes: number[][] } | null;
  puzzle: Record<string, unknown> | null;
  server_now: string;
};

const HOST = '00000000-0000-4000-8000-000000000001';
const GUEST = '00000000-0000-4000-8000-000000000002';
const OUTSIDER = '00000000-0000-4000-8000-000000000003';
const LATE = '00000000-0000-4000-8000-000000000004';
const puzzle = generatePuzzle({ size: 5, difficulty: 'Easy', seed: 'competition-sql-test' });
const notes = Array.from({ length: 25 }, () => [] as number[]);
const migrationDirectory = new URL('../../supabase/migrations/', import.meta.url);
const migration = readdirSync(migrationDirectory).filter(name => name.endsWith('.sql')).sort()
  .map(name => readFileSync(new URL(name, migrationDirectory), 'utf8')).join('\n');

const platformSql = `
      create role anon; create role authenticated; create role service_role;
      create schema auth;
      create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$
        select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;
      $$;
      grant usage on schema auth to anon,authenticated,service_role;
      create schema realtime;
      create table realtime.messages(extension text,topic text);
      alter table realtime.messages enable row level security;
      grant usage on schema realtime to authenticated;
      grant select,insert on realtime.messages to authenticated;
      create function realtime.topic() returns text language sql stable as $$
        select current_setting('realtime.topic',true);
      $$;
    `;

test('competition SQL: authorization, hidden boards, race rules, persistence, and timing', async t => {
  const db = new PGlite();
  try {
    // Minimal platform fixtures: the migration itself runs unchanged.
    await db.exec(platformSql);
    await db.exec(migration);
    for (const id of [HOST, GUEST, OUTSIDER, LATE]) await db.query('insert into auth.users(id) values($1)', [id]);

    const asRole = async <T>(role: 'authenticated' | 'anon' | 'service_role', user: string | null, operation: () => Promise<T>): Promise<T> => {
      await db.query("select set_config('request.jwt.claim.sub',$1,false)", [user ?? '']);
      await db.exec(`set role ${role}`);
      try { return await operation(); }
      finally { await db.exec('reset role'); await db.query("select set_config('request.jwt.claim.sub','',false)"); }
    };
    const user = <T>(id: string, operation: () => Promise<T>) => asRole('authenticated', id, operation);
    const state = async (code: string) => (await db.query<{ data: State }>('select public.numora_get_room($1) as data', [code])).rows[0].data;
    const create = async (host = HOST, name = 'Host') => asRole('service_role', null, async () =>
      (await db.query<{ code: string }>('select public.numora_create_room($1,$2,$3::jsonb) as code', [host, name, JSON.stringify(puzzle)])).rows[0].code);
    let code = '';

    await t.test('service creates a room and reapplying the migration preserves it', async () => {
      code = await create();
      assert.match(code, /^[A-Z0-9]{6}$/);
      await db.exec(migration);
      assert.equal((await db.query('select * from public.numora_rooms')).rows.length, 1);
      const s = await user(HOST, () => state(code));
      assert.equal(s.room.host_id, HOST);
      assert.equal(s.players.length, 1);
    });

    await t.test('client roles cannot create trusted puzzles or mutate raw state', async () => {
      await assert.rejects(user(HOST, () => db.query('select public.numora_create_room($1,$2,$3::jsonb)', [HOST, 'Bad', JSON.stringify(puzzle)])), /permission denied/);
      await assert.rejects(asRole('anon', null, () => state(code)), /permission denied/);
      await assert.rejects(user(HOST, () => db.query("update public.numora_rooms set status='finished' where code=$1", [code])), /permission denied/);
      await assert.rejects(user(HOST, () => db.query('select data from numora_private.puzzles')), /permission denied/);
      await assert.rejects(user(HOST, () => db.query('select * from numora_private.progress')), /permission denied/);
    });

    await t.test('room members cannot see clues, answers, or seeded IDs in the lobby', async () => {
      const s = await user(HOST, () => state(code));
      assert.equal(s.puzzle, null);
      assert.equal(s.self, null);
      assert.equal(s.room.status, 'lobby');
      assert.equal(JSON.stringify(s).includes(puzzle.generation.seed), false);
      assert.equal(JSON.stringify(s).includes('solution'), false);
    });

    await t.test('outsiders cannot read or control a room, including through raw RLS tables', async () => {
      await assert.rejects(user(OUTSIDER, () => state(code)), /Join this room/);
      await assert.rejects(user(OUTSIDER, () => db.query('select public.numora_set_ready($1,true)', [code])), /Join this room/);
      await assert.rejects(user(OUTSIDER, () => db.query('select public.numora_start_room($1)', [code])), /Only the room host/);
      const rows = await user(OUTSIDER, () => db.query('select * from public.numora_rooms'));
      assert.equal(rows.rows.length, 0);
      const members = await user(OUTSIDER, () => db.query('select * from public.numora_players'));
      assert.equal(members.rows.length, 0);
    });

    await t.test('joining is membership-scoped; ready checks and host checks guard the shared start', async () => {
      await assert.rejects(user(HOST, () => db.query('select public.numora_start_room($1)', [code])), /at least one other/);
      await user(GUEST, () => db.query('select public.numora_join_room($1,$2)', [code.toLowerCase(), 'Guest']));
      await assert.rejects(user(GUEST, () => db.query('select public.numora_start_room($1)', [code])), /Only the room host/);
      await assert.rejects(user(HOST, () => db.query('select public.numora_start_room($1)', [code])), /every player is ready/);
      await user(HOST, () => db.query('select public.numora_set_ready($1,true)', [code]));
      await user(GUEST, () => db.query('select public.numora_set_ready($1,true)', [code]));
      const started = (await user(HOST, () => db.query<{ data: State }>('select public.numora_start_room($1) as data', [code]))).rows[0].data;
      assert.equal(started.room.status, 'racing');
      assert.ok(Date.parse(started.room.starts_at!) - Date.parse(started.server_now) > 4000);
      assert.equal(started.puzzle, null);
      assert.equal(started.self, null);
      await assert.rejects(user(GUEST, () => db.query('select public.numora_save_progress($1,$2::int[],$3::jsonb)', [code, puzzle.givens, JSON.stringify(notes)])), /not started/);
      const late = await user(LATE, () => db.query<{ data: State }>('select public.numora_join_room($1,$2) as data', [code, 'Late']));
      assert.equal(late.rows[0].data.players.find(p => p.user_id === LATE)?.is_spectator, true);
      assert.equal(late.rows[0].data.self, null);
      assert.equal(late.rows[0].data.puzzle, null);
    });

    await t.test('after start each player receives a safe board and only their own entries', async () => {
      // Trusted test clock adjustment avoids a five-second sleep.
      await db.query("update public.numora_rooms set starts_at=clock_timestamp()-interval '12 seconds' where code=$1", [code]);
      const s = await user(HOST, () => state(code));
      assert.deepEqual(s.self?.values, puzzle.givens);
      assert.deepEqual(s.puzzle?.givens, puzzle.givens);
      assert.match(String(s.puzzle?.id), /^match-/);
      assert.equal(JSON.stringify(s).includes(puzzle.generation.seed), false);
      assert.equal('solution' in s.puzzle!, false);
      assert.equal('generation' in s.puzzle!, false);
      assert.equal('seed' in s.puzzle!, false);
      const values = [...puzzle.givens];
      const first = values.findIndex(value => !value);
      values[first] = 1;
      await user(HOST, () => db.query('select public.numora_save_progress($1,$2::int[],$3::jsonb)', [code, values, JSON.stringify(notes)]));
      const hostState = await user(HOST, () => state(code));
      const guestState = await user(GUEST, () => state(code));
      assert.deepEqual(hostState.self?.values, values);
      assert.deepEqual(guestState.self?.values, puzzle.givens);
      assert.equal(guestState.players.find(p => p.user_id === HOST)?.progress_count, 1);
      assert.equal(JSON.stringify(guestState.players).includes('values'), false);
      assert.equal(JSON.stringify(guestState.players).includes('notes'), false);
    });

    await t.test('saving protects fixed clues and rejects malformed notes and multidimensional boards', async () => {
      const given = puzzle.givens.findIndex(Boolean);
      const changed = [...puzzle.givens]; changed[given] = 0;
      await assert.rejects(user(HOST, () => db.query('select public.numora_save_progress($1,$2::int[],$3::jsonb)', [code, changed, JSON.stringify(notes)])), /preserve the fixed clues/);
      await assert.rejects(user(HOST, () => db.query('select public.numora_save_progress($1,$2::int[],$3::jsonb)', [code, puzzle.givens, '[]'])), /preserve the fixed clues/);
      await assert.rejects(user(HOST, () => db.query('select public.numora_save_progress($1,$2::int[],$3::jsonb)', [code, [[1,2],[3,4]], JSON.stringify(notes)])), /preserve the fixed clues/);
    });

    await t.test('server validates complete segment rules, freezes first finish, and completes only after every racer', async () => {
      await assert.rejects(user(HOST, () => db.query('select public.numora_submit_solution($1,$2::int[],$3::jsonb)', [code, puzzle.givens, JSON.stringify(notes)])), /not complete/);
      const invalid = [...puzzle.solution];
      const first = puzzle.givens.findIndex(value => !value);
      invalid[first] = invalid[first] === 1 ? 2 : 1;
      await assert.rejects(user(HOST, () => db.query('select public.numora_submit_solution($1,$2::int[],$3::jsonb)', [code, invalid, JSON.stringify(notes)])), /breaks a segment rule/);
      const firstFinish = (await user(HOST, () => db.query<{ data: State }>('select public.numora_submit_solution($1,$2::int[],$3::jsonb) as data', [code, puzzle.solution, JSON.stringify(notes)]))).rows[0].data;
      assert.equal(firstFinish.room.status, 'racing');
      const finish = firstFinish.players.find(p => p.user_id === HOST)!;
      assert.ok(finish.elapsed_ms! >= 12000);
      assert.ok(finish.finished_at);
      const repeat = (await user(HOST, () => db.query<{ data: State }>('select public.numora_submit_solution($1,$2::int[],$3::jsonb) as data', [code, puzzle.solution, JSON.stringify(notes)]))).rows[0].data;
      assert.equal(repeat.players.find(p => p.user_id === HOST)?.elapsed_ms, finish.elapsed_ms);
      assert.equal(repeat.players.find(p => p.user_id === HOST)?.finished_at, finish.finished_at);
      const allFinished = (await user(GUEST, () => db.query<{ data: State }>('select public.numora_submit_solution($1,$2::int[],$3::jsonb) as data', [code, puzzle.solution, JSON.stringify(notes)]))).rows[0].data;
      assert.equal(allFinished.room.status, 'finished');
      assert.ok(allFinished.players.filter(p => !p.is_spectator).every(p => p.finished_at && p.elapsed_ms !== null));
      assert.equal(allFinished.players.find(p => p.user_id === LATE)?.finished_at, null);
    });

    await t.test('leaving a started race preserves entries, results, and the original clock for rejoin', async () => {
      const before = await user(GUEST, () => state(code));
      await user(GUEST, () => db.query('select public.numora_leave_room($1)', [code]));
      await user(GUEST, () => db.query('select public.numora_join_room($1,$2)', [code, 'Guest']));
      const after = await user(GUEST, () => state(code));
      assert.equal(after.room.starts_at, before.room.starts_at);
      assert.deepEqual(after.self, before.self);
      assert.deepEqual(after.players.map(p => p.elapsed_ms), before.players.map(p => p.elapsed_ms));
    });

    await t.test('lobby host leave transfers ownership and the final leave removes an empty lobby', async () => {
      const lobby = await create(OUTSIDER, 'Second host');
      await user(LATE, () => db.query('select public.numora_join_room($1,$2)', [lobby, 'New host']));
      await user(OUTSIDER, () => db.query('select public.numora_leave_room($1)', [lobby]));
      assert.equal((await user(LATE, () => state(lobby))).room.host_id, LATE);
      await user(LATE, () => db.query('select public.numora_leave_room($1)', [lobby]));
      assert.equal((await db.query('select * from public.numora_rooms where code=$1', [lobby])).rows.length, 0);
    });

    await t.test('private Realtime topics authorize only room members', async () => {
      const s = await user(HOST, () => state(code));
      const topic = `numora-room:${s.room.id}`;
      const allowed = await user(HOST, () => db.query<{ ok: boolean }>('select numora_private.can_use_channel($1) as ok', [topic]));
      const denied = await user(OUTSIDER, () => db.query<{ ok: boolean }>('select numora_private.can_use_channel($1) as ok', [topic]));
      assert.equal(allowed.rows[0].ok, true);
      assert.equal(denied.rows[0].ok, false);
      assert.equal((await user(HOST, () => db.query<{ ok: boolean }>('select numora_private.can_use_channel($1) as ok', ['wrong-topic']))).rows[0].ok, false);
    });

    await t.test('failed room guesses consume the rate limit rather than rolling it back', async () => {
      for (let attempt = 0; attempt < 30; attempt++) {
        const response = await user(OUTSIDER, () => db.query<{ data: { error: string; code: string } }>('select public.numora_join_room($1,$2) as data', ['ZZZZZZ', 'Outsider']));
        assert.equal(response.rows[0].data.code, 'ROOM_NOT_FOUND');
      }
      await assert.rejects(user(OUTSIDER, () => db.query('select public.numora_join_room($1,$2)', ['ZZZZZZ', 'Outsider'])), /Too many requests/);
      const saved = await db.query<{ request_count: number }>("select request_count from numora_private.rate_limits where user_id=$1 and action='join'", [OUTSIDER]);
      assert.equal(saved.rows[0].request_count, 30);
    });

    await t.test('everyone explicitly leaving abandoned races releases the host open-room quota', async () => {
      const rooms: string[] = [];
      for (let index = 0; index < 5; index++) {
        const room = await create(GUEST, 'Guest host');
        rooms.push(room);
        await user(LATE, () => db.query('select public.numora_join_room($1,$2)', [room, 'Other player']));
        await user(GUEST, () => db.query('select public.numora_set_ready($1,true)', [room]));
        await user(LATE, () => db.query('select public.numora_set_ready($1,true)', [room]));
        await user(GUEST, () => db.query('select public.numora_start_room($1)', [room]));
      }
      // Isolate the open-room quota from the separate creation-rate limit.
      await db.query("delete from numora_private.rate_limits where user_id=$1 and action='create'", [GUEST]);
      await assert.rejects(create(GUEST, 'Guest host'), /five open rooms/);
      for (const room of rooms) {
        await user(GUEST, () => db.query('select public.numora_leave_room($1)', [room]));
        await user(LATE, () => db.query('select public.numora_leave_room($1)', [room]));
      }
      const fresh = await create(GUEST, 'Guest host');
      assert.match(fresh, /^[A-Z0-9]{6}$/);
      assert.equal((await user(GUEST, () => state(fresh))).room.status, 'lobby');
    });

    await t.test('invalid trusted puzzles cannot be created and mutation RPCs never accept client finish times', async () => {
      await assert.rejects(asRole('service_role', null, () => db.query('select public.numora_create_room($1,$2,$3::jsonb)', [HOST, 'Host', JSON.stringify({ ...puzzle, solution: Array(25).fill(1) })])), /integrity checks/);
      const missingDescription = { ...puzzle } as Record<string, unknown>;
      delete missingDescription.description;
      await assert.rejects(asRole('service_role', null, () => db.query('select public.numora_create_room($1,$2,$3::jsonb)', [HOST, 'Host', JSON.stringify(missingDescription)])), /integrity checks/);
      const params = await db.query<{ args: string }>("select pg_get_function_arguments('public.numora_submit_solution(text,integer[],jsonb)'::regprocedure) as args");
      assert.equal(/elapsed|finished|start/i.test(params.rows[0].args), false);
    });
  } finally { await db.close(); }
});

test('post-finish spectating is authorized by the server and never grants write or puzzle-secret access', async t => {
  const db = new PGlite();
  try {
    await db.exec(platformSql);
    await db.exec(migration);
    for (const id of [HOST, GUEST, OUTSIDER, LATE]) await db.query('insert into auth.users(id) values($1)', [id]);
    const asRole = async <T>(role: 'authenticated' | 'anon' | 'service_role', id: string | null, operation: () => Promise<T>) => {
      await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id ?? '']);
      await db.exec(`set role ${role}`);
      try { return await operation(); }
      finally { await db.exec('reset role'); await db.query("select set_config('request.jwt.claim.sub','',false)"); }
    };
    const user = <T>(id: string, operation: () => Promise<T>) => asRole('authenticated', id, operation);
    const create = async (host: string, name: string) => asRole('service_role', null, async () =>
      (await db.query<{ code: string }>('select public.numora_create_room($1,$2,$3::jsonb) as code', [host, name, JSON.stringify(puzzle)])).rows[0].code);
    const code = await create(HOST, 'Viewer');
    const otherCode = await create(OUTSIDER, 'Other room host');
    await user(GUEST, () => db.query('select public.numora_join_room($1,$2)', [code, 'Target']));
    const roomId = (await db.query<{ id: string }>('select id from public.numora_rooms where code=$1', [code])).rows[0].id;
    type SpectatorState = { room_id: string; player_id: string; values: number[]; notes: number[][]; updated_at: string; server_now: string };
    const watch = async (roomCode: string, target: string | null) =>
      (await db.query<{ data: SpectatorState }>('select public.numora_spectate_player($1,$2::uuid) as data', [roomCode, target])).rows[0].data;

    await t.test('anonymous, missing-auth, outsider, and unfinished viewers are denied', async () => {
      await assert.rejects(asRole('anon', null, () => watch(code, GUEST)), /permission denied/);
      await assert.rejects(asRole('authenticated', null, () => watch(code, GUEST)), /Sign in before/);
      await assert.rejects(user(OUTSIDER, () => watch(code, GUEST)), /Join this room before spectating/);
      await assert.rejects(user(HOST, () => watch(code, GUEST)), /Finish(?: or give up)? your puzzle before/);
      await assert.rejects(user(GUEST, () => watch(code, HOST)), /Finish(?: or give up)? your puzzle before/);
    });

    await user(HOST, () => db.query('select public.numora_set_ready($1,true)', [code]));
    await user(GUEST, () => db.query('select public.numora_set_ready($1,true)', [code]));
    await user(HOST, () => db.query('select public.numora_start_room($1)', [code]));

    await t.test('even a recorded finish cannot release progress before the shared start', async () => {
      // A trusted fixture isolates the clock gate; real finish RPCs already reject early submissions.
      await db.query('update public.numora_players set finished_at=clock_timestamp(),elapsed_ms=0 where room_id=$1 and user_id=$2', [roomId, HOST]);
      await assert.rejects(user(HOST, () => watch(code, GUEST)), /race has not started yet/);
      await db.query('update public.numora_players set finished_at=null,elapsed_ms=null where room_id=$1 and user_id=$2', [roomId, HOST]);
      await db.query("update public.numora_rooms set starts_at=clock_timestamp()-interval '12 seconds' where id=$1", [roomId]);
      await assert.rejects(user(HOST, () => watch(code, GUEST)), /Finish(?: or give up)? your puzzle before/);
    });

    await user(HOST, () => db.query('select public.numora_submit_solution($1,$2::integer[],$3::jsonb)', [code, puzzle.solution, JSON.stringify(notes)]));

    await t.test('a finished viewer cannot select themselves, a missing player, or someone in another room', async () => {
      await assert.rejects(user(HOST, () => watch(code, HOST)), /Choose another player/);
      await assert.rejects(user(HOST, () => watch(code, null)), /Choose another player/);
      await assert.rejects(user(HOST, () => watch(code, LATE)), /player is not in this room/);
      await assert.rejects(user(HOST, () => watch(code, OUTSIDER)), /player is not in this room/);
      await assert.rejects(user(HOST, () => watch(otherCode, OUTSIDER)), /Join this room before spectating/);
      await assert.rejects(user(HOST, () => watch('ZZZZZZ', GUEST)), /Join this room before spectating/);
    });

    let targetValues = [...puzzle.givens];
    let targetNotes = notes.map(cell => [...cell]);
    let watched: SpectatorState;
    await t.test('finished viewers can read the target’s saved guesses and notes, including rule-invalid entries', async () => {
      let invalid: number[] | null = null;
      for (let index = 0; index < targetValues.length && !invalid; index++) {
        if (puzzle.givens[index]) continue;
        for (let value = 1; value <= puzzle.size; value++) {
          const candidate = [...puzzle.givens]; candidate[index] = value;
          if (getConflicts(puzzle, candidate).size) { invalid = candidate; break; }
        }
      }
      assert.ok(invalid, 'The test board must expose a visible-rule conflict for the spectator regression.');
      targetValues = invalid;
      const noteIndex = targetValues.findIndex(value => !value);
      targetNotes[noteIndex] = [1, 2];
      await user(GUEST, () => db.query('select public.numora_save_progress($1,$2::integer[],$3::jsonb)', [code, targetValues, JSON.stringify(targetNotes)]));
      watched = await user(HOST, () => watch(code.toLowerCase(), GUEST));
      assert.equal(watched.room_id, roomId);
      assert.equal(watched.player_id, GUEST);
      assert.deepEqual(watched.values, targetValues);
      assert.deepEqual(watched.notes, targetNotes);
      assert.ok(getConflicts(puzzle, watched.values).size > 0);
      assert.deepEqual(Object.keys(watched).sort(), ['notes','player_id','room_id','server_now','updated_at','values']);
      assert.ok(Number.isFinite(Date.parse(watched.updated_at)));
      assert.ok(Date.parse(watched.server_now) >= Date.parse(watched.updated_at));
      assert.equal(JSON.stringify(watched).includes(puzzle.generation.seed), false);
      await assert.rejects(user(GUEST, () => watch(code, HOST)), /Finish(?: or give up)? your puzzle before/);
    });

    await t.test('spectating returns the newest committed target progress without writing anything', async () => {
      const anotherIndex = targetValues.findIndex((value, index) => !value && targetNotes[index].length === 0);
      targetValues = [...targetValues]; targetValues[anotherIndex] = 2;
      await user(GUEST, () => db.query('select public.numora_save_progress($1,$2::integer[],$3::jsonb)', [code, targetValues, JSON.stringify(targetNotes)]));
      const before = (await db.query<{ rows: unknown }>('select jsonb_agg(to_jsonb(p) order by user_id) as rows from numora_private.progress p where room_id=$1', [roomId])).rows[0].rows;
      const latest = await user(HOST, () => watch(code, GUEST));
      assert.deepEqual(latest.values, targetValues);
      assert.deepEqual(latest.notes, targetNotes);
      assert.ok(Date.parse(latest.updated_at) >= Date.parse(watched.updated_at));
      const after = (await db.query<{ rows: unknown }>('select jsonb_agg(to_jsonb(p) order by user_id) as rows from numora_private.progress p where room_id=$1', [roomId])).rows[0].rows;
      assert.deepEqual(after, before);
    });

    await t.test('finished spectators retain no raw-table write or read grants, and unfinished players still cannot read peers', async () => {
      for (const viewer of [HOST, GUEST]) {
        await assert.rejects(user(viewer, () => db.query('select * from numora_private.progress')), /permission denied/);
        await assert.rejects(user(viewer, () => db.query('select * from numora_private.puzzles')), /permission denied/);
        await assert.rejects(user(viewer, () => db.query('update numora_private.progress set values=$1 where room_id=$2 and user_id=$3', [puzzle.solution, roomId, GUEST])), /permission denied/);
      }
      const ownBefore = (await user(HOST, () => db.query<{ data: State }>('select public.numora_get_room($1) as data', [code]))).rows[0].data;
      await user(HOST, () => db.query('select public.numora_save_progress($1,$2::integer[],$3::jsonb)', [code, targetValues, JSON.stringify(targetNotes)]));
      const ownAfter = (await user(HOST, () => db.query<{ data: State }>('select public.numora_get_room($1) as data', [code]))).rows[0].data;
      assert.deepEqual(ownAfter.self, ownBefore.self);
      assert.deepEqual(ownAfter.players.find(player => player.user_id === HOST), ownBefore.players.find(player => player.user_id === HOST));
      assert.deepEqual(ownAfter.self?.values, puzzle.solution);
      const grants = (await db.query<{ can_read: boolean; can_write: boolean }>("select has_table_privilege('authenticated','numora_private.progress','SELECT') as can_read,has_table_privilege('authenticated','numora_private.progress','UPDATE') as can_write")).rows[0];
      assert.deepEqual(grants, { can_read: false, can_write: false });
    });

    await t.test('a finished target can also be watched and migration reapplication preserves read-only behavior', async () => {
      await user(GUEST, () => db.query('select public.numora_submit_solution($1,$2::integer[],$3::jsonb)', [code, puzzle.solution, JSON.stringify(notes)]));
      const latest = await user(HOST, () => watch(code, GUEST));
      assert.deepEqual(latest.values, puzzle.solution);
      assert.deepEqual(latest.notes, notes);
      await db.exec(migration);
      const afterReapply = await user(HOST, () => watch(code, GUEST));
      assert.deepEqual(afterReapply.values, latest.values);
      assert.deepEqual(afterReapply.notes, latest.notes);
      const flags = (await db.query<{ schema_name: string; prosecdef: boolean; proconfig: string[]; pronargs: number }>("select n.nspname as schema_name,p.prosecdef,p.proconfig,p.pronargs from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.proname in ('numora_spectate_player','spectate_player') order by n.nspname,p.pronargs")).rows;
      assert.ok(flags.filter(flag => flag.schema_name === 'public').every(flag => !flag.prosecdef));
      assert.equal(flags.find(flag => flag.schema_name === 'numora_private' && flag.pronargs === 4)?.prosecdef, true);
      assert.ok(flags.every(flag => flag.proconfig.includes('search_path=""')));
    });
  } finally { await db.close(); }
});
