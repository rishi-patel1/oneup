import { generatePuzzle, type GeneratedPuzzle } from '../_shared/generator.ts';
import type { Difficulty } from '../_shared/engine.ts';

export class RematchRequestError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

export interface RematchUser { id: string; token: string }
export type GridPhase = 'lobby' | 'finished';

interface Dependencies {
  authenticate: (request: Request) => Promise<RematchUser | null>;
  getRoom: (token: string, code: string) => Promise<unknown>;
  prepareGrid: (hostId: string, code: string, roundId: string, phase: GridPhase, puzzle: GeneratedPuzzle) => Promise<string>;
  generate?: typeof generatePuzzle;
  corsHeaders: Record<string, string>;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A verified host can prepare only the lobby or finished round they actually viewed. */
export function createRematchHandler(dependencies: Dependencies) {
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), {
    status, headers: { ...dependencies.corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
  return async (request: Request): Promise<Response> => {
    if (request.method === 'OPTIONS') return new Response('ok', { headers: dependencies.corsHeaders });
    if (request.method !== 'POST') return reply(405, { error: 'Use POST to prepare another round.' });
    try {
      const user = await dependencies.authenticate(request);
      if (!user) return reply(401, { error: 'Connect to the room before starting another round.' });
      const raw = await request.text();
      if (raw.length > 4096) return reply(413, { error: 'The next-round request is too large.' });
      let body: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (!record(parsed)) throw new Error();
        body = parsed;
      } catch { return reply(400, { error: 'Enter the room and current round as JSON.' }); }
      const code = typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
      const roundId = typeof body.round_id === 'string' ? body.round_id.trim().toLowerCase() : '';
      if (!/^[A-Z0-9]{6}$/.test(code) || !uuid.test(roundId)) {
        return reply(400, { error: 'Reconnect to the room before starting another round.' });
      }
      // Legacy rematches keep their existing settings and require a finished race.
      const phase = body.phase === undefined ? 'finished' : body.phase;
      if (phase !== 'lobby' && phase !== 'finished') return reply(400, { error: 'Choose a lobby or finished-round grid phase.' });
      if ((body.size !== undefined && ![5, 6, 7, 8].includes(body.size as number)) ||
        (body.difficulty !== undefined && !['Easy', 'Medium', 'Hard'].includes(body.difficulty as string))) {
        return reply(400, { error: 'Choose a grid size from 5 through 8 and a difficulty.' });
      }

      // Check the caller's scoped membership and host status before generating a board.
      const state = await dependencies.getRoom(user.token, code);
      if (!record(state) || !record(state.room)) throw new Error('Unexpected room context.');
      const room = state.room;
      if (room.code !== code || typeof room.host_id !== 'string' || !uuid.test(room.host_id) ||
        typeof room.round_id !== 'string' || !uuid.test(room.round_id)) throw new Error('Unexpected room context.');
      if (room.host_id.toLowerCase() !== user.id.toLowerCase()) {
        return reply(403, { error: 'Only the room host can apply a grid choice.' });
      }
      if (room.round_id.toLowerCase() !== roundId) return reply(409, { error: 'The room has already moved to another round. Reconnect to continue.' });
      if (room.status !== phase) return reply(409, { error: 'The grid voting phase has changed. Reconnect to see the current choice.' });
      if (![5, 6, 7, 8].includes(room.size as number) || !['Easy', 'Medium', 'Hard'].includes(room.difficulty as string)) {
        throw new Error('Unexpected room settings.');
      }
      const puzzle = (dependencies.generate ?? generatePuzzle)({
        size: (body.size ?? room.size) as 5 | 6 | 7 | 8,
        difficulty: (body.difficulty ?? room.difficulty) as Difficulty,
        seed: crypto.randomUUID(),
      });
      // The database locks the room and repeats authorization/round checks atomically.
      const nextCode = await dependencies.prepareGrid(user.id, code, roundId, phase, puzzle);
      if (nextCode !== code) throw new Error('Unexpected room code.');
      return reply(201, { code });
    } catch (cause) {
      if (cause instanceof RematchRequestError) return reply(cause.status, { error: cause.message });
      if (cause instanceof Error && cause.message.includes('within the search budget')) {
        return reply(503, { error: 'We couldn’t build the next puzzle just now. Please try again.' });
      }
      return reply(500, { error: 'The next round could not be prepared. Please try again.' });
    }
  };
}
