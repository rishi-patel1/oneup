import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { User } from '@supabase/supabase-js';
import { supabase } from '../utils/supabase';
import { startGoogleSignIn, signInExistingGoogleAccount, signOutAccount } from './auth';

interface AccountContextValue {
  user: User | null;
  loading: boolean;
  busy: boolean;
  isGoogle: boolean;
  error: string;
  signInGoogle: () => Promise<void>;
  signInExistingGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
  clearError: () => void;
}

const AccountContext = createContext<AccountContextValue | null>(null);

function callbackMessage() {
  const query = new URLSearchParams(window.location.search);
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const code = query.get('error_code') || hash.get('error_code') || '';
  const description = query.get('error_description') || hash.get('error_description') || '';
  if (!query.has('error') && !hash.has('error') && !code) return '';
  if (/identity_already_exists|already.*(?:linked|registered|exists)/i.test(`${code} ${description}`)) {
    return 'That Google account already exists. Choose “Use an existing Google account” to sign in to it.';
  }
  return 'Google sign-in didn’t finish. You can try again and keep playing solo meanwhile.';
}

const initialCallbackMessage = callbackMessage();

function returnUrl() {
  const url = new URL(window.location.href);
  url.search = '?view=daily';
  url.hash = '';
  return url.toString();
}

export function AccountProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(Boolean(supabase));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialCallbackMessage);
  const operation = useRef(false);

  useEffect(() => {
    if (!supabase) return;
    let mounted = true;
    // Keep the Auth callback synchronous; other data loads happen in page effects.
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      if (mounted) { setUser(session?.user ?? null); setLoading(false); }
    });
    void supabase.auth.getSession().then(({ data: sessionData, error: problem }) => {
      if (!mounted) return;
      if (problem) setError('Couldn’t restore your account. Please try signing in again.');
      setUser(sessionData.session?.user ?? null);
      setLoading(false);
    }).catch(() => {
      if (mounted) { setLoading(false); setError('Couldn’t restore your account. Please try again.'); }
    });
    return () => { mounted = false; data.subscription.unsubscribe(); };
  }, []);

  const run = useCallback(async (action: () => Promise<unknown>) => {
    if (operation.current) return;
    operation.current = true; setBusy(true); setError('');
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Couldn’t update your account. Please try again.'); }
    finally { operation.current = false; setBusy(false); }
  }, []);

  const signInGoogle = useCallback(() => run(() => startGoogleSignIn(returnUrl())), [run]);
  const signInExistingGoogle = useCallback(() => run(() => signInExistingGoogleAccount(returnUrl())), [run]);
  const signOut = useCallback(() => run(() => signOutAccount()), [run]);
  const clearError = useCallback(() => setError(''), []);
  // This drives presentation only. Ranking and friends use verified server identities.
  const isGoogle = Boolean(user && !user.is_anonymous && user.identities?.some(identity => identity.provider === 'google'));
  return <AccountContext.Provider value={{ user, loading, busy, isGoogle, error, signInGoogle, signInExistingGoogle, signOut, clearError }}>{children}</AccountContext.Provider>;
}

export function useAccount() {
  const value = useContext(AccountContext);
  if (!value) throw new Error('AccountProvider is missing.');
  return value;
}
