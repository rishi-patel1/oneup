import { generatePuzzle, type GeneratedPuzzle } from '../_shared/generator.ts';

export class DailyRequestError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

export interface DailyEdgeState {
  date: string;
  daily: { id: string } | null;
  [key: string]: unknown;
}

interface Dependencies {
  authenticate: (request: Request) => Promise<string | null>;
  getState: (accessToken: string) => Promise<DailyEdgeState>;
  ensure: (date: string, puzzle: GeneratedPuzzle) => Promise<void>;
  generate?: typeof generatePuzzle;
  corsHeaders: Record<string, string>;
}

function safeSnapshot(value: unknown): boolean {
  if (!value || typeof value !== 'object') return true;
  return Object.entries(value).every(([key, child]) =>
    !['solution', 'seed', 'generation', 'email', 'access_token', 'refresh_token', 'provider_token'].includes(key) && safeSnapshot(child));
}

/** The database supplies the 9:30 AM IST challenge date; its unique key chooses one shared board. */
export function createDailyHandler(dependencies: Dependencies) {
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), {
    status, headers: { ...dependencies.corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
  const snapshot = (state: DailyEdgeState) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(state.date) || !safeSnapshot(state)) throw new Error('Unexpected daily response.');
    return reply(200, state);
  };
  return async (request: Request): Promise<Response> => {
    if (request.method === 'OPTIONS') return new Response('ok', { headers: dependencies.corsHeaders });
    if (!['GET', 'POST'].includes(request.method)) return reply(405, { error: 'Use GET or POST to open today’s puzzle.' });
    try {
      const token = await dependencies.authenticate(request);
      if (!token) return reply(401, { error: 'Connect as a guest or sign in before opening today’s puzzle.' });
      let state = await dependencies.getState(token);
      for (let attempt = 0; attempt < 3; attempt++) {
        if (state.daily) return snapshot(state);
        const puzzle = (dependencies.generate ?? generatePuzzle)({ size: 6, difficulty: 'Medium', seed: crypto.randomUUID() });
        try { await dependencies.ensure(state.date, puzzle); }
        catch (cause) {
          // The daily reset can pass while the generator is running. Read its server date again.
          const current = await dependencies.getState(token);
          if (current.date !== state.date) { state = current; continue; }
          throw cause;
        }
        state = await dependencies.getState(token);
      }
      return reply(503, { error: 'Today’s puzzle is getting ready. Please try again in a moment.' });
    } catch (cause) {
      if (cause instanceof DailyRequestError) return reply(cause.status, { error: cause.message });
      if (cause instanceof Error && cause.message.includes('within the search budget')) return reply(503, { error: 'Today’s puzzle is getting ready. Please try again.' });
      return reply(500, { error: 'Today’s puzzle could not be opened. Please try again.' });
    }
  };
}
