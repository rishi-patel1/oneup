import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { generatePuzzle } from '../../src/game/generator';

type State = {
  room: { id: string; code: string; host_id: string; status: string; starts_at: string | null };
  players: { user_id: string; ready: boolean; progress_count: number; finished_at: string | null; elapsed_ms: number | null }[];
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
const migration = readFileSync(new URL('../../supabase/migrations/20261119140624_numora_competition.sql', import.meta.url), 'utf8');

test('competition SQL: authorization, hidden boards, race rules, persistence, and timing', async t => {
  const db = new PGlite();
  try {
    // Minimal platform fixtures: the migration itself runs unchanged.
    await db.exec(`
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
    `);
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
      const late = await user(LATE, () => db.query<{ data: { error: string } }>('select public.numora_join_room($1,$2) as data', [code, 'Late']));
      assert.match(late.rows[0].data.error, /already started/);
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

    await t.test('server validates complete segment rules, freezes first finish, and completes only after every player', async () => {
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
      assert.ok(allFinished.players.every(p => p.finished_at && p.elapsed_ms !== null));
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
