import assert from 'node:assert/strict';
import test from 'node:test';
import { createDailyHandler, type DailyEdgeState } from '../../supabase/functions/numora-daily/handler';
import { generatePuzzle } from '../../src/game/generator';

const corsHeaders = { 'Access-Control-Allow-Origin': '*' };
const day = '2026-11-21';
const initial = (): DailyEdgeState => ({ date: day, daily: null, attempt: null, puzzle: null, profile: null, resets_at: '2026-11-22T00:00:00Z', server_now: '2026-11-21T12:00:00Z' });
const ready = (): DailyEdgeState => ({ ...initial(), daily: { id: '00000000-0000-4000-8000-000000000001' } });
const request = (body = '{}') => new Request('https://numora.test/daily', { method: 'POST', headers: { Authorization: 'Bearer test-token' }, body });

test('cached daily metadata does not generate another board or release clues', async () => {
  let generated = 0;
  const handler = createDailyHandler({ corsHeaders, authenticate: async () => 'verified-token', getState: async token => { assert.equal(token, 'verified-token'); return ready(); }, ensure: async () => assert.fail('must reuse the existing daily'), generate: () => { generated++; throw Error('should not generate'); } });
  const response = await handler(request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.deepEqual(await response.json(), ready());
  assert.equal(generated, 0);
});

test('the server chooses the daily date and hidden seed while client settings are ignored', async () => {
  let state = initial();
  let privateSeed = '';
  const handler = createDailyHandler({ corsHeaders, authenticate: async () => 'token', getState: async () => state,
    generate: options => { assert.equal(options.size, 6); assert.equal(options.difficulty, 'Medium'); assert.notEqual(options.seed, 'client-seed'); privateSeed = options.seed; return generatePuzzle(options); },
    ensure: async (date, puzzle) => { assert.equal(date, day); assert.equal(puzzle.size, 6); assert.equal(puzzle.generation.seed, privateSeed); assert.ok(puzzle.solution.length); state = ready(); },
  });
  const response = await handler(request(JSON.stringify({ date: '2020-01-01', size: 8, seed: 'client-seed', solution: [1], elapsed_ms: 1 })));
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(data, ready());
  assert.ok(privateSeed.length > 0);
  assert.equal(JSON.stringify(data).includes(privateSeed), false);
  assert.equal(JSON.stringify(data).includes('solution'), false);
});

test('concurrent first visits return the same committed daily chosen by the database', async () => {
  let state = initial(), ensured = 0;
  const handler = createDailyHandler({ corsHeaders, authenticate: async () => 'token', getState: async () => state,
    ensure: async () => { ensured++; if (!state.daily) state = ready(); },
    generate: () => generatePuzzle({ size: 6, difficulty: 'Medium', seed: 'daily-edge-concurrent' }),
  });
  const responses = await Promise.all([handler(request()), handler(request())]);
  assert.ok(ensured >= 1);
  const states = await Promise.all(responses.map(response => response.json()));
  assert.deepEqual(states[0], ready());
  assert.deepEqual(states[1], ready());
});

test('a midnight rollover during generation reads the new server date and retries', async () => {
  let state = initial();
  const dates: string[] = [];
  const handler = createDailyHandler({ corsHeaders, authenticate: async () => 'token', getState: async () => state,
    generate: () => generatePuzzle({ size: 6, difficulty: 'Medium', seed: 'daily-edge-midnight' }),
    ensure: async date => {
      dates.push(date);
      if (date === day) { state = { ...initial(), date: '2026-11-22' }; throw Error('date expired'); }
      state = { ...ready(), date: '2026-11-22' };
    },
  });
  const response = await handler(request());
  assert.equal(response.status, 200);
  assert.deepEqual(dates, [day, '2026-11-22']);
  assert.equal((await response.json()).date, '2026-11-22');
});

test('authentication, methods, preflight, and internal data redaction protect the daily endpoint', async () => {
  const base = { corsHeaders, authenticate: async () => null, getState: async () => { throw Error('should not read'); }, ensure: async () => assert.fail('should not create') };
  const handler = createDailyHandler(base);
  assert.equal((await handler(request())).status, 401);
  assert.equal((await handler(new Request('https://numora.test/daily', { method: 'DELETE' }))).status, 405);
  assert.equal((await handler(new Request('https://numora.test/daily', { method: 'OPTIONS' }))).status, 200);
  const failed = createDailyHandler({ ...base, authenticate: async () => 'token', getState: async () => { throw Error('SQL private internals'); } });
  assert.equal((await failed(request())).status, 500);
  assert.equal((await (await failed(request())).text()).includes('SQL private'), false);
  const leaked = createDailyHandler({ ...base, authenticate: async () => 'token', getState: async () => ({ ...ready(), puzzle: { solution: [1, 2] } }) });
  const response = await leaked(request());
  assert.equal(response.status, 500);
  assert.equal((await response.text()).includes('solution'), false);
});
