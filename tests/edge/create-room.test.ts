import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRoomHandler, RoomRequestError } from '../../supabase/functions/numora-create-room/handler';
import { generatePuzzle } from '../../src/game/generator';

const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type' };
const request = (body: unknown) => new Request('https://example.test/rooms', { method: 'POST', body: JSON.stringify(body) });

test('creation authenticates, chooses a server seed, and returns only a room code', async () => {
  let created = false;
  const handler = createRoomHandler({
    corsHeaders: headers,
    authenticate: async () => ({ id: 'verified-user' }),
    createRoom: async (id, name, puzzle) => {
      assert.equal(id, 'verified-user');
      assert.equal(name, 'Mira');
      assert.notEqual(puzzle.generation.seed, 'client-controlled-seed');
      assert.ok(puzzle.solution.length);
      created = true;
      return 'ABC234';
    },
  });
  const response = await handler(request({ nickname: ' Mira ', size: 5, difficulty: 'Easy', host_id: 'forged', seed: 'client-controlled-seed' }));
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { code: 'ABC234' });
  assert.equal(created, true);
});

test('unauthenticated callers and invalid settings cannot create or generate a room', async () => {
  let called = false;
  const dependencies = { corsHeaders: headers, createRoom: async () => { called = true; return 'ABC234'; } };
  const noAuth = createRoomHandler({ ...dependencies, authenticate: async () => null });
  assert.equal((await noAuth(request({ nickname: 'Mira', size: 5, difficulty: 'Easy' }))).status, 401);
  const handler = createRoomHandler({ ...dependencies, authenticate: async () => ({ id: 'user' }) });
  for (const body of [{ nickname: 'x', size: 5, difficulty: 'Easy' }, { nickname: 'Mira', size: 9, difficulty: 'Easy' }, { nickname: 'Mira', size: 5, difficulty: 'Unknown' }, null]) {
    assert.equal((await handler(request(body))).status, 400);
  }
  assert.equal(called, false);
  const preflight = await handler(new Request('https://example.test', { method: 'OPTIONS' }));
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal((await handler(new Request('https://example.test'))).status, 405);
});

test('known database errors remain useful, unexpected internals never reach clients', async () => {
  const base = { corsHeaders: headers, authenticate: async () => ({ id: 'user' }), generate: () => generatePuzzle({ size: 5, difficulty: 'Easy', seed: 'server-error-fixture' }) };
  const body = { nickname: 'Mira', size: 5, difficulty: 'Easy' };
  const expected = createRoomHandler({ ...base, createRoom: async () => { throw new RoomRequestError(400, 'You already have too many open rooms.'); } });
  assert.deepEqual(await (await expected(request(body))).json(), { error: 'You already have too many open rooms.' });
  const unexpected = createRoomHandler({ ...base, createRoom: async () => { throw new Error('private-database-detail'); } });
  const response = await unexpected(request(body));
  assert.equal(response.status, 500);
  assert.equal(JSON.stringify(await response.json()).includes('private-database-detail'), false);
});

test('the Edge generator is an exact Deno-import-compatible copy of the versioned source', async () => {
  for (const file of ['engine.ts', 'solver.ts', 'generator.ts']) {
    const source = await readFile(new URL(`../../src/game/${file}`, import.meta.url), 'utf8');
    const shared = await readFile(new URL(`../../supabase/functions/_shared/${file}`, import.meta.url), 'utf8');
    const normalized = source.replace(/from '(\.\/(?:engine|solver))'/g, "from '$1.ts'");
    assert.equal(shared.split('\n').slice(2).join('\n'), normalized);
  }
});
