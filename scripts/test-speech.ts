import { t, setLocale } from '../src/locale';
import { configureNetwork } from '../src/network';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { SpeechRuntime } from '../src/speech';
import { LOCAL, loadConfig, selectLocale, log, safeError } from '../src/config';
import { ffmpeg, pcm16ToWav } from '../src/audio';
import { download } from './download';
import { acquireLock } from '../src/platform';

function words(text: string) {
  // Whisper may legitimately write numerals as digits. This fixture uses 23 and 45.
  return text.toLowerCase().replace(/\b23\b/g, config.speechLanguage === 'ru' ? 'двадцать три' : 'twenty three').replace(/\b45\b/g, config.speechLanguage === 'ru' ? 'сорок пять' : 'forty five')
    .replaceAll('ё', 'е').replaceAll('+', '').replace(/[^\p{L}\p{N}\s]/gu, '').trim().split(/\s+/).filter(Boolean);
}
function wer(reference: string, actual: string) {
  const a = words(reference), b = words(actual);
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + Number(a[i - 1] !== b[j - 1]));
    row = next;
  }
  return row[b.length]! / Math.max(1, a.length);
}

const russianFixtures = [
  { id: 'names', text: 'Привет, Алёна! Лёша, ты меня слышишь?' },
  { id: 'conversation', text: 'Слушай, я сейчас зайду. Подожди минутку, у меня микрофон выключен.' },
  { id: 'numbers', text: 'Встречаемся в двадцать три часа сорок пять минут. Нас будет пятеро.' },
  { id: 'stress', text: 'Старинный з+амок стоит на горе, а зам+ок на двери закрыт.' },
];
const release = await acquireLock('speech-check');
const config = await loadConfig();
const localeIndex = process.argv.indexOf('--locale');
if (localeIndex >= 0) {
  const locale = process.argv[localeIndex + 1];
  if (!locale || locale.startsWith('-')) throw new Error(t('Provide a locale after --locale.'));
  Object.assign(config, selectLocale(config, locale));
}
const fixtures = config.speechLanguage === 'ru' ? russianFixtures : [
  { id: 'names', text: 'Hello, Alex. Sam, can you hear me?' },
  { id: 'conversation', text: 'I will join in a moment. My microphone is switched off.' },
  { id: 'numbers', text: 'We are meeting in twenty three minutes. There will be five of us.' },
  { id: 'question', text: 'Can you explain how to check who has an echo?' },
];
const names = config.speechLanguage === 'ru' ? ['Алёна', 'Лёша'] : ['Alex', 'Sam'];
setLocale(config.locale);
configureNetwork(config.networkMode);
if (process.argv.includes('--whisper')) config.sttEngine = 'whisper';
const output = resolve(LOCAL, `speech-check-${config.speechLanguage}`);
await mkdir(output, { recursive: true });
const runtime = new SpeechRuntime(config, error => log(safeError(error)));
const signal = AbortSignal.timeout(10 * 60000);
const rows: Record<string, unknown>[] = [];
try {
  await runtime.start();
  for (const fixture of fixtures) {
    const start = performance.now();
    const wav = await runtime.client.synthesize(fixture.text, signal);
    const ttsMs = performance.now() - start;
    await writeFile(resolve(output, `${fixture.id}.wav`), wav);
    const sttInput = await ffmpeg(wav, ['-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '-f', 'wav'], signal);
    const sttStart = performance.now();
    const actual = await runtime.client.transcribe(sttInput, names, signal);
    const errorRate = wer(fixture.text, actual);
    rows.push({ id: fixture.id, reference: fixture.text, actual, wer: errorRate, ttsMs: Math.round(ttsMs), sttMs: Math.round(performance.now() - sttStart), audioSeconds: +(wav.length / 96000).toFixed(2) });
    log(t("{0}: WER {1}%; {2}", fixture.id, (errorRate * 100).toFixed(1), actual));
  }
  const silence = pcm16ToWav(Buffer.alloc(16000 * 2 * 3), 16000, 1);
  const silenceText = await runtime.client.transcribe(silence, [], signal);
  rows.push({ id: 'silence', actual: silenceText, passed: silenceText === '' });
  if (config.speechLanguage === 'ru' && !process.argv.includes('--synthetic-only')) {
    const human = resolve(output, 'human-ru.wav');
    await download('https://huggingface.co/csukuangfj/sherpa-onnx-nemo-transducer-giga-am-v3-russian-2025-12-16/resolve/main/test_wavs/example.wav?download=true', human, 'd8aaaa18a5098d7c6de0595ae7ac1e64cacd0d4022af3595213bdaf23be77e69');
    const wav = await ffmpeg(Buffer.from(await Bun.file(human).arrayBuffer()), ['-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '-f', 'wav'], signal);
    const start = performance.now();
    const actual = await runtime.client.transcribe(wav, [], signal);
    rows.push({ id: 'human-sample', source: 'https://huggingface.co/csukuangfj/sherpa-onnx-nemo-transducer-giga-am-v3-russian-2025-12-16/blob/main/test_wavs/example.wav', actual, sttMs: Math.round(performance.now() - start), note: 'Independent human sample; no verified reference transcript, so no WER score.' });
    log(t("Human speech sample: {0}", actual));
  }
  const report = { at: new Date().toISOString(), voice: config.voice, sttEngine: config.sttEngine, sttModel: config.sttEngine === 'gigaam' ? 'gigaam-v3-int8' : config.sttModel, rows,
    limitation: 'Synthetic round trips are smoke checks, not evidence of perfect recognition. Listen to the WAVs and test real group speech, noise, and accents.' };
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
  await writeFile(resolve(output, `report-${config.sttEngine}.json`), JSON.stringify(report, null, 2), 'utf8');
  if (silenceText || rows.some(row => typeof row.wer === 'number' && row.wer > 0.3)) throw new Error(t("Speech check found issues. See {0}.", resolve(output, "report.json")));
  log(t("Check complete. Audio samples and report: {0}", output));
} catch (error) { console.error(safeError(error)); process.exitCode = 1; }
finally { await runtime.stop(); await release(); }
