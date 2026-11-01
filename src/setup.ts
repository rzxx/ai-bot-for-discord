import { setupForm, escapeHtml } from './setup-form';
import { t, withLocale, currentLocale, languageOf } from './locale';
import { Config, selectLocale, saveConfig, validateConfig, log } from './config';
import { CredentialStore, openBrowser } from './platform';

const escape = escapeHtml;
function document(body: string) {
  return `<!doctype html><html lang="${languageOf(currentLocale())}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(t("Discord Voice Companion — Setup"))}</title><style>body{font:16px/1.55 system-ui;background:#15191f;color:#eee;max-width:640px;margin:36px auto;padding:0 20px}label{display:block;margin:22px 0}input,select,button{display:block;box-sizing:border-box;font:inherit;width:100%;padding:11px;margin:7px 0;border-radius:7px;border:1px solid #59626f;background:#242b35;color:#fff}button{background:#376bd0;cursor:pointer}input[type=checkbox]{display:inline;width:auto;margin-right:10px}small,p{color:#b8c1cc}a{color:#9abdff}h1{font-size:25px}</style></head><body>${body}</body></html>`;
}

interface SetupOptions {
  open?: boolean;
  port?: number;
  timeoutMs?: number;
  onReady?: (url: string, close: () => void) => void;
  discordHTTP?: (url: string, init: RequestInit) => Promise<Response>;
  persistConfig?: typeof saveConfig;
}

export async function configure(config: Config, store: Pick<CredentialStore, 'read' | 'update'>, options: SetupOptions = {}) {
  const existing = await store.read();
  const key = crypto.randomUUID();
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  // no-referrer makes native browser form POSTs send Origin:null. same-origin keeps
  // the Origin check usable while still withholding the local setup URL from Discord.
  const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'same-origin', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://discord.com; base-uri 'none'; frame-ancestors 'none'" };
  const server = Bun.serve({ hostname: '127.0.0.1', port: options.port ?? 0, maxRequestBodySize: 16000,
    async fetch(request) {
      const url = new URL(request.url);
      const selectedLocale = url.searchParams.get('locale') ?? config.locale;
      const viewConfig = selectedLocale !== config.locale ? selectLocale(config, selectedLocale) : config;
      return withLocale(selectedLocale, async () => {
      if (url.pathname !== `/setup/${key}`) return new Response('Not found', { status: 404 });
      if (request.method === 'POST') {
        if (request.headers.get('origin') !== url.origin) return new Response(document(`<h1>${escape(t("Refresh the setup page"))}</h1><p>${escape(t("Request origin could not be verified. Refresh the form before submitting again."))}</p><p><a href="${escape(url.pathname + url.search)}">${escape(t("Open a fresh form"))}</a></p>`), { status: 403, headers });
        try {
          const data = await request.formData();
          if (data.get('csrf') !== key) return new Response(document(`<h1>${escape(t("Setup page expired"))}</h1><p><a href="${escape(url.pathname + url.search)}">${escape(t("Open a fresh form"))}</a> ${escape(t("and submit again."))}</p>`), { status: 403, headers });
          const guild = String(data.get('guild') ?? '').trim();
          const owner = String(data.get('owner') ?? '').trim();
          const token = String(data.get('token') ?? '').trim();
          if (!/^\d{15,22}$/.test(guild)) throw new Error(t("A numeric Discord server ID is required."));
          if (owner && !/^\d{15,22}$/.test(owner)) throw new Error(t("Invalid controller user ID."));
          if (token && (token.length < 40 || token.length > 300 || /\s/.test(token))) throw new Error(t("Invalid Discord token format."));
          if (!token && !existing.discordToken && !process.env.DISCORD_TOKEN) throw new Error(t("Enter the Discord bot token from Developer Portal."));
          const botResponse = await (options.discordHTTP ?? fetch)('https://discord.com/api/v10/users/@me', { headers: { Authorization: `Bot ${token || existing.discordToken || process.env.DISCORD_TOKEN}` }, signal: AbortSignal.timeout(20000) });
          if (!botResponse.ok) throw new Error(t("Discord rejected the bot token (HTTP {0}).", botResponse.status));
          const bot = await botResponse.json() as { id: string; bot: boolean };
          if (!bot.bot || !/^\d{15,22}$/.test(bot.id)) throw new Error(t("A Discord bot token is required."));
          const updated = validateConfig({ ...viewConfig, locale: String(data.get('locale') ?? selectedLocale), allowedGuildIds: [guild], controllerUserIds: owner ? [owner] : [],
            reportTools: data.get('reports') === 'on', backgroundReports: data.get('backgroundReports') === 'on',
            memberContext: data.get('members') === 'on', presenceContext: data.get('presence') === 'on', chatContext: data.get('chat') === 'on', chatChannelId: String(data.get('chatChannel') ?? '').trim(),
            chatTools: data.get('chatTools') === 'on', chatTimezone: String(data.get('chatTimezone') ?? viewConfig.chatTimezone).trim(),
            speechLanguage: String(data.get('speechLanguage') ?? viewConfig.speechLanguage).trim(), responseLanguage: String(data.get('responseLanguage') ?? viewConfig.responseLanguage).trim(),
            networkMode: String(data.get('networkMode') ?? config.networkMode), additionalInstructions: String(data.get('additionalInstructions') ?? config.additionalInstructions),
            botName: String(data.get('name') ?? config.botName).trim(), voice: String(data.get('voice') ?? viewConfig.voice), model: String(data.get('model') ?? '').trim() });
          await (options.persistConfig ?? saveConfig)(updated);
          if (token) await store.update(value => ({ ...value, discordToken: token }));
          setTimeout(finish, 500);
          const permissions = 3148800 | (updated.chatTools ? 65536 : 0);
          const invite = `https://discord.com/oauth2/authorize?client_id=${bot.id}&permissions=${permissions}&scope=bot%20applications.commands&guild_id=${guild}&disable_guild_select=true`;
          log(t("Install the bot: {0}", invite));
          // 303 changes the form POST into a GET; credentials remain local and are
          // never included in Discord's URL. The form CSP explicitly allows this destination.
          return new Response(document(`<h1>${escape(t("Settings saved"))}</h1><p>${escape(t("Opening the Discord installation page."))}</p><p><a href="${escape(invite)}">${escape(t("Open Discord if you were not redirected"))}</a></p>`), { status: 303, headers: { ...headers, Location: invite } });
        } catch (error) {
          return new Response(document(`<h1>${escape(t("Could not save settings"))}</h1><p>${escape(error instanceof Error ? error.message : t('Error'))}</p><p>${escape(t("Go back and correct the settings."))}</p>`), { status: 400, headers });
        }
      }
      if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
      return new Response(document(setupForm(viewConfig, key, !!existing.discordToken)), { headers });
      });
    },
  });
  const url = `http://127.0.0.1:${server.port}/setup/${key}`;
  log(t("Local setup: {0}", url));
  if (options.open !== false) openBrowser(url);
  const timer = setTimeout(finish, options.timeoutMs ?? 30 * 60000);
  options.onReady?.(url, finish);
  try { await done; } finally { clearTimeout(timer); await server.stop(); }
}
