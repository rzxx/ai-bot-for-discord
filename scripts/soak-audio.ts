import { t, setLocale } from '../src/locale';
import { configureNetwork } from '../src/network';
import { Worker } from 'node:worker_threads';
import { createSocket } from 'node:dgram';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AudioReceiveStream, EndBehaviorType, VoiceConnectionStatus } from '@discordjs/voice';
import { DiscordPlayer } from '../src/playback';
import { LiveOpusDecoder } from '../src/live-decoder';
import { UtteranceGate, encodeDiscordOpus, toDiscordPCM, toSTTWav, PCM_FRAME_BYTES } from '../src/audio';
import { SpeechRuntime } from '../src/speech';
import { loadConfig, LOCAL, log, safeError } from '../src/config';
import { acquireLock } from '../src/platform';
import { TaskQueue } from '../src/queue';
import { LiveVad } from '../src/live-vad';

const config = { ...await loadConfig(), speechPort: 18877, whisperPort: 18878 };
setLocale(config.locale);
configureNetwork(config.networkMode);
const seconds = Number(process.argv[2] ?? 60), speakers = Number(process.argv[3] ?? 8);
if (!Number.isInteger(seconds) || seconds < 30 || seconds > 90 || !Number.isInteger(speakers) || speakers < 1 || speakers > 16) throw new Error(t("Usage: bun run test:audio [30..90 seconds] [1..16 speakers]"));
const release = await acquireLock('audio-soak');
const failures: string[] = [];
const failure = (stage: string, error: unknown) => {
  const detail = `${stage}: ${error instanceof Error ? error.stack : String(error)}`;
  failures.push(detail); console.error(detail);
};
const runtime = new SpeechRuntime(config, error => failure('speech worker', error));
const player = new DiscordPlayer();
const socket = createSocket('udp4');
let worker: Worker | undefined;
let feedTimer: ReturnType<typeof setInterval> | undefined;
const sources: AudioReceiveStream[] = [], decoders: LiveOpusDecoder[] = [], gates: UtteranceGate[] = [];
const detectors: LiveVad[] = [];
const histogram = monitorEventLoopDelay({ resolution: 5 });
const queue = new TaskQueue(config.maxSttQueue);
const sttTasks: Promise<unknown>[] = [];
const encodeTasks: Promise<unknown>[] = [];
const rss: number[] = [];
const signal = AbortSignal.timeout((seconds + 90) * 1000);
let inputPackets = 0, peakCaptureMs = 0, peakSttQueue = 0, maxSttWaitMs = 0, maxInputDeliveryMs = 0;
let nonemptyTranscripts = 0, inputSequenceGaps = 0;
const lastInputSequence = Array(speakers).fill(-1) as number[];
let sendQueuePeak = 0, sent = 0, pendingPacket: Buffer | undefined;
try {
  await runtime.start();
  const wav = await runtime.client.synthesize(config.speechLanguage === 'ru' ? 'Слушай, я сейчас зайду. Подожди минутку, у меня микрофон выключен.' : 'I will join in a moment. Please wait, my microphone is switched off.', signal);
  const samplePCM = await toDiscordPCM(wav, signal);
  const samplePackets = await encodeDiscordOpus(samplePCM, signal);
  const pcm = Buffer.alloc(seconds * 50 * PCM_FRAME_BYTES);
  for (let offset = 0; offset < pcm.length; offset += samplePCM.length) samplePCM.copy(pcm, offset, 0, Math.min(samplePCM.length, pcm.length - offset));
  for (let id = 0; id < speakers; id++) {
    const source = new AudioReceiveStream({ end: { behavior: EndBehaviorType.Manual }, highWaterMark: 4 });
    const gate = new UtteranceGate({ silenceMs: config.utteranceSilenceMs, minSpeechMs: config.minSpeechMs, maxMs: config.maxUtteranceMs, rms: config.speechRms }, u => {
      const queuedAt = performance.now();
      sttTasks.push(queue.submit(async () => {
        maxSttWaitMs = Math.max(maxSttWaitMs, performance.now() - queuedAt);
        const text = await runtime.client.transcribe(await toSTTWav(u.pcm, signal), config.speechLanguage === 'ru' ? ['Алёна', 'Лёша'] : ['Alex', 'Sam'], signal);
        if (text.trim()) nonemptyTranscripts++;
      }).catch(error => failure(`STT speaker ${id}`, error)));
      peakSttQueue = Math.max(peakSttQueue, queue.length);
    }, () => {});
    if (!runtime.client.vad) throw new Error(t("Live VAD was not initialized"));
    const detector = new LiveVad(runtime.client.vad.open(), (chunk, at, speech) => { gate.push(chunk, at, speech); peakCaptureMs = Math.max(peakCaptureMs, gate.bufferedMs); }, () => gate.discard());
    const decoder = new LiveOpusDecoder(source, (chunk, at) => detector.push(chunk, at), error => failure(`decode speaker ${id}`, error), () => { detector.discard(); gate.discard(); });
    detectors.push(detector);
    sources.push(source); gates.push(gate); decoders.push(decoder);
  }
  socket.on('message', message => {
    inputPackets++; maxInputDeliveryMs = Math.max(maxInputDeliveryMs, Date.now() - message.readDoubleLE(5));
    const id = message[0]!, sequence = message.readUInt32LE(1);
    if (sequence !== lastInputSequence[id]! + 1) inputSequenceGaps++;
    lastInputSequence[id] = sequence;
    sources[id]!.push(message.subarray(13));
  });
  await new Promise<void>(resolveReady => socket.bind(0, '127.0.0.1', resolveReady));
  worker = new Worker(new URL('./audio-producer.ts', import.meta.url), { workerData: { inputPort: (socket.address() as { port: number }).port, speakers, frames: seconds * 50, packets: samplePackets } });
  const outputPort = await new Promise<number>((resolveReady, reject) => {
    worker!.on('message', message => { if (message.type === 'ready') resolveReady(message.outputPort); });
    worker!.once('error', reject);
  });
  let resolveReport!: (value: any) => void;
  const outputReport = new Promise<any>(r => { resolveReport = r; });
  worker.on('message', message => {
    if (message.type === 'report') resolveReport(message);
    if (message.type === 'inputs-finished') setTimeout(() => { for (const gate of gates) gate.flush(); }, 100);
  });
  // Exercise the actual @discordjs/voice scheduler, substituting only a local UDP
  // endpoint for Discord's gateway, encryption and SFU. No account/token is used.
  const fakeConnection = {
    state: { status: VoiceConnectionStatus.Ready },
    prepareAudioPacket(packet: Buffer) { pendingPacket = packet; },
    dispatchAudio() {
      if (!pendingPacket) return;
      const message = Buffer.allocUnsafe(4 + pendingPacket.length);
      message.writeUInt32LE(sent++, 0); pendingPacket.copy(message, 4); pendingPacket = undefined;
      socket.send(message, outputPort, '127.0.0.1'); sendQueuePeak = Math.max(sendQueuePeak, socket.getSendQueueCount());
    },
    setSpeaking() {}, onSubscriptionRemoved() {},
  };
  const subscription = Reflect.get(player.audio, 'subscribe').call(player.audio, fakeConnection);
  histogram.enable();
  const began = performance.now();
  let lastProgress = 0, backgroundEncodes = 0;
  worker.postMessage('start');
  feedTimer = setInterval(() => {
    rss.push(process.memoryUsage().rss);
    const elapsed = performance.now() - began;
    if (elapsed >= (backgroundEncodes + 1) * 20000 && backgroundEncodes < 2) {
      backgroundEncodes++;
      encodeTasks.push(encodeDiscordOpus(pcm, signal).catch(error => failure('background encode', error)));
    }
    if (elapsed - lastProgress >= 10000) { lastProgress = elapsed; log(t("{0} s: incoming packets {1}, queued STT {2}, dropped {3}.", Math.floor(elapsed / 1000), inputPackets, queue.length, decoders.reduce((n, d) => n + d.metrics.dropped, 0))); }
  }, 1000);
  const playback = await player.play(pcm, signal);
  await Bun.sleep(250);
  for (const gate of gates) gate.flush();
  clearInterval(feedTimer);
  worker.postMessage('stop');
  const output = await Promise.race([outputReport, Bun.sleep(5000).then(() => { throw new Error(t("UDP worker report timed out")); })]);
  histogram.disable();
  await Promise.all([...sttTasks, ...encodeTasks]);
  subscription.unsubscribe();
  const dropped = decoders.reduce((n, d) => n + d.metrics.dropped, 0);
  const report = {
    at: new Date().toISOString(), seconds, speakers, inputPackets, inputSequenceGaps, expectedInputPackets: seconds * 50 * speakers,
    decodedPackets: decoders.reduce((n, d) => n + d.metrics.decoded, 0), droppedPackets: dropped,
    maxReceiveQueuePackets: Math.max(...decoders.map(d => d.metrics.peakQueuedPackets)),
    maxReceiveQueueAgeMs: Math.max(...decoders.map(d => d.metrics.maxQueueAgeMs)), maxInputDeliveryMs,
    peakCaptureMs, sttJobs: sttTasks.length, nonemptyTranscripts, peakSttQueue, maxSttWaitMs,
    playback, playbackMetrics: player.metrics, output, sendQueuePeak,
    vad: { dropped: detectors.reduce((n, d) => n + d.metrics.dropped, 0), failures: detectors.reduce((n, d) => n + d.metrics.failures, 0), maxInferenceMs: Math.max(...detectors.map(d => d.metrics.maxInferenceMs)), maxBufferedMs: Math.max(...detectors.map(d => d.metrics.maxBufferedMs)) },
    eventLoopP99Ms: histogram.percentile(99) / 1e6, eventLoopMaxMs: histogram.max / 1e6,
    rssStartMiB: Math.round((rss[0] ?? 0) / 1048576), rssEndMiB: Math.round((rss.at(-1) ?? 0) / 1048576), rssPeakMiB: Math.round(Math.max(...rss) / 1048576),
    backgroundEncodes, failures,
    scope: 'Real codecs, local STT/TTS, UDP and discord.js pacing. Discord network, DAVE and human microphones are not part of this test.',
  };
  if (!playback.completed || dropped || report.vad.dropped || report.vad.failures || inputSequenceGaps || inputPackets !== report.expectedInputPackets || report.decodedPackets !== inputPackets || !sttTasks.length || nonemptyTranscripts !== sttTasks.length || output.sequenceGaps || output.maxOutputGapMs > 100 || player.metrics.maxBufferedPackets > 4 || peakCaptureMs > config.maxUtteranceMs || failures.length) process.exitCode = 1;
  const path = resolve(LOCAL, 'audio-reliability.json'); await mkdir(LOCAL, { recursive: true });
  await writeFile(path, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  log(t("Report: {0}", path));
} catch (error) { console.error(safeError(error)); process.exitCode = 1; }
finally {
  clearInterval(feedTimer); histogram.disable(); player.stop();
  for (const detector of detectors) detector.close();
  for (const decoder of decoders) decoder.destroy(); for (const gate of gates) gate.close(false); for (const source of sources) source.destroy();
  try { socket.close(); } catch {}
  await worker?.terminate(); await runtime.stop(); await release();
}
