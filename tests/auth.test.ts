import { test, expect } from 'bun:test';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { login, PlanAuth } from '../src/auth';
import { CredentialStore, type Account } from '../src/platform';

test('credential storage protects tokens at rest and round-trips Unicode on Windows', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'voice-credentials-'));
  const store = new CredentialStore(join(directory, 'credentials'));
  try {
    await store.update(() => ({ hostId: 'проверка-ё', discordToken: 'test-fixture-only' }));
    const saved = await store.read(); expect(saved.hostId).toBe('проверка-ё');
    expect(saved.discordToken).toBe('test-fixture-only');
    if (process.platform === 'win32') expect(await readFile(store.path, 'utf8')).not.toContain('test-fixture-only');
    await Promise.all([store.update(v => ({ ...v, hostId: 'другое' })), store.update(v => ({ ...v, discordToken: 'new-test-fixture' }))]);
    expect(await store.read()).toMatchObject({ hostId: 'другое', discordToken: 'new-test-fixture' });
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 30000);

test('OAuth rejects a forged callback, uses issued client ID and PKCE, then validates signed identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'voice-oauth-'));
  const store = new CredentialStore(join(directory, 'credentials'));
  const originalFetch = globalThis.fetch;
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey); jwk.kid = 'test-key';
  let authorization!: URL;
  let announce!: () => void;
  const announced = new Promise<void>(r => { announce = r; });
  let exchanges = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
    if (url.hostname === '127.0.0.1') return originalFetch(input, init);
    if (url.pathname.endsWith('openid-configuration')) return Response.json({ issuer: 'https://auth.openai.com', authorization_endpoint: 'https://auth.openai.com/api/accounts/authorize', token_endpoint: 'https://auth.openai.com/api/accounts/oauth/token', jwks_uri: 'https://auth.openai.com/.well-known/jwks.json' });
    if (url.pathname.endsWith('jwks.json')) return Response.json({ keys: [jwk] });
    if (url.pathname.endsWith('/oauth/token')) {
      exchanges++;
      const form = new URLSearchParams(init!.body as URLSearchParams);
      expect(form.get('client_id')).toBe('oaiapp_test_fixture');
      expect(form.get('code_verifier')!.length).toBeGreaterThanOrEqual(43);
      expect(form.get('resource')).toBe('https://api.openai.com/v1');
      expect(form.get('client_secret')).toBeNull();
      const idToken = await new SignJWT({ nonce: authorization.searchParams.get('nonce'), email: 'fixture@example.test' })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).setIssuer('https://auth.openai.com').setAudience('oaiapp_test_fixture').setSubject('test-subject').setIssuedAt().setExpirationTime('5m').sign(privateKey);
      return Response.json({ access_token: 'test-access-fixture', refresh_token: 'test-refresh-fixture', id_token: idToken, expires_in: 3600, scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct' });
    }
    throw new Error(`Unexpected test URL: ${url.origin}${url.pathname}`);
  }) as typeof fetch;
  try {
    const task = login(store, { open: false, port: 0, onAuthorization: url => { authorization = new URL(url); announce(); } });
    await announced;
    expect(authorization.searchParams.get('client_id')).toBe('dynamic_agent_client');
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorization.searchParams.get('ext_agent_host_id')).toMatch(/^urn:uuid:/);
    const callback = new URL(authorization.searchParams.get('redirect_uri')!);
    callback.search = new URLSearchParams({ state: 'forged-state', code: 'fixture-code', client_id: 'oaiapp_test_fixture' }).toString();
    expect((await originalFetch(callback)).status).toBe(400); expect(exchanges).toBe(0);
    callback.searchParams.set('state', authorization.searchParams.get('state')!);
    const result = await originalFetch(callback); expect(result.status).toBe(200);
    await result.text();
    const account = await task;
    expect(account.subject).toBe('test-subject'); expect(exchanges).toBe(1);
    expect((await store.read()).registration?.clientId).toBe('oaiapp_test_fixture');
  } finally { globalThis.fetch = originalFetch; await rm(directory, { recursive: true, force: true }); }
}, 20000);

test('canceling one token wait does not hold the turn open or cancel shared renewal', async () => {
  const originalFetch = globalThis.fetch;
  let finish!: (response: Response) => void, requests = 0, updates = 0;
  const renewal = new Promise<Response>(resolve => { finish = resolve; });
  let account: Account = { clientId: 'fixture', subject: 'fixture', issuer: 'https://auth.openai.com', accessToken: 'expired-fixture', refreshToken: 'refresh-fixture', expiresAt: 0, scopes: ['chatgpt.tokens.use.direct'] };
  const store = { read: async () => ({ account }), update: async (change: (value: any) => any) => { updates++; account = (await change({ account })).account; } } as unknown as CredentialStore;
  globalThis.fetch = (async input => {
    const url = String(input);
    if (url.endsWith('openid-configuration')) return Response.json({ issuer: 'https://auth.openai.com', authorization_endpoint: 'https://auth.openai.com/api/accounts/authorize', token_endpoint: 'https://auth.openai.com/api/accounts/oauth/token', jwks_uri: 'https://auth.openai.com/.well-known/jwks.json' });
    requests++; return renewal;
  }) as typeof fetch;
  try {
    const auth = new PlanAuth(store), abort = new AbortController();
    const canceled = auth.token(abort.signal), shared = auth.token();
    const deadline = Date.now() + 1000;
    while (!requests) { if (Date.now() > deadline) throw new Error('Renewal did not start'); await Bun.sleep(1); }
    abort.abort(); await expect(canceled).rejects.toThrow();
    expect(updates).toBe(0);
    finish(Response.json({ access_token: 'renewed-fixture', expires_in: 3600 }));
    expect(await shared).toBe('renewed-fixture'); expect(await auth.token()).toBe('renewed-fixture');
    expect(requests).toBe(1); expect(updates).toBe(1);
  } finally { globalThis.fetch = originalFetch; }
});
