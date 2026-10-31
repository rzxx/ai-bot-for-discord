import { t, setLocale } from '../src/locale';
import { configureNetwork } from '../src/network';
import { resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { loadConfig, LOCAL, log, safeError } from '../src/config';
import { acquireLock, CredentialStore } from '../src/platform';
import { PlanAuth } from '../src/auth';
import { PlusBrain } from '../src/llm';
import { SpeechRuntime } from '../src/speech';
import { ffmpeg, toDiscordPCM, encodeDiscordOpus } from '../src/audio';

const release = await acquireLock('speech-check');
const config = await loadConfig();
setLocale(config.locale);
configureNetwork(config.networkMode);
const speech = new SpeechRuntime(config, error => log(safeError(error)));
const signal = AbortSignal.timeout(120000);
const brain = new PlusBrain(new PlanAuth(new CredentialStore()), config);
const sessionId = crypto.randomUUID();
try {
  await speech.start();
  const question = config.speechLanguage === 'ru' ? `Привет, ${config.botName}! Поздоровайся с Алёной и Лёшей. Скажи, что ты готов к беседе.` : `Hello, ${config.botName}. Say hello to Alex and Sam and tell them you are ready to chat.`;
  const names = config.speechLanguage === 'ru' ? ['Алёна', 'Лёша'] : ['Alex', 'Sam'];
  const input = await speech.client.synthesize(question, signal);
  const mono = await ffmpeg(input, ['-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '-f', 'wav'], signal);
  const started = performance.now();
  const transcript = await speech.client.transcribe(mono, names, signal);
  if (!transcript) throw new Error(t("Could not recognize the test utterance."));
  const sttMs = performance.now() - started;
  const brainStart = performance.now();
  const reply = await brain.reply({ sessionId, botName: config.botName, now: Date.now(), members: [{ id: 'fixture-1', name: names[0]! }, { id: 'fixture-2', name: names[1]! }], events: [{ id: 1, at: Date.now(), kind: 'speech', userId: 'fixture-1', name: names[0]!, text: transcript }] }, signal);
  const brainMs = performance.now() - brainStart;
  if (!reply.speak) throw new Error(t("Model did not answer the test utterance."));
  const ttsStart = performance.now();
  const wav = await speech.client.synthesize(reply.text, signal);
  const ttsMs = performance.now() - ttsStart;
  const pcm = await toDiscordPCM(wav, signal);
  const opusPackets = (await encodeDiscordOpus(pcm, signal)).length;
  if (!opusPackets) throw new Error(t("No Discord audio was encoded."));
  const directory = resolve(LOCAL, `speech-check-${config.speechLanguage}`); await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, 'reply.wav'), wav);
  const report = { at: new Date().toISOString(), sttEngine: config.sttEngine, model: config.model, voice: config.voice,
    input: question, transcript, reply: reply.text, sttMs: Math.round(sttMs), brainMs: Math.round(brainMs), ttsMs: Math.round(ttsMs), opusPackets,
    liveDiscordTransport: false };
  await writeFile(resolve(directory, 'turn-report.json'), JSON.stringify(report, null, 2));
  log(t("STT: {0} ms; inference: {1} ms; TTS: {2} ms; Opus packets: {3}.", report.sttMs, report.brainMs, report.ttsMs, opusPackets));
  log(t("Reply: {0}", reply.text));
  log(t("Audio: {0}", resolve(directory, 'reply.wav')));
} catch (error) { console.error(safeError(error)); process.exitCode = 1; }
finally { brain.release(sessionId); await speech.stop(); await release(); }
