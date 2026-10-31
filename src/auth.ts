import { t } from './locale';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { Account, CredentialStore, openBrowser } from './platform';
import { log } from './config';
import { withAbort } from './abort';
import { InferenceError } from './inference-error';

const RESOURCE = 'https://api.openai.com/v1';
const SCOPES = ['openid', 'profile', 'email', 'offline_access', 'resource.invoke', 'chatgpt.tokens.use.direct'];
const DISCOVERY = 'https://auth.openai.com/.well-known/openid-configuration';
type Discovery = { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string; revocation_endpoint?: string };
let discoveryCache: Discovery | undefined;

export async function discovery(): Promise<Discovery> {
  if (discoveryCache) return discoveryCache;
  const r = await fetch(DISCOVERY, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(t("OpenAI OIDC: HTTP {0}", r.status));
  const d = await r.json() as Discovery;
  if (d.issuer !== 'https://auth.openai.com') throw new Error(t("Unexpected OpenAI issuer."));
  for (const value of [d.authorization_endpoint, d.token_endpoint, d.jwks_uri]) {
    if (new URL(value).origin !== 'https://auth.openai.com') throw new Error(t("Unexpected OpenAI OIDC endpoint."));
  }
  return discoveryCache = d;
}

const planErrorMessages: Record<string, string> = {
  subscription_sharing_user_not_eligible: 'This account or workspace is not eligible for ChatGPT plan usage in this app.',
  subscription_sharing_usage_limit_exceeded: 'ChatGPT plan usage limit reached. Replies paused. Check ChatGPT settings → Usage; use /resume after the limit resets.',
  subscription_sharing_usage_unavailable: 'OpenAI cannot check the usage allowance right now. Try again later.',
  subscription_sharing_unsupported_capability: 'This capability is unavailable through the ChatGPT plan.',
  subscription_sharing_route_not_supported: 'This route is unavailable through the ChatGPT plan.',
};

export class OpenAIError extends InferenceError {
  constructor(status: number, code: string, message: string, readonly requestId?: string | null) {
    super(status, code, t(planErrorMessages[code] ?? message), status === 401 || status === 403 || status === 429 || code.startsWith('subscription_sharing_'));
  }
  get blocksPlan() { return this.status === 401 || this.status === 403 || this.status === 429 || this.code.startsWith('subscription_sharing_'); }
}

export async function responseError(response: Response): Promise<OpenAIError> {
  let body: any;
  try { body = await response.json(); } catch { body = {}; }
  const code = String(body?.error?.code ?? body?.error ?? `http_${response.status}`);
  // Never include an entire auth response, which can contain tokens.
  const detail = String(body?.error?.message ?? body?.detail ?? `OpenAI: HTTP ${response.status}`).slice(0, 500);
  return new OpenAIError(response.status, code, detail, response.headers.get('x-request-id'));
}

function equal(a: string, b: string) {
  const av = Buffer.from(a), bv = Buffer.from(b);
  return av.length === bv.length && timingSafeEqual(av, bv);
}

export async function login(store: CredentialStore, options: { open?: boolean; port?: number; onAuthorization?: (url: string) => void } = {}): Promise<Account> {
  const d = await discovery();
  const existing = await store.read();
  const registration = existing.account ?? existing.registration;
  const hostId = existing.hostId ?? `urn:uuid:${crypto.randomUUID()}`;
  await store.update(value => ({ ...value, hostId }));
  const state = randomBytes(32).toString('base64url');
  const nonce = randomBytes(32).toString('base64url');
  const verifier = randomBytes(64).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  let consumed = false;
  let resolveAccount!: (account: Account) => void;
  let rejectAccount!: (error: unknown) => void;
  const completed = new Promise<Account>((resolve, reject) => { resolveAccount = resolve; rejectAccount = reject; });
  const server = Bun.serve({
    hostname: '127.0.0.1', port: options.port ?? 1455,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== '/auth/callback') return new Response('Not found', { status: 404 });
      if (request.method !== 'GET' || !equal(url.searchParams.get('state') ?? '', state)) return new Response('Invalid state', { status: 400 });
      if (consumed) return new Response('Already consumed', { status: 409 });
      consumed = true;
      try {
        if (url.searchParams.has('error')) throw new Error(t("Sign-in canceled in the browser."));
        const code = url.searchParams.get('code');
        const returnedClient = url.searchParams.get('client_id');
        const clientId = registration?.clientId ?? returnedClient;
        if (!code || !clientId || clientId === 'dynamic_agent_client') throw new Error(t("Missing authorization code or registered client ID."));
        if (registration && returnedClient && returnedClient !== registration.clientId) throw new Error(t("Client ID changed. Use a separate profile."));
        const response = await fetch(d.token_endpoint, {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: redirectUri, resource: RESOURCE }),
          signal: AbortSignal.timeout(30000),
        });
        if (!response.ok) throw await responseError(response);
        const tokens = await response.json() as Record<string, any>;
        if (typeof tokens.id_token !== 'string' || typeof tokens.access_token !== 'string' || !Number.isFinite(tokens.expires_in)) throw new Error(t("Invalid authorization response."));
        const { payload } = await jwtVerify(tokens.id_token, createRemoteJWKSet(new URL(d.jwks_uri)), { issuer: d.issuer, audience: clientId, clockTolerance: 10 });
        if (payload.nonce !== nonce || !payload.sub) throw new Error(t("ID token does not match the sign-in request."));
        if (registration && payload.sub !== registration.subject) throw new Error(t("Different account selected. Use a separate credential store for another account."));
        if (payload.azp && payload.azp !== clientId || Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== clientId) throw new Error(t("Invalid authorized party in ID token."));
        const scopes = String(tokens.scope ?? '').split(/\s+/).filter(Boolean);
        if (!scopes.includes('chatgpt.tokens.use.direct')) throw new Error(t("ChatGPT plan usage was not authorized. Sign in again and allow plan usage."));
        const account: Account = {
          clientId, subject: payload.sub, issuer: d.issuer,
          email: typeof payload.email === 'string' ? payload.email : undefined,
          accessToken: tokens.access_token, refreshToken: tokens.refresh_token, idToken: tokens.id_token,
          expiresAt: Date.now() + Number(tokens.expires_in) * 1000, scopes,
        };
        await store.update(value => ({ ...value, account, registration: { clientId, subject: account.subject, issuer: account.issuer, email: account.email } }));
        resolveAccount(account);
        return new Response('<!doctype html><meta charset="utf-8">' + t('<title>Signed in</title><h1>Sign-in complete</h1><p>You can close this tab and return to the bot.</p>'), { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'" } });
      } catch (error) {
        rejectAccount(error);
        return new Response(t('Sign-in failed. See the terminal for details.'), { status: 400, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      }
    },
  });
  const redirectUri = `http://127.0.0.1:${server.port}/auth/callback`;
  const url = new URL(d.authorization_endpoint);
  url.search = new URLSearchParams({
    client_id: registration?.clientId ?? 'dynamic_agent_client',
    ext_agent_host_id: hostId, response_type: 'code', redirect_uri: redirectUri,
    scope: SCOPES.join(' '), resource: RESOURCE, state, nonce,
    code_challenge_method: 'S256', code_challenge: challenge,
    ...(!registration ? { agent_name_hint: 'Discord Voice Companion' } : {}),
    ...(existing.account?.idToken ? { id_token_hint: existing.account.idToken } : {}),
  }).toString();
  log(t("Open the browser to sign in with ChatGPT and authorize plan usage."));
  // The URL can contain id_token_hint; do not log it.
  if (options.open !== false) openBrowser(url.toString());
  options.onAuthorization?.(url.toString());
  const timeout = setTimeout(() => rejectAccount(new Error(t("Sign-in timed out. Run bun run login again."))), 10 * 60_000);
  try { return await completed; }
  finally { clearTimeout(timeout); await server.stop(); }
}

export class PlanAuth {
  private refreshing?: Promise<Account>;
  private cached?: Account;
  constructor(readonly store: CredentialStore) {}
  token(signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    return withAbort(this.getToken(), signal);
  }
  private async getToken(): Promise<string> {
    const account = this.cached ?? (await this.store.read()).account;
    if (!account) throw new Error(t("Run bun run login first."));
    if (!account.scopes.includes('chatgpt.tokens.use.direct')) throw new Error(t("ChatGPT plan usage is not authorized for this app."));
    if (account.expiresAt > Date.now() + 90_000) { this.cached = account; return account.accessToken; }
    if (!this.refreshing) this.refreshing = this.refresh(account).finally(() => { this.refreshing = undefined; });
    return (await this.refreshing).accessToken;
  }
  private async refresh(account: Account): Promise<Account> {
    if (!account.refreshToken) throw new Error(t("Sign in again: bun run login."));
    const d = await discovery();
    const response = await fetch(d.token_endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: account.clientId, refresh_token: account.refreshToken, resource: RESOURCE }),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw await responseError(response);
    const tokens = await response.json() as Record<string, any>;
    if (typeof tokens.access_token !== 'string' || !Number.isFinite(tokens.expires_in)) throw new Error(t("Invalid authorization refresh response."));
    const updated: Account = { ...account, accessToken: tokens.access_token, refreshToken: tokens.refresh_token ?? account.refreshToken,
      idToken: tokens.id_token ?? account.idToken, expiresAt: Date.now() + Number(tokens.expires_in) * 1000,
      scopes: tokens.scope ? String(tokens.scope).split(/\s+/) : account.scopes };
    if (!updated.scopes.includes('chatgpt.tokens.use.direct')) throw new Error(t("Plan usage permission was revoked. Sign in again."));
    await this.store.update(value => ({ ...value, account: updated }));
    this.cached = updated;
    return updated;
  }
}

export interface PlanModel { slug: string; display_name: string; visibility?: string; context_window?: number; supported_reasoning_levels?: { effort: string }[] }
export async function listModels(auth: PlanAuth): Promise<PlanModel[]> {
  const response = await fetch(`${RESOURCE}/models`, { headers: { Authorization: `Bearer ${await auth.token()}` }, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw await responseError(response);
  const body = await response.json() as { models?: PlanModel[] };
  if (!Array.isArray(body.models)) throw new Error(t("Unexpected ChatGPT plan model catalog."));
  return body.models.filter(m => m.visibility === 'list' && typeof m.slug === 'string');
}
