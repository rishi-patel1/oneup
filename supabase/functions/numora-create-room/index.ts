import { createClient } from '@supabase/supabase-js';
import { corsHeaders } from '@supabase/supabase-js/cors';
import { createRoomHandler, RoomRequestError } from './handler.ts';

function environmentKey(dictionary: string, legacy: string): string {
  const encoded = Deno.env.get(dictionary);
  if (encoded) {
    try {
      const keys = JSON.parse(encoded) as Record<string, unknown>;
      if (typeof keys.default === 'string') return keys.default;
    } catch { /* Fall back to the platform's legacy variable when necessary. */ }
  }
  return Deno.env.get(legacy) ?? '';
}

const url = Deno.env.get('SUPABASE_URL') ?? '';
const publishableKey = environmentKey('SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_ANON_KEY');
const serverKey = environmentKey('SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY');

Deno.serve(createRoomHandler({
  corsHeaders,
  authenticate: async request => {
    const authorization = request.headers.get('Authorization') ?? '';
    if (!authorization.startsWith('Bearer ') || !url || !publishableKey || !serverKey) return null;
    const scoped = createClient(url, publishableKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await scoped.auth.getUser(authorization.slice(7));
    return !error && data.user ? { id: data.user.id } : null;
  },
  createRoom: async (hostId, nickname, puzzle) => {
    const admin = createClient(url, serverKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await admin.rpc('numora_create_room', {
      p_host_id: hostId, p_nickname: nickname, p_puzzle: puzzle,
    });
    if (error) {
      if (error.code === 'P0001' || error.code === '22023') throw new RoomRequestError(400, error.message);
      if (error.code === 'PGRST202') throw new RoomRequestError(503, 'The competition database is not set up yet.');
      throw new Error('Room creation failed.');
    }
    return data as string;
  },
}));
