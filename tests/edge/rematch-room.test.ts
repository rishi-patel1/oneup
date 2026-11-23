import assert from 'node:assert/strict';
import test from 'node:test';
import { createRematchHandler, RematchRequestError } from '../../supabase/functions/numora-rematch-room/handler';
import { generatePuzzle } from '../../src/game/generator';

const HOST = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const ROUND = '00000000-0000-4000-8000-000000000003';
const NEXT = '00000000-0000-4000-8000-000000000004';
const CODE = 'ABC234';
const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type' };
const request = (body: unknown = { code: CODE, round_id: ROUND }) => new Request('https://example.test/rematch', { method: 'POST', body: JSON.stringify(body) });
const state = () => ({ room: { code: CODE, host_id: HOST, round_id: ROUND, status: 'finished', size: 5, difficulty: 'Easy' } });
const fixture = generatePuzzle({ size: 5, difficulty: 'Easy', seed: 'rematch-handler-tests' });
const base = () => ({
  corsHeaders: headers,
  authenticate: async () => ({ id: HOST, token: 'verified-token' }),
  getRoom: async () => state(),
  rematch: async () => CODE,
  generate: () => fixture,
});

test('rematch verifies scoped host/current round before choosing a new server puzzle and returns only the same code', async () => {
  let generated = false, committed = false;
  const handler = createRematchHandler({
    ...base(),
    getRoom: async (token, code) => {
      assert.equal(token, 'verified-token');
      assert.equal(code, CODE);
      assert.equal(generated, false);
      return state();
    },
    generate: options => {
      generated = true;
      assert.equal(options.size, 5);
      assert.equal(options.difficulty, 'Easy');
      assert.match(options.seed, /^[a-f0-9-]{36}$/);
      assert.notEqual(options.seed, 'forged-seed');
      return fixture;
    },
    rematch: async (id, code, round, puzzle) => {
      assert.equal(generated, true);
      assert.equal(id, HOST);
      assert.equal(code, CODE);
      assert.equal(round, ROUND);
      assert.equal(puzzle, fixture);
      assert.ok(puzzle.solution.length);
      committed = true;
      return CODE;
    },
  });
  const response = await handler(request({ code: ' abc234 ', round_id: ROUND.toUpperCase(), host_id: OTHER, puzzle: { solution: [1] }, seed: 'forged-seed', size: 8, difficulty: 'Hard', elapsed_ms: 0 }));
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { code: CODE });
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(committed, true);
});

test('rematch rejects missing auth, malformed routing, nonhosts, stale rounds, and unfinished races before generation', async () => {
  let generated = 0, committed = 0, queried = 0;
  const dependencies = {
    ...base(),
    generate: () => { generated++; return fixture; },
    rematch: async () => { committed++; return CODE; },
    getRoom: async () => { queried++; return state(); },
  };
  const noAuth = createRematchHandler({ ...dependencies, authenticate: async () => null });
  assert.equal((await noAuth(request())).status, 401);
  const valid = createRematchHandler(dependencies);
  for (const body of [null, [], { code: 'SHORT', round_id: ROUND }, { code: CODE, round_id: 'bad' }, { code: CODE }]) {
    assert.equal((await valid(request(body))).status, 400);
  }
  assert.equal(queried, 0);
  const notHost = createRematchHandler({ ...dependencies, authenticate: async () => ({ id: OTHER, token: 'other-token' }) });
  assert.equal((await notHost(request({ code: CODE, round_id: ROUND, host_id: HOST }))).status, 403);
  const stale = createRematchHandler({ ...dependencies, getRoom: async () => ({ room: { ...state().room, round_id: NEXT } }) });
  assert.equal((await stale(request())).status, 409);
  for (const status of ['racing', 'lobby']) {
    const unfinished = createRematchHandler({ ...dependencies, getRoom: async () => ({ room: { ...state().room, status } }) });
    assert.equal((await unfinished(request())).status, 409);
  }
  assert.equal(generated, 0);
  assert.equal(committed, 0);
});

test('rematch bounds the request and handles preflight/unsupported methods without authentication', async () => {
  let authenticated = false;
  const handler = createRematchHandler({ ...base(), authenticate: async () => { authenticated = true; return { id: HOST, token: 'token' }; } });
  const preflight = await handler(new Request('https://example.test/rematch', { method: 'OPTIONS' }));
  assert.equal(preflight.status, 200);
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal((await handler(new Request('https://example.test/rematch'))).status, 405);
  assert.equal(authenticated, false);
  assert.equal((await handler(new Request('https://example.test/rematch', { method: 'POST', body: 'x'.repeat(4097) }))).status, 413);
  assert.equal((await handler(new Request('https://example.test/rematch', { method: 'POST', body: '{' }))).status, 400);
});

test('rematch validates server context and never returns private internals on failure', async () => {
  let generated = false;
  for (const context of [null, {}, { room: null }, { room: { ...state().room, code: 'DIFFER' } }, { room: { ...state().room, size: 9 } }, { room: { ...state().room, round_id: 'private-bad-value' } }]) {
    const handler = createRematchHandler({ ...base(), getRoom: async () => context, generate: () => { generated = true; return fixture; } });
    const response = await handler(request());
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'The next round could not be prepared. Please try again.' });
  }
  assert.equal(generated, false);
  const unexpected = createRematchHandler({ ...base(), rematch: async () => { throw new Error('secret-db-token-and-solution'); } });
  const failed = await unexpected(request());
  assert.equal(failed.status, 500);
  assert.equal(JSON.stringify(await failed.json()).includes('secret-db-token-and-solution'), false);
  const wrongCode = createRematchHandler({ ...base(), rematch: async () => 'BAD234' });
  assert.equal((await wrongCode(request())).status, 500);
});

test('database conflicts and bounded generation failures are retryable without retrying the reset', async () => {
  let calls = 0;
  const conflict = createRematchHandler({ ...base(), rematch: async () => {
    calls++;
    throw new RematchRequestError(409, 'The room has already moved to another round. Reconnect to continue.');
  } });
  const response = await conflict(request());
  assert.equal(response.status, 409);
  assert.equal(calls, 1);
  assert.deepEqual(await response.json(), { error: 'The room has already moved to another round. Reconnect to continue.' });
  const exhausted = createRematchHandler({ ...base(), generate: () => { throw new Error('Could not generate within the search budget'); } });
  assert.equal((await exhausted(request())).status, 503);
});
