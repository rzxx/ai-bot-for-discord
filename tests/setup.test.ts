import { test, expect } from 'bun:test';
import { configure } from '../src/setup';
import { defaults, type Config } from '../src/config';
import type { Credentials } from '../src/platform';

// This credential is accepted only by the stub below, never sent to Discord.
const fixtureToken = `test-fixture-${'x'.repeat(50)}`;
const guildId = '111111111111111111';
const applicationId = '222222222222222222';

async function withSetup(run: (fixture: {
  url: string; key: string; submit: (change?: Record<string, string>, origin?: string) => Promise<Response>;
  credentials: () => Credentials; saved: () => Config | undefined; calls: () => number;
}) => Promise<void>, discordStatus = 200) {
  let value: Credentials = {}, saved: Config | undefined, calls = 0;
  let announce!: (url: string) => void, close!: () => void;
  const ready = new Promise<string>(resolve => { announce = resolve; });
  const task = configure({ ...defaults }, {
    read: async () => structuredClone(value),
    update: async change => { value = await change(structuredClone(value)); },
  }, {
    open: false, timeoutMs: 10000,
    onReady: (url, done) => { close = done; announce(url); },
    persistConfig: async config => { saved = structuredClone(config); },
    discordHTTP: async (url, init) => {
      expect(url).toBe('https://discord.com/api/v10/users/@me');
      expect(new Headers(init.headers).get('Authorization')).toBe(`Bot ${fixtureToken}`);
      calls++;
      return Response.json(discordStatus === 200 ? { id: applicationId, bot: true } : {}, { status: discordStatus });
    },
  });
  try {
    const url = await ready;
    const key = new URL(url).pathname.split('/').at(-1)!;
    await run({ url, key,
      credentials: () => value, saved: () => saved, calls: () => calls,
      submit: (change = {}, origin = new URL(url).origin) => fetch(`${url}${change.locale ? `?locale=${encodeURIComponent(change.locale)}` : ''}`, {
        method: 'POST', redirect: 'manual', headers: { Origin: origin },
        body: new URLSearchParams({ csrf: key, guild: guildId, owner: '', token: fixtureToken, name: 'Лёва', voice: defaults.voice, model: 'gpt-6.1-sol', reports: 'on', backgroundReports: 'on', ...change }),
      }),
    });
  } finally { close?.(); await task; }
}

test('browser-compatible setup policy preserves Origin and permits the Discord redirect', async () => {
  await withSetup(async f => {
    const page = await fetch(f.url);
    expect(page.headers.get('Referrer-Policy')).toBe('same-origin');
    expect(page.headers.get('Content-Security-Policy')).toContain("form-action 'self' https://discord.com");
    expect(await page.text()).toContain('Save and open Discord');
    const response = await f.submit();
    expect(response.status).toBe(303);
    const target = new URL(response.headers.get('Location')!);
    expect(target.origin).toBe('https://discord.com');
    expect(target.pathname).toBe('/oauth2/authorize');
    expect(target.searchParams.get('client_id')).toBe(applicationId);
    expect(target.searchParams.get('guild_id')).toBe(guildId);
    expect(target.searchParams.get('scope')).toBe('bot applications.commands');
    expect(target.toString()).not.toContain(fixtureToken);
    expect(await response.text()).not.toContain(fixtureToken);
    expect(f.credentials().discordToken).toBe(fixtureToken);
    expect(f.saved()!.allowedGuildIds).toEqual([guildId]);
    expect(f.calls()).toBe(1);
  });
});

test('forged, null-Origin and stale setup requests cannot save credentials', async () => {
  await withSetup(async f => {
    for (const origin of ['null', 'https://unrelated.example']) {
      const response = await f.submit({}, origin);
      expect(response.status).toBe(403);
      expect(await response.text()).toContain('Refresh');
    }
    const stale = await f.submit({ csrf: 'expired-page' });
    expect(stale.status).toBe(403); expect(await stale.text()).toContain('expired');
    expect(f.calls()).toBe(0); expect(f.saved()).toBeUndefined(); expect(f.credentials().discordToken).toBeUndefined();
  });
});

