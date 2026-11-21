import { createClient } from '@supabase/supabase-js';

// Vite supplies env in the browser; Node-based model tests can import this safely.
const url = import.meta.env?.VITE_SUPABASE_URL;
const key = import.meta.env?.VITE_SUPABASE_PUBLISHABLE_KEY;
export const isSupabaseConfigured = Boolean(url && key);

export const supabase = url && key ? createClient(url, key, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce', storageKey: 'numora-competition-auth' },
  realtime: { params: { eventsPerSecond: 5 } },
}) : null;
