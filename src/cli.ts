import { t, setLocale } from './locale';
import { resolve } from 'node:path';
import { generateDependencyReport } from '@discordjs/voice';
import { Decoder } from '@evan/opus';
import { loadConfig, saveConfig, selectLocale, MODELS, log, safeError } from './config';
import { acquireLock, CredentialStore, run } from './platform';
import { createInferenceProvider, createSpeechAdapter } from './providers';
import { speechPreset } from './speech-presets';
import { configureNetwork } from './network';
import { DiscordBot } from './discord';
import { configure } from './setup';
import { enableLatencyFile, closeLatencyFile, latency } from './telemetry';
import { Reporting } from './reporting';
import { encodeDiscordOpus } from './audio';
import type { Brain } from './llm';

const localeIndex = process.argv.indexOf('--locale');
const selectedLocale = localeIndex >= 0 ? process.argv[localeIndex + 1] : undefined;
if (localeIndex >= 0) {
  if (!selectedLocale || selectedLocale.startsWith('-')) throw new Error('Provide a locale after --locale.');
  process.argv.splice(localeIndex, 2);
}
const command = process.argv[2] ?? 'help';
const config = await loadConfig();
if (selectedLocale) Object.assign(config, selectLocale(config, selectedLocale));
setLocale(config.locale);
configureNetwork(config.networkMode);
const store = new CredentialStore();
let cleanup: (() => Promise<void>) | undefined;
let stopping = false;
async function shutdown() {
  if (stopping) return; stopping = true;
  await cleanup?.(); process.exit(0);
}
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });

try {
  if (command === 'help') {
    console.log(t("bun run setup:speech | configure | login | models | doctor | speech | start\nbun src/cli.ts chat \"Hello\" — test an inference reply\nbun src/cli.ts logout — disconnect the inference account"));
  } else if (command === 'doctor') {
    console.log(generateDependencyReport());
    console.log(t("The dependency report describes discord.js converters. This app uses @evan/opus for receive/send, with encoding in a persistent worker."));
    const opusDecoder = new Decoder({ sample_rate: 48000, channels: 2 });
    const encoded = await encodeDiscordOpus(Buffer.alloc(3840), AbortSignal.timeout(5000));
    const credentials = await store.read();
    const checks = {
      opusDecode: opusDecoder.decode(Buffer.from([0xf8, 0xff, 0xfe])).length === 3840,
      opusEncode: encoded.length > 0 && encoded.every(packet => opusDecoder.decode(packet).length === 3840),
      discordToken: !!(process.env.DISCORD_TOKEN || credentials.discordToken),
      chatGPT: !!credentials.account, chatGPTPlanScope: !!credentials.account?.scopes.includes('chatgpt.tokens.use.direct'),
      inferenceAdapter: config.inferenceAdapter || 'chatgpt', speechAdapter: config.speechAdapter || 'silero', networkMode: config.networkMode, locale: config.locale,
      speechLanguage: config.speechLanguage, responseLanguage: config.responseLanguage,
      allowedGuilds: config.allowedGuildIds.length, model: config.model || t('(selected at startup)'),
      sttEngine: config.sttEngine, sttModel: config.sttEngine === 'gigaam' ? 'gigaam-v3-int8' : config.sttModel,
      sttDownloaded: await Bun.file(resolve(MODELS, config.sttEngine === 'gigaam' ? 'gigaam-v3/encoder.int8.onnx' : `ggml-${config.sttModel}.bin`)).exists(),
      ttsDownloaded: await Bun.file(resolve(MODELS, speechPreset(config.speechLanguage).ttsModel)).exists(),
    };
    console.log(JSON.stringify(checks, null, 2));
  } else {
    const release = await acquireLock();
    cleanup = release;
    try {
      if (selectedLocale && command !== 'configure') await saveConfig(config);
      if (command === 'configure') await configure(config, store);
      else if (command === 'login') {
        const provider = await createInferenceProvider(config, store);
        if (!provider.login) throw new Error(t("This provider does not offer interactive login; configure its credentials locally."));
        await provider.login();
        const models = await provider.models();
        if (!models.length) throw new Error(t("No models are available to this account."));
        if (!config.model) { config.model = models[0]!.slug; await saveConfig(config); }
        log(t("Signed in. Selected model: {0}. Test: bun src/cli.ts chat \"Hello\"", config.model));
      } else if (command === 'models') {
        const provider = await createInferenceProvider(config, store);
        const models = await provider.models();
        for (const model of models) console.log(`${model.slug === config.model ? '*' : ' '} ${model.slug} — ${model.display_name}`);
        const select = process.argv[3];
        if (select) {
          if (!models.some(m => m.slug === select)) throw new Error(t("Model is unavailable to this account."));
          config.model = select; await saveConfig(config); log(t("Selected {0}.", select));
        }
      } else if (command === 'logout') {
        const provider = await createInferenceProvider(config, store);
        if (!provider.logout) throw new Error(t("This provider does not offer logout; use its credential management."));
        await provider.logout(); log(t("Inference account disconnected."));
      } else if (command === 'chat') {
        if (!config.model) throw new Error(t("Select a model first: bun run models <slug>."));
        const provider = await createInferenceProvider(config, store);
        const brain = provider.createBrain();
        const sessionId = crypto.randomUUID();
        try {
          const name = t('User');
          const text = process.argv.slice(3).join(' ') || t('Hello! Can you hear me?');
          const result = await brain.reply({ sessionId, botName: config.botName, now: Date.now(), members: [{ id: 'local', name }], events: [{ id: 1, at: Date.now(), kind: 'speech', userId: 'local', name, text }] }, new AbortController().signal);
          console.log(result.speak ? result.text : t('(chose silence)'));
        } finally { brain.release?.(sessionId); }
      } else if (command === 'speech' || command === 'start') {
        let startBrain: Brain | undefined;
        if (command === 'start') {
          const provider = await createInferenceProvider(config, store);
          const models = await provider.models();
          if (!models.length) throw new Error(t("No inference models are available."));
          if (!config.model) { config.model = models[0]!.slug; await saveConfig(config); }
          if (!models.some(m => m.slug === config.model)) throw new Error(t("Selected model unavailable. Run bun run models."));
          const chosen = models.find(m => m.slug === config.model)!;
          if (chosen.context_window && config.contextMaxTokens > chosen.context_window * 0.8) throw new Error(t("contextMaxTokens must leave at least 20% of the selected model window free. Reduce it in config.json."));
          if (chosen.supported_reasoning_levels?.length && !chosen.supported_reasoning_levels.some(v => v.effort === config.reasoningEffort)) throw new Error(t("Selected reasoningEffort is unavailable for this account/model. Edit config.json."));
          startBrain = provider.createBrain();
        }
        let bot: DiscordBot | undefined;
        const speech = await createSpeechAdapter(config, error => { log(safeError(error)); bot?.pauseAll(t('A speech service stopped. Replies paused. Restart the bot.')); });
        cleanup = async () => { await bot?.stop(); await speech.stop(); await closeLatencyFile(); await release(); };
        await speech.start();
        if (startBrain) {
          const credentials = await store.read(); const token = process.env.DISCORD_TOKEN ?? credentials.discordToken;
          if (!token) throw new Error(t("Missing Discord token. Run bun run configure."));
          enableLatencyFile({ diagnostic: process.argv.includes('--diagnostic') });
          const brain = startBrain;
          const reporting = config.reportTools ? new Reporting({
            generate: config.backgroundReports && brain.report ? (seed, signal) => brain.report!(seed, signal) : undefined,
            observe: status => latency({ session: 'reporting', stage: 'reporting', status }),
          }) : undefined;
          bot = new DiscordBot(config, brain, speech.client, reporting);
          await bot.start(token);
        } else log(t("Speech services running. Press Ctrl+C to stop."));
        await new Promise<void>(() => {});
      } else throw new Error(t("Unknown command: {0}", command));
    } finally { await cleanup?.(); }
  }
} catch (error) { console.error(safeError(error)); process.exitCode = 1; }