test('a rejected Discord token remains local and does not redirect or save', async () => {
  await withSetup(async f => {
    const response = await f.submit();
    expect(response.status).toBe(400); expect(response.headers.get('Location')).toBeNull();
    const body = await response.text();
    expect(body).toContain('HTTP 401'); expect(body).not.toContain(fixtureToken);
    expect(f.saved()).toBeUndefined(); expect(f.credentials().discordToken).toBeUndefined();
  }, 401);
});

test('optional live context and its one text destination are explicitly configured', async () => {
  await withSetup(async f => {
    const response = await f.submit({ members: 'on', presence: 'on', chat: 'on', chatChannel: applicationId });
    expect(response.status).toBe(303);
    expect(f.saved()).toMatchObject({ memberContext: true, presenceContext: true, chatContext: true, chatChannelId: applicationId });
  });
  await withSetup(async f => {
    const response = await f.submit({ chatChannel: 'not-a-channel-id' });
    expect(response.status).toBe(400); expect(f.saved()).toBeUndefined();
  });
});

test('on-demand retrieval is independent of live context and requests history permissions on install', async () => {
  await withSetup(async f => {
    const response = await f.submit({ chatTools: 'on', chatTimezone: 'Europe/Moscow' });
    expect(response.status).toBe(303);
    expect(f.saved()).toMatchObject({ chatTools: true, chatContext: false, chatTimezone: 'Europe/Moscow' });
    const permissions = BigInt(new URL(response.headers.get('Location')!).searchParams.get('permissions')!);
    expect(permissions & 65536n).toBe(65536n);
  });
  await withSetup(async f => {
    expect((await f.submit({ chatTimezone: 'Not/A_Timezone' })).status).toBe(400);
    expect(f.saved()).toBeUndefined();
  });
});

test('language, conversation preferences and proxy mode persist through the local setup form', async () => {
  await withSetup(async f => {
    const response = await f.submit({ speechLanguage: 'en', responseLanguage: 'auto', networkMode: 'direct', additionalInstructions: 'Keep replies brief.' });
    expect(response.status).toBe(303);
    expect(f.saved()).toMatchObject({ speechLanguage: 'en', responseLanguage: 'auto', networkMode: 'direct', additionalInstructions: 'Keep replies brief.' });
  });
  await withSetup(async f => {
    const response = await f.submit({ speechLanguage: 'de' });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('Configure a speechAdapter');
    expect(f.saved()).toBeUndefined(); expect(f.credentials().discordToken).toBeUndefined();
  });
});

test('selecting Russian localizes setup and persists matching speech defaults without affecting English requests', async () => {
  await withSetup(async f => {
    const russianPage = await (await fetch(`${f.url}?locale=ru`)).text();
    expect(russianPage).toContain('lang="ru"');
    expect(russianPage).toContain('Сохранить и открыть Discord');
    expect(russianPage).toContain('value="eugene" selected');
    const rejected = await f.submit({ locale: 'ru', guild: 'invalid', voice: 'eugene' });
    expect(rejected.status).toBe(400);
    expect(await rejected.text()).toContain('Нужен ID сервера');
    const englishPage = await (await fetch(`${f.url}?locale=en`)).text();
    expect(englishPage).toContain('lang="en"');
    expect(englishPage).toContain('Save and open Discord');
    const saved = await f.submit({ locale: 'ru', voice: 'eugene' });
    expect(saved.status).toBe(303);
    expect(await saved.text()).toContain('Настройки сохранены');
    expect(f.saved()).toMatchObject({ locale: 'ru', speechLanguage: 'ru', sttEngine: 'gigaam', voice: 'eugene' });
  });
});

test('local findings and additional background inference are visible and independently configurable', async () => {
  await withSetup(async f => {
    const page = await (await fetch(f.url)).text();
    expect(page).toContain('name="reports" checked');
    expect(page).toContain('name="backgroundReports" checked');
    expect(page).toContain('without extra model calls');
    expect((await f.submit({ backgroundReports: '' })).status).toBe(303);
    expect(f.saved()).toMatchObject({ reportTools: true, backgroundReports: false });
  });
  await withSetup(async f => {
    expect((await f.submit({ reports: '', backgroundReports: '' })).status).toBe(303);
    expect(f.saved()).toMatchObject({ reportTools: false, backgroundReports: false });
  });
});
