import { createClient } from '@supabase/supabase-js';
import { corsHeaders } from '@supabase/supabase-js/cors';
import { createDailyHandler, DailyRequestError, type DailyEdgeState } from './handler.ts';

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
const scoped = (token: string) => createClient(url, publishableKey, { auth: noSession, global: { headers: { Authorization: `Bearer ${token}` } } });

Deno.serve(createDailyHandler({
  corsHeaders,
  authenticate: async request => {
    const header = request.headers.get('Authorization') ?? '';
    if (!header.startsWith('Bearer ') || !url || !publishableKey || !serverKey) return null;
    const token = header.slice(7);
    const { data, error } = await scoped(token).auth.getUser(token);
    return !error && data.user ? token : null;
  },
  getState: async token => {
    const { data, error } = await scoped(token).rpc('numora_get_daily');
    if (error) {
      if (error.code === 'PGRST202') throw new DailyRequestError(503, 'Daily puzzles are not set up yet.');
      throw new Error('Daily context unavailable.');
    }
    return data as DailyEdgeState;
  },
  ensure: async (date, puzzle) => {
    const admin = createClient(url, serverKey, { auth: noSession });
    const { error } = await admin.rpc('numora_ensure_daily', { p_date: date, p_puzzle: puzzle });
    if (error) throw new Error('Daily creation failed.');
  },
}));
