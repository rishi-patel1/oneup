import type { SupabaseClient } from '@supabase/supabase-js';
import { supabase } from '../utils/supabase';

export class AccountAuthError extends Error {
  constructor(message: string, public readonly canSignInExistingAccount = false) { super(message); }
}
export function isGoogleIdentityConflict(error: unknown): boolean {
  const source = error && typeof error === 'object' ? error as { code?: unknown; message?: unknown } : {};
  return /identity_already_exists|identity.*already.*(?:linked|exists)|already.*linked.*(?:user|account)|user_already_exists/.test(`${source.code ?? ''} ${source.message ?? ''}`.toLowerCase());
}
export function explainAccountError(error: unknown): string {
  if (error instanceof AccountAuthError) return error.message;
  if (isGoogleIdentityConflict(error)) return 'This Google account already belongs to another Numora account. Choose “Sign in to existing account” to use it; your current guest progress will stay with this guest.';
  const source = error && typeof error === 'object' ? error as { code?: unknown; message?: unknown } : {};
  const text = `${source.code ?? ''} ${source.message ?? ''}`.toLowerCase();
  if (/manual.*link.*(?:disabled|not enabled)|manual_linking_disabled/.test(text)) return 'Google linking is not available yet. Your guest progress is safe. Please try again later.';
  if (/provider.*(?:disabled|not enabled|unsupported)|unsupported_provider|oauth_provider_not_supported/.test(text)) return 'Google sign-in is not available yet. Please try again later.';
  if (/network|failed to fetch|fetch failed|timeout|timed out/.test(text)) return 'Couldn’t connect to Google sign-in. Check your connection and try again.';
  if (/access_denied|cancel/.test(text)) return 'Google sign-in was cancelled. You can keep playing as a guest.';
  return 'Google sign-in couldn’t finish. Please try again.';
}

export function createAccountAuth(client: SupabaseClient | null) {
  function service() { if (!client) throw new AccountAuthError('Sign-in is not configured yet. You can keep playing as a guest.'); return client; }
  function options(redirectTo: string) {
    let url: URL;
    try { url = new URL(redirectTo); } catch { throw new AccountAuthError('The sign-in return address is invalid. Refresh and try again.'); }
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new AccountAuthError('The sign-in return address is invalid. Refresh and try again.');
    return { redirectTo: url.href, queryParams: { prompt: 'select_account' } };
  }
  function failure(error: unknown): never { throw new AccountAuthError(explainAccountError(error), isGoogleIdentityConflict(error)); }
  async function startGoogleSignIn(redirectTo: string): Promise<void> {
    const auth = service().auth, config = options(redirectTo);
    const { data, error } = await auth.getSession();
    if (error) failure(error);
    // Linking upgrades the existing guest instead of orphaning their room/progress identity.
    const response = data.session?.user.is_anonymous
      ? await auth.linkIdentity({ provider: 'google', options: config })
      : await auth.signInWithOAuth({ provider: 'google', options: config });
    if (response.error) failure(response.error);
  }
  async function signInExistingGoogleAccount(redirectTo: string): Promise<void> {
    const config = options(redirectTo);
    const { error } = await service().auth.signInWithOAuth({ provider: 'google', options: config });
    if (error) failure(error);
  }
  async function signOutAccount(): Promise<void> {
    const { error } = await service().auth.signOut({ scope: 'local' });
    if (error) throw new AccountAuthError('Sign-out couldn’t finish. Please try again.');
  }
  return { startGoogleSignIn, signInExistingGoogleAccount, signOutAccount };
}
export const { startGoogleSignIn, signInExistingGoogleAccount, signOutAccount } = createAccountAuth(supabase);
