import assert from 'node:assert/strict';
import test from 'node:test';
import type { SupabaseClient } from '@supabase/supabase-js';
import { AccountAuthError, createAccountAuth, explainAccountError } from './auth';

function mock(anonymous: boolean | null) {
  const calls: { name: string; args: unknown }[] = [];
  let failure: unknown = null;
  const client = { auth: {
    async getSession() { calls.push({ name: 'getSession', args: null }); return { data: { session: anonymous === null ? null : { user: { is_anonymous: anonymous } } }, error: null }; },
    async linkIdentity(args: unknown) { calls.push({ name: 'linkIdentity', args }); return { data: {}, error: failure }; },
    async signInWithOAuth(args: unknown) { calls.push({ name: 'signInWithOAuth', args }); return { data: {}, error: failure }; },
    async signOut(args: unknown) { calls.push({ name: 'signOut', args }); return { error: failure }; },
  } } as unknown as SupabaseClient;
  return { api: createAccountAuth(client), calls, fail: (error: unknown) => { failure = error; } };
}

test('Google sign-in links an existing guest and preserves their identity', async () => {
  const service = mock(true); assert.equal(service.calls.length, 0);
  await service.api.startGoogleSignIn('http://localhost:5173/?view=daily');
  assert.deepEqual(service.calls.map(call => call.name), ['getSession', 'linkIdentity']);
  assert.deepEqual(service.calls[1].args, { provider: 'google', options: { redirectTo: 'http://localhost:5173/?view=daily', queryParams: { prompt: 'select_account' } } });
});

test('a new visitor uses normal OAuth without creating a guest', async () => {
  const service = mock(null); await service.api.startGoogleSignIn('https://numora.example/');
  assert.deepEqual(service.calls.map(call => call.name), ['getSession', 'signInWithOAuth']);
});

test('link conflicts offer explicit existing-account login without automatic account switching', async () => {
  const service = mock(true); service.fail({ code: 'identity_already_exists', message: 'Identity is already linked to another user' });
  await assert.rejects(service.api.startGoogleSignIn('https://numora.example/'), error => error instanceof AccountAuthError && error.canSignInExistingAccount && /existing account/.test(error.message));
  assert.deepEqual(service.calls.map(call => call.name), ['getSession', 'linkIdentity']);
  service.fail(null); await service.api.signInExistingGoogleAccount('https://numora.example/');
  assert.equal(service.calls.at(-1)?.name, 'signInWithOAuth');
  assert.equal(service.calls.some(call => call.name === 'signOut'), false);
});

test('sign-out is local and provider configuration errors stay product-safe', async () => {
  const service = mock(false); await service.api.signOutAccount();
  assert.deepEqual(service.calls[0], { name: 'signOut', args: { scope: 'local' } });
  assert.match(explainAccountError({ code: 'manual_linking_disabled' }), /guest progress is safe/);
  assert.match(explainAccountError({ code: 'provider_disabled' }), /not available/);
  assert.equal(explainAccountError({ message: 'Internal failure token=secret' }), 'Google sign-in couldn’t finish. Please try again.');
});

test('invalid redirect protocols and missing setup cannot launch OAuth', async () => {
  const service = mock(null);
  await assert.rejects(service.api.startGoogleSignIn('javascript:alert(1)'), /return address/);
  assert.equal(service.calls.length, 0);
  await assert.rejects(createAccountAuth(null).startGoogleSignIn('https://numora.example/'), /not configured/);
});
