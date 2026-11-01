import { t, withLocale } from './locale';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { speechPreset, voicesFor } from './speech-presets';

export const ROOT = resolve(import.meta.dir, '..');
export const LOCAL = resolve(ROOT, '.local');
export const MODELS = resolve(ROOT, 'models');
export const BIN = resolve(LOCAL, 'bin');
export const VOICES = ['aidar', 'baya', 'kseniya', 'xenia', 'eugene'] as const;
export const VOICE_LABELS: Record<string, string> = { aidar: 'Aidar', baya: 'Baya', kseniya: 'Kseniya', xenia: 'Xenia', eugene: 'Eugene' };

export const defaults = {
  botName: 'Companion', model: '', reasoningEffort: 'low', allowedGuildIds: [] as string[], controllerUserIds: [] as string[],
  inferenceAdapter: '', speechAdapter: '', networkMode: 'environment', locale: 'en',
  speechLanguage: 'en', responseLanguage: 'auto', additionalInstructions: '',
  preferredNames: {} as Record<string, string>, pronunciations: {} as Record<string, string>,
  voice: 'en_0', speechPort: 18765, whisperPort: 18766, sttEngine: 'whisper', sttModel: 'large-v3-turbo-q8_0', gigaamThreads: 4,
  whisperThreads: 6, ttsThreads: 2, roomQuietMs: 1100, utteranceSilenceMs: 700,
  earlyEndpointMs: 320, replyStartQuietMs: 220, replyFloorWaitMs: 1400,
  conversationReplyChars: 240, thinkingCues: true, thinkingCueDelayMs: 1100, thinkingCueCooldownMs: 20000,
  modelTransport: 'auto',
  prepareQuietMs: 500,
  liveVad: true,
  maxUtteranceMs: 12000, minSpeechMs: 220, speechRms: 0.006, maxSttQueue: 12,
  maxReplyChars: 650, streamReplies: true, contextMaxTokens: 200000, maxResponseAgeMs: 25000, idleDisconnectMinutes: 3,
  memberContext: false, presenceContext: false, chatContext: false, chatTools: false, chatChannelId: '', chatTimezone: 'UTC', messageTools: true, reminderTools: true, webSearch: true,
  messageCooldownSeconds: 180, mentionCooldownSeconds: 900, searchCooldownSeconds: 30, searchTimeoutMs: 8000,
  reportTools: true, backgroundReports: true,
};
export type Config = typeof defaults;

export function localeSettings(locale: string) {
  const { speechLanguage, responseLanguage, sttEngine, voice } = speechPreset(locale);
  const pronunciations: Record<string, string> = speechLanguage === 'ru' ? { Discord: 'Дискорд', ChatGPT: 'Чат Джи Пи Ти' } : {};
  return { locale, speechLanguage, responseLanguage, sttEngine, voice, pronunciations };
}

export function selectLocale(config: Config, locale: string): Config {
  const previous = localeSettings(config.locale).pronunciations;
  const overrides = Object.fromEntries(Object.entries(config.pronunciations).filter(([word, spoken]) => previous[word] !== spoken));
  const settings = localeSettings(locale);
  return { ...config, ...settings, pronunciations: { ...settings.pronunciations, ...overrides } };
}

export function resolveConfig(settings: Partial<Config>): Config {
  // Existing installations predate locale. Preserve their selected speech stack.
  const locale = settings.locale ?? (settings.speechLanguage === 'ru' || settings.sttEngine === 'gigaam' || VOICES.includes(settings.voice as typeof VOICES[number]) ? 'ru' : 'en');
  return withLocale(locale, () => validateConfig({ ...defaults, ...localeSettings(locale), ...settings }));
}

