import { createClient } from '@supabase/supabase-js';
import { corsHeaders } from '@supabase/supabase-js/cors';
import { createRematchHandler, RematchRequestError } from './handler.ts';

function environmentKey(dictionary: string, legacy: string): string {
  try {
    const keys = JSON.parse(Deno.env.get(dictionary) ?? '{}') as Record<string, unknown>;
    if (typeof keys.default === 'string') return keys.default;
  } catch { /* Older deployments expose the legacy variables. */ }
  return Deno.env.get(legacy) ?? '';
}

const url = Deno.env.get('SUPABASE_URL') ?? '';
const publishableKey = environmentKey('SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_ANON_KEY');
const serverKey = environmentKey('SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY');
const noSession = { persistSession: false, autoRefreshToken: false };
const scoped = (token: string) => createClient(url, publishableKey, {
  auth: noSession, global: { headers: { Authorization: `Bearer ${token}` } },
});

Deno.serve(createRematchHandler({
  corsHeaders,
  authenticate: async request => {
    const header = request.headers.get('Authorization') ?? '';
    if (!header.startsWith('Bearer ') || !url || !publishableKey || !serverKey) return null;
    const token = header.slice(7);
    const { data, error } = await scoped(token).auth.getUser(token);
    return !error && data.user ? { id: data.user.id, token } : null;
  },
  getRoom: async (token, code) => {
    const { data, error } = await scoped(token).rpc('numora_get_room', { p_code: code });
    if (error) {
      if (error.code === '42501') throw new RematchRequestError(403, 'Join this room before starting another round.');
      if (error.code === 'PGRST202') throw new RematchRequestError(503, 'Another round is not available yet. Please try again later.');
      throw new Error('Room context unavailable.');
    }
    return data;
  },
  rematch: async (hostId, code, roundId, puzzle) => {
    const admin = createClient(url, serverKey, { auth: noSession });
    const { data, error } = await admin.rpc('numora_rematch_room', {
      p_host_id: hostId, p_code: code, p_round_id: roundId, p_puzzle: puzzle,
    });
    if (error) {
      if (error.code === '42501') throw new RematchRequestError(403, 'Only the room host can prepare another round.');
      if (error.code === 'P0001') {
        if (/too many/i.test(error.message)) throw new RematchRequestError(429, 'Too many attempts. Please wait a moment and try again.');
        throw new RematchRequestError(409, 'The room has changed. Reconnect before preparing another round.');
      }
      if (error.code === '22023') {
        if (/round.*changed/i.test(error.message)) throw new RematchRequestError(409, 'The room has already moved to another round. Reconnect to continue.');
        throw new RematchRequestError(400, 'The next puzzle could not be prepared. Please try again.');
      }
      if (error.code === 'PGRST202') throw new RematchRequestError(503, 'Another round is not available yet. Please try again later.');
      throw new Error('Rematch creation failed.');
    }
    return data as string;
  },
}));
