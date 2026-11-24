import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { generatePuzzle } from '../../src/game/generator';

const HOST = '70000000-0000-4000-8000-000000000001';
const GUEST = '70000000-0000-4000-8000-000000000002';
const OUTSIDER = '70000000-0000-4000-8000-000000000003';
const board = generatePuzzle({ size: 5, difficulty: 'Easy', seed: 'rematch-first-round' });
const nextBoard = generatePuzzle({ size: 5, difficulty: 'Easy', seed: 'rematch-second-round' });
const notes = Array.from({ length: 25 }, () => [] as number[]);
const directory = new URL('../../supabase/migrations/', import.meta.url);
const files = readdirSync(directory).filter(name => name.endsWith('.sql')).sort();
const migrations = files.map(name => readFileSync(new URL(name, directory), 'utf8')).join('\n');
const rematchVersion = files.find(name => name.endsWith('_numora_room_rematches.sql'))!;
const rematchAndLaterMigrations = files.filter(name => name >= rematchVersion)
  .map(name => readFileSync(new URL(name, directory), 'utf8')).join('\n');
type State = {
  room: { id: string; round_id: string; code: string; host_id: string; status: string; starts_at: string | null; size: number; difficulty: string };
  players: { user_id: string; nickname: string; ready: boolean; active: boolean; progress_count: number; finished_at: string | null; given_up_at: string | null; elapsed_ms: number | null }[];
  self: { values: number[]; notes: number[][] } | null;
  puzzle: { id: string; givens: number[] } | null;
};