export async function loadConfig(): Promise<Config> {
  let value: unknown = {};
  try { value = JSON.parse(await readFile(resolve(ROOT, 'config.json'), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  // Retired rolling-window settings must not silently restore cache-breaking pruning.
  const { maxHistoryChars: _, maxHistoryMinutes: __, contextCompactAtTokens, contextKeepRecentTokens: ___, ...settings } = value as Partial<Config> & { maxHistoryChars?: number; maxHistoryMinutes?: number; contextCompactAtTokens?: number; contextKeepRecentTokens?: number };
  return resolveConfig({ ...(contextCompactAtTokens ? { contextMaxTokens: contextCompactAtTokens } : {}), ...settings });
}

export function validateConfig(c: Config): Config {
  for (const key of ['speechPort', 'whisperPort'] as const) {
    if (!Number.isInteger(c[key]) || c[key] < 1024 || c[key] > 65535) throw new Error(t("Invalid {0}", key));
  }
  if (c.speechPort === c.whisperPort) throw new Error(t("STT and TTS ports must differ."));
  for (const key of ['roomQuietMs', 'prepareQuietMs', 'utteranceSilenceMs', 'replyStartQuietMs', 'replyFloorWaitMs', 'conversationReplyChars', 'thinkingCueDelayMs', 'thinkingCueCooldownMs', 'maxUtteranceMs', 'minSpeechMs', 'maxSttQueue', 'maxReplyChars', 'contextMaxTokens', 'maxResponseAgeMs', 'whisperThreads', 'gigaamThreads', 'ttsThreads', 'idleDisconnectMinutes', 'messageCooldownSeconds', 'mentionCooldownSeconds', 'searchCooldownSeconds', 'searchTimeoutMs'] as const) {
    if (!Number.isInteger(c[key]) || c[key] <= 0) throw new Error(t("Invalid {0}", key));
  }
  if (!Number.isInteger(c.earlyEndpointMs) || c.earlyEndpointMs < 0) throw new Error(t("earlyEndpointMs must be a nonnegative integer (0 disables it)."));
  if (c.contextMaxTokens < 1024 || c.contextMaxTokens > 400000) throw new Error(t("contextMaxTokens: 1024 to 400000."));
  if (c.messageCooldownSeconds < 30 || c.mentionCooldownSeconds < 60 || c.searchCooldownSeconds < 10 || c.searchTimeoutMs < 1000 || c.searchTimeoutMs > 15000) throw new Error(t("Tool cooldowns are too short or searchTimeoutMs is outside 1000–15000."));
  if (typeof c.chatChannelId !== 'string' || c.chatChannelId && !/^\d{15,22}$/.test(c.chatChannelId)) throw new Error(t("Invalid chatChannelId."));
  for (const key of ['memberContext', 'presenceContext', 'chatContext', 'chatTools', 'messageTools', 'reminderTools', 'webSearch', 'reportTools', 'backgroundReports'] as const) if (typeof c[key] !== 'boolean') throw new Error(t("{0} must be true or false.", key));
  try {
    if (typeof c.chatTimezone !== 'string' || c.chatTimezone.length > 100 || !c.chatTimezone.trim()) throw new Error();
    new Intl.DateTimeFormat('en', { timeZone: c.chatTimezone });
  } catch { throw new Error(t('Invalid chatTimezone; use an IANA timezone such as UTC or Europe/Moscow.')); }
  if (c.maxUtteranceMs > 30000 || c.minSpeechMs >= c.maxUtteranceMs) throw new Error(t("Invalid utterance length."));
  if (!(c.speechRms > 0 && c.speechRms < 1)) throw new Error(t("speechRms must be between 0 and 1."));
  if (!c.speechAdapter && !voicesFor(c.speechLanguage).includes(c.voice)) throw new Error(t("Unknown voice for the selected speech model."));
  if (typeof c.voice !== 'string' || !c.voice.trim() || c.voice.length > 100) throw new Error(t("Invalid voice."));
  for (const key of ['inferenceAdapter', 'speechAdapter'] as const) if (typeof c[key] !== 'string' || c[key].length > 1000) throw new Error(t("Invalid {0} module path.", key));
  if (!['environment', 'direct'].includes(c.networkMode)) throw new Error(t("networkMode: environment or direct."));
  if (typeof c.locale !== 'string' || !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(c.locale)) throw new Error(t("Invalid locale."));
  if (typeof c.speechLanguage !== 'string' || !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(c.speechLanguage)) throw new Error(t("speechLanguage must be a language tag such as ru or en."));
  if (typeof c.responseLanguage !== 'string' || !c.responseLanguage.trim() || c.responseLanguage.length > 80) throw new Error(t("Invalid responseLanguage; use auto or a language name/tag."));
  if (typeof c.additionalInstructions !== 'string' || c.additionalInstructions.length > 4000) throw new Error(t("additionalInstructions must be at most 4000 characters."));
  if (!c.speechAdapter && !['en', 'ru'].includes(c.speechLanguage)) throw new Error(t("Configure a speechAdapter for this recognition language."));
  if (!c.speechAdapter && c.sttEngine === 'gigaam' && c.speechLanguage !== 'ru') throw new Error(t("The selected recognition model does not support this language."));
  if (!/^[\p{L}\p{N} _-]{1,40}$/u.test(c.botName)) throw new Error(t("Invalid bot name."));
  if (!c.speechAdapter && !['large-v3-turbo-q8_0', 'large-v3-turbo-q5_0', 'small'].includes(c.sttModel)) throw new Error(t("Unknown bundled STT model."));
  if (!c.speechAdapter && !['gigaam', 'whisper'].includes(c.sttEngine)) throw new Error(t("sttEngine: gigaam or whisper."));
  for (const ids of [c.allowedGuildIds, c.controllerUserIds]) {
    if (!Array.isArray(ids) || ids.some(id => !/^\d{15,22}$/.test(id))) throw new Error(t("Invalid Discord IDs."));
  }
  for (const map of [c.preferredNames, c.pronunciations]) {
    if (!map || typeof map !== 'object' || Object.values(map).some(v => typeof v !== 'string' || v.length > 100)) throw new Error(t("Invalid name/pronunciation dictionary."));
  }
  if (typeof c.model !== 'string') throw new Error(t("Invalid inference model."));
  if (!['auto', 'http', 'websocket'].includes(c.modelTransport)) throw new Error(t("modelTransport: auto, http or websocket."));
  if (typeof c.streamReplies !== 'boolean') throw new Error(t("streamReplies must be true or false."));
  if (typeof c.thinkingCues !== 'boolean') throw new Error(t("thinkingCues must be true or false."));
  if (typeof c.liveVad !== 'boolean') throw new Error(t("liveVad must be true or false."));
  if (!['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(c.reasoningEffort)) throw new Error(t("Invalid reasoningEffort."));
  return c;
}

let saveQueue: Promise<unknown> = Promise.resolve();
export function saveConfig(config: Config): Promise<void> {
  validateConfig(config);
  const text = `${JSON.stringify(config, null, 2)}\n`;
  const job = saveQueue.then(async () => {
  const path = resolve(ROOT, 'config.json');
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  try { await writeFile(temp, text, 'utf8'); await rename(temp, path); }
  finally { await rm(temp, { force: true }); }
  });
  saveQueue = job.catch(() => {});
  return job;
}

export function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/(?:sk-[a-zA-Z0-9_-]{12,}|eyJ[a-zA-Z0-9_.-]{30,})/g, '[redacted]')
    .slice(0, 900);
}

export function log(message: string) { console.log(`[${new Date().toISOString()}] ${message}`); }
