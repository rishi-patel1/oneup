import { generatePuzzle, type GeneratedPuzzle } from '../_shared/generator.ts';
import type { Difficulty } from '../_shared/engine.ts';

export class RoomRequestError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

interface Dependencies {
  authenticate: (request: Request) => Promise<{ id: string } | null>;
  createRoom: (hostId: string, nickname: string, puzzle: GeneratedPuzzle) => Promise<string>;
  generate?: typeof generatePuzzle;
  corsHeaders: Record<string, string>;
}

/** The authenticated server chooses the seed and never sends an answer to the browser. */
export function createRoomHandler(dependencies: Dependencies) {
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), {
    status, headers: { ...dependencies.corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

  return async (request: Request): Promise<Response> => {
    if (request.method === 'OPTIONS') return new Response('ok', { headers: dependencies.corsHeaders });
    if (request.method !== 'POST') return reply(405, { error: 'Use POST to create a room.' });
    try {
      const user = await dependencies.authenticate(request);
      if (!user) return reply(401, { error: 'Join as a guest before creating a room.' });
      const raw = await request.text();
      if (raw.length > 4096) return reply(413, { error: 'The room request is too large.' });
      let body: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== 'object' || !parsed || Array.isArray(parsed)) throw new Error();
        body = parsed as Record<string, unknown>;
      } catch { return reply(400, { error: 'Enter the room settings as JSON.' }); }
      const nickname = typeof body.nickname === 'string' ? body.nickname.trim().replace(/\s+/gu, ' ') : '';
      if (nickname.length < 2 || nickname.length > 24 || /[\u0000-\u001f\u007f]/u.test(nickname)) {
        return reply(400, { error: 'Choose a nickname between 2 and 24 characters.' });
      }
      if (![5, 6, 7, 8].includes(body.size as number) || !['Easy', 'Medium', 'Hard'].includes(body.difficulty as string)) {
        return reply(400, { error: 'Choose a size from 5 to 8 and an Easy, Medium, or Hard puzzle.' });
      }
      const puzzle = (dependencies.generate ?? generatePuzzle)({
        size: body.size as 5 | 6 | 7 | 8,
        difficulty: body.difficulty as Difficulty,
        seed: crypto.randomUUID(),
      });
      const code = await dependencies.createRoom(user.id, nickname, puzzle);
      if (!/^[A-Z0-9]{6}$/.test(code)) throw new Error('Unexpected room code.');
      return reply(201, { code });
    } catch (error) {
      if (error instanceof RoomRequestError) return reply(error.status, { error: error.message });
      // The generator has deterministic budgets; a bounded miss is safe to retry.
      if (error instanceof Error && error.message.includes('within the search budget')) {
        return reply(503, { error: 'We couldn’t build that puzzle just now. Please try again.' });
      }
      return reply(500, { error: 'The room could not be created. Please try again.' });
    }
  };
}