test('same-room rematches retain the roster and isolate each round', async t => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create schema auth; create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$
        select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;
      $$;
      grant usage on schema auth to anon,authenticated,service_role;
      create schema realtime; create table realtime.messages(extension text,topic text);
      alter table realtime.messages enable row level security;
      create function realtime.topic() returns text language sql stable as $$ select current_setting('realtime.topic',true); $$;
    `);
    await db.exec(migrations);
    for (const id of [HOST, GUEST, OUTSIDER]) await db.query('insert into auth.users(id) values($1)', [id]);
    const role = async <T>(name: string, id: string | null, operation: () => Promise<T>): Promise<T> => {
      await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id ?? '']);
      await db.exec(`set role ${name}`);
      try { return await operation(); }
      finally { await db.exec('reset role'); }
    };
    const user = <T>(id: string, operation: () => Promise<T>) => role('authenticated', id, operation);
    const rpc = async <T>(sql: string, args: unknown[] = []) => (await db.query<{ data: T }>(`${sql} as data`, args)).rows[0].data;
    const code = await role('service_role', null, () => rpc<string>('select public.numora_create_room($1,$2,$3::jsonb)', [HOST, 'Host', JSON.stringify(board)]));
    const read = (id: string) => user(id, async () => {
      const { server_now: _serverNow, ...state } = await rpc<State & { server_now: string }>('select public.numora_get_room($1)', [code]);
      return state;
    });
    const initial = await read(HOST);
    const firstRound = initial.room.round_id;
    let secondRound = '';
    const rematch = (round = firstRound, puzzle: unknown = nextBoard, host = HOST) => role('service_role', null, () =>
      rpc<string>('select public.numora_rematch_room($1,$2,$3,$4::jsonb)', [host, code, round, JSON.stringify(puzzle)]));
    const ready = (id: string, round: string) => user(id, () => rpc<State>('select public.numora_set_ready($1,true,$2)', [code, round]));
    const finish = (id: string, round: string, puzzle = board) => user(id, () => rpc<State>('select public.numora_submit_solution($1,$2::int[],$3::jsonb,$4)', [code, puzzle.solution, JSON.stringify(notes), round]));
    const releaseCountdown = () => db.query("update public.numora_rooms set starts_at=clock_timestamp()-interval '10 seconds' where code=$1", [code]);

    await t.test('initial IDs preserve legacy clients; rematches require the verified room host and completed race', async () => {
      assert.equal(firstRound, initial.room.id);
      await user(GUEST, () => rpc('select public.numora_join_room($1,$2)', [code, 'Guest']));
      for (const [name, id] of [['anon', null], ['authenticated', null], ['authenticated', HOST], ['authenticated', OUTSIDER]] as const) {
        await assert.rejects(role(name, id, () => rpc('select public.numora_rematch_room($1,$2,$3,$4::jsonb)', [HOST, code, firstRound, JSON.stringify(nextBoard)])), /permission denied/);
      }
      await assert.rejects(rematch(firstRound, nextBoard, GUEST), /Only the room host/);
      await assert.rejects(rematch(), /every player has finished/);
      await ready(HOST, firstRound); await ready(GUEST, firstRound);
      await user(HOST, () => rpc('select public.numora_start_room($1,$2)', [code, firstRound]));
      await releaseCountdown();
      await assert.rejects(rematch(), /every player has finished/);
      await finish(HOST, firstRound);
      await assert.rejects(rematch(), /every player has finished/);
      await finish(GUEST, firstRound);
      assert.equal((await read(HOST)).room.status, 'finished');
    });
    await t.test('invalid/mismatched puzzles cannot replace a finished round', async () => {
      for (const invalid of [{}, { ...nextBoard, solution: notes }, { ...nextBoard, difficulty: 'Hard' }]) {
        await assert.rejects(rematch(firstRound, invalid), /puzzle|room/i);
      }
      assert.equal((await read(HOST)).room.round_id, firstRound);
      assert.equal((await db.query('select * from numora_private.room_round_results')).rows.length, 0);
    });
    await t.test('rematch keeps room code, players, nicknames and settings; archives results and resets all private drafts', async () => {
      const before = await read(HOST);
      const oldResults = before.players.map(({ user_id, nickname, finished_at, given_up_at, elapsed_ms }) => ({ user_id, nickname, finished_at, given_up_at, elapsed_ms }));
      // A departed finished player is still a member; do not infer membership from presence.
      await user(GUEST, () => rpc('select public.numora_leave_room($1,$2)', [code, firstRound]));
      assert.equal(await rematch(), code);
      const after = await read(HOST);
      secondRound = after.room.round_id;
      assert.notEqual(secondRound, firstRound);
      assert.equal(after.room.id, before.room.id);
      assert.equal(after.room.code, before.room.code);
      assert.equal(after.room.host_id, HOST);
      assert.equal(after.room.size, before.room.size); assert.equal(after.room.difficulty, before.room.difficulty);
      assert.equal(after.room.status, 'lobby'); assert.equal(after.room.starts_at, null);
      assert.equal(after.puzzle, null); assert.equal(after.self, null);
      assert.deepEqual(after.players.map(p => [p.user_id, p.nickname]), before.players.map(p => [p.user_id, p.nickname]));
      assert.ok(after.players.every(p => !p.ready && p.progress_count === 0 && p.finished_at === null && p.elapsed_ms === null));
      assert.equal(after.players.find(p => p.user_id === GUEST)?.active, false);
      const progress = (await db.query<{ values: number[]; notes: number[][] }>('select values,notes from numora_private.progress where room_id=$1', [after.room.id])).rows;
      assert.equal(progress.length, 2);
      for (const item of progress) { assert.deepEqual(item.values, nextBoard.givens); assert.deepEqual(item.notes, notes); }
      const archive = (await db.query<{ round_id: string; results: typeof oldResults }>('select round_id,results from numora_private.room_round_results')).rows;
      assert.equal(archive.length, 1); assert.equal(archive[0].round_id, firstRound);
      assert.deepEqual([...archive[0].results].sort((a,b) => a.user_id.localeCompare(b.user_id)), oldResults.sort((a,b) => a.user_id.localeCompare(b.user_id)));
      for (const [name,id] of [['anon',null],['authenticated',HOST],['service_role',null]] as const) {
        await assert.rejects(role(name,id,()=>db.query('select * from numora_private.room_round_results')), /permission denied/);
      }
    });
    await t.test('stale and legacy requests cannot ready, start, leave, save, submit or spectate the new round', async () => {
      const requests: [string, unknown[]][] = [
        ['select public.numora_set_ready($1,true,$2)', [code, firstRound]],
        ['select public.numora_start_room($1,$2)', [code, firstRound]],
        ['select public.numora_leave_room($1,$2)', [code, firstRound]],
        ['select public.numora_save_progress($1,$2::int[],$3::jsonb,$4)', [code, board.solution, JSON.stringify(notes), firstRound]],
        ['select public.numora_submit_solution($1,$2::int[],$3::jsonb,$4)', [code, board.solution, JSON.stringify(notes), firstRound]],
        ['select public.numora_spectate_player($1,$2,$3)', [code, GUEST, firstRound]],
        ['select public.numora_set_ready($1,true)', [code]],
        ['select public.numora_start_room($1)', [code]],
        ['select public.numora_leave_room($1)', [code]],
        ['select public.numora_save_progress($1,$2::int[],$3::jsonb)', [code, board.solution, JSON.stringify(notes)]],
        ['select public.numora_submit_solution($1,$2::int[],$3::jsonb)', [code, board.solution, JSON.stringify(notes)]],
        ['select public.numora_spectate_player($1,$2)', [code, GUEST]],
        ['select numora_private.set_ready($1,true)', [code]],
        ['select numora_private.start_room($1)', [code]],
        ['select numora_private.leave_room($1)', [code]],
        ['select numora_private.save_progress($1,$2::int[],$3::jsonb)', [code, board.solution, JSON.stringify(notes)]],
        ['select numora_private.submit_solution($1,$2::int[],$3::jsonb)', [code, board.solution, JSON.stringify(notes)]],
        ['select numora_private.spectate_player($1,$2)', [code, GUEST]],
      ];
      const before = await read(HOST);
      for (const [sql,args] of requests) await assert.rejects(user(HOST,()=>rpc(sql,args)), /round has changed/);
      await assert.rejects(rematch(), /round has changed/);
      const after = await read(HOST);
      assert.deepEqual(after, before);
    });
    await t.test('new tokens restore the shared ready/countdown flow and a fresh valid finish', async () => {
      await ready(HOST,secondRound);
      await assert.rejects(user(HOST,()=>rpc('select public.numora_start_room($1,$2)',[code,secondRound])), /every player is ready/);
      await ready(GUEST,secondRound);
      const countdown = await user(HOST,()=>rpc<State>('select public.numora_start_room($1,$2)',[code,secondRound]));
      assert.equal(countdown.room.status,'racing'); assert.equal(countdown.puzzle,null);
      await releaseCountdown();
      const opened = await read(GUEST);
      assert.equal(opened.puzzle?.id,`match-${secondRound}`);
      assert.deepEqual(opened.self?.values,nextBoard.givens);
      const saved = await user(GUEST,()=>rpc<State>('select public.numora_save_progress($1,$2::int[],$3::jsonb,$4)',[code,nextBoard.givens,JSON.stringify(notes),secondRound]));
      assert.deepEqual(saved.self?.values,nextBoard.givens);
      await finish(HOST,secondRound,nextBoard);
      const spectator = await user(HOST,()=>rpc<Record<string,unknown>>('select public.numora_spectate_player($1,$2,$3)',[code,GUEST,secondRound]));
      assert.deepEqual(Object.keys(spectator).sort(),['room_id','player_id','values','notes','updated_at','server_now'].sort());
      assert.deepEqual(spectator.values,nextBoard.givens);
      await finish(GUEST,secondRound,nextBoard);
      assert.equal((await read(HOST)).room.status,'finished');
    });
    await t.test('reapplying current and all historical migrations preserves round state and archives', async () => {
      const before = await read(HOST);
      await db.exec(rematchAndLaterMigrations);
      assert.deepEqual(await read(HOST),before);
      await db.exec(migrations);
      assert.deepEqual(await read(HOST),before);
      assert.equal((await db.query('select * from numora_private.room_round_results')).rows.length,1);
      await assert.rejects(user(HOST,()=>rpc('select public.numora_start_room($1)',[code])), /round has changed/);
      assert.equal(await rematch(secondRound,board),code);
      assert.equal((await db.query('select * from numora_private.room_round_results')).rows.length,2);
      await assert.rejects(rematch(secondRound,board), /round has changed/);
    });
    await t.test('closing the next-round lobby cannot erase archived standings', async () => {
      const current = await read(HOST);
      await user(HOST,()=>rpc('select public.numora_leave_room($1,$2)',[code,current.room.round_id]));
      await user(GUEST,()=>rpc('select public.numora_leave_room($1,$2)',[code,current.room.round_id]));
      assert.equal((await db.query('select * from public.numora_rooms where code=$1',[code])).rows.length,0);
      assert.equal((await db.query('select * from numora_private.room_round_results where room_id=$1',[current.room.id])).rows.length,2);
    });
  } finally { await db.close(); }
});
