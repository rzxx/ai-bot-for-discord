import { t, setLocale } from '../src/locale';
import { configureNetwork } from '../src/network';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { VoiceConnectionStatus } from '@discordjs/voice';
import { loadConfig, localeSettings, LOCAL } from '../src/config';
import { SpeechRuntime } from '../src/speech';
import { RoomController } from '../src/room';
import { DiscordPlayer } from '../src/playback';
import { TaskQueue } from '../src/queue';
import { UtteranceGate, toDiscordPCM, PCM_FRAME_BYTES } from '../src/audio';
import type { LatencyRecord } from '../src/telemetry';
import { LiveVad } from '../src/live-vad';

// Real local STT/TTS and Discord scheduler; synthetic speech and a fixed local
// brain. No Discord login, ChatGPT request, credentials or config writes.
const config = { ...await loadConfig(), ...localeSettings('ru'), botName: 'Лёва', speechPort: 18875, whisperPort: 18876, sttEngine: 'gigaam', thinkingCues: false };
setLocale(config.locale);
configureNetwork(config.networkMode);
let failure: Error | undefined;
const runtime = new SpeechRuntime(config, error => { failure = error; });
const signal = AbortSignal.timeout(90000);
const results: Record<string, unknown>[] = [];

try {
  await runtime.start();
  for (const fixture of [
    { name: 'complete-question', question: 'Сколько будет два плюс два?', reply: 'Четыре.', local: false },
    { name: 'connection-check', question: 'Лёва, ты меня слышишь?', reply: 'Да, я здесь, слышу тебя.', local: true },
  ]) {
    const traces: LatencyRecord[] = [];
    let sttCalls = 0, brainCalls = 0, packets = 0;
    const player = new DiscordPlayer();
    const connection = { state: { status: VoiceConnectionStatus.Ready }, prepareAudioPacket() {}, dispatchAudio() { packets++; }, setSpeaking() {}, onSubscriptionRemoved() {} };
    const subscription = Reflect.get(player.audio, 'subscribe').call(player.audio, connection);
    const room = new RoomController(config, { async reply(_snapshot, active, hooks) {
      brainCalls++;
      await Bun.sleep(600); active.throwIfAborted();
      hooks?.onSentence?.(fixture.reply); await Bun.sleep(40);
      return { speak: true, text: fixture.reply };
    } }, { async transcribe(...args) { sttCalls++; return runtime.client.transcribe(...args); } }, runtime.client, player, new TaskQueue(4), text => { throw new Error(text); }, { trace: record => traces.push(record) });
    const member = { id: 'synthetic-speaker', name: 'Тест' }; room.setMember(member);
    const gate = new UtteranceGate({ silenceMs: config.utteranceSilenceMs, previewSilenceMs: config.earlyEndpointMs, minSpeechMs: config.minSpeechMs, maxMs: config.maxUtteranceMs, rms: config.speechRms },
      u => room.ingest(member, u), (active, at) => room.activity(member.id, active, at), Date.now, (u, accept) => room.preview(member, u, accept));
    if (!runtime.client.vad) throw new Error(t("Live VAD was not initialized"));
    const vad = new LiveVad(runtime.client.vad.open(), (pcm, at, speech) => gate.push(pcm, at, speech), () => gate.discard());
    try {
      const pcm = await toDiscordPCM(await runtime.client.synthesize(fixture.question, signal), signal);
      const began = performance.now();
      for (let offset = 0; offset + PCM_FRAME_BYTES <= pcm.length; offset += PCM_FRAME_BYTES) {
        signal.throwIfAborted();
        vad.push(pcm.subarray(offset, offset + PCM_FRAME_BYTES));
        const target = began + (offset / PCM_FRAME_BYTES + 1) * 20;
        if (target > performance.now()) await Bun.sleep(target - performance.now());
      }
      const deadline = Date.now() + 12000;
      while (!room.diagnostics.spokenReplies) {
        signal.throwIfAborted();
        if (failure) throw failure;
        if (Date.now() > deadline || room.diagnostics.lastError) throw new Error(t("Conversation check failed: {0}; {1}", fixture.name, room.diagnostics.lastError));
        await Bun.sleep(20);
      }
      if (brainCalls !== Number(!fixture.local)) throw new Error(t("{0}: expected {1} model calls, received {2}", fixture.name, Number(!fixture.local), brainCalls));
      if (room.diagnostics.earlyEndpoints !== 1 || sttCalls !== 1 || !packets || player.metrics.underruns || vad.metrics.failures || vad.metrics.dropped) throw new Error(t("{0}: early endpoint/reuse/playback/VAD check failed; {1}", fixture.name, JSON.stringify(vad.metrics)));
      results.push({ name: fixture.name, earlyEndpoints: room.diagnostics.earlyEndpoints, sttCalls, brainCalls, spokenReplies: room.diagnostics.spokenReplies,
        endpointMs: traces.find(r => r.stage === 'utterance_ready')?.endpointMs,
        firstAudioMs: room.diagnostics.lastFirstAudioMs, packets, underruns: player.metrics.underruns, vad: vad.metrics });
    } finally { vad.close(); gate.close(false); room.close(); subscription.unsubscribe(); }
  }
  await mkdir(LOCAL, { recursive: true });
  const path = resolve(LOCAL, 'conversation-check.json');
  await Bun.write(path, JSON.stringify({ at: new Date().toISOString(), mode: 'local-synthetic-no-cloud', results }, null, 2) + '\n');
  console.log(JSON.stringify({ report: path, results }, null, 2));
} finally { await runtime.stop(); }
