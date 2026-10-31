import { test, expect } from 'bun:test';
import { AudioPlayerStatus, AudioReceiveStream, EndBehaviorType, VoiceConnectionStatus, createAudioResource, StreamType } from '@discordjs/voice';
import { Readable } from 'node:stream';
import { Decoder, Encoder } from '@evan/opus';
import { encodeDiscordOpus, UtteranceGate, PCM_FRAME_BYTES, type Utterance } from '../src/audio';
import { LiveOpusDecoder } from '../src/live-decoder';
import { DiscordPlayer } from '../src/playback';

function tone(frames: number) {
  const frame = Buffer.alloc(PCM_FRAME_BYTES);
  for (let i = 0; i < 960; i++) { const sample = Math.round(Math.sin(2 * Math.PI * 440 * i / 48000) * 7000); frame.writeInt16LE(sample, i * 4); frame.writeInt16LE(sample, i * 4 + 2); }
  return Buffer.concat(Array.from({ length: frames }, () => frame));
}

test('outgoing Opus is prepared before playback, has 20ms frames and bounded stream lookahead', async () => {
  const pcm = tone(117);
  const packets = await encodeDiscordOpus(pcm, AbortSignal.timeout(10000));
  expect(packets.length).toBeGreaterThanOrEqual(117); expect(packets.length).toBeLessThanOrEqual(118);
  const decoder = new Decoder({ sample_rate: 48000, channels: 2 });
  for (const packet of packets) expect(decoder.decode(packet).length).toBe(PCM_FRAME_BYTES);
  const resource = createAudioResource(Readable.from(packets, { objectMode: true, highWaterMark: 4 }), { inputType: StreamType.Opus });
  await Bun.sleep(10);
  expect(resource.encoder).toBeUndefined();
  expect(resource.playStream.readableLength).toBeLessThanOrEqual(4);
  resource.playStream.destroy();
}, 10000);

test('120 seconds of continuous capture stays bounded and splits without losing samples', () => {
  let at = 100000;
  const output: Utterance[] = [];
  const frame = tone(1);
  const gate = new UtteranceGate({ silenceMs: 700, minSpeechMs: 200, maxMs: 12000, rms: 0.006 }, u => output.push(u), () => {}, () => at);
  let peak = 0;
  for (let i = 0; i < 6000; i++) { gate.push(frame); peak = Math.max(peak, gate.bufferedMs); at += 20; }
  gate.flush(); gate.close();
  expect(peak).toBeLessThanOrEqual(12000);
  expect(output.every(u => u.pcm.length <= 12000 * 192)).toBe(true);
  const actual = output.reduce((sum, u) => sum + u.pcm.length, 0);
  const overlap = output.filter(u => u.overlap).length * 400 * 192;
  expect(actual - overlap).toBe(6000 * PCM_FRAME_BYTES);
});

test('a delayed packet burst cannot fabricate PCM silence or stretch the recording', () => {
  let at = 100000;
  const output: Utterance[] = [];
  const gate = new UtteranceGate({ silenceMs: 700, minSpeechMs: 200, maxMs: 12000, rms: 0.006 }, u => output.push(u), () => {}, () => at);
  const frame = tone(1);
  for (let i = 0; i < 50; i++) { gate.push(frame); at += 20; }
  at += 300; // main thread or socket delivery stalled; packets arrive together afterward
  for (let i = 0; i < 15; i++) gate.push(frame);
  gate.flush(); gate.close();
  expect(output).toHaveLength(1);
  expect(output[0]!.pcm.length).toBe(65 * PCM_FRAME_BYTES);
});

test('input overload drops old packets and never grows an unbounded decode queue', async () => {
  const source = new AudioReceiveStream({ end: { behavior: EndBehaviorType.Manual }, highWaterMark: 4 });
  const encoder = new Encoder({ sample_rate: 48000, channels: 2 });
  const packet = Buffer.from(encoder.encode(tone(1)));
  const errors: Error[] = []; let decodedBytes = 0, dropped = 0;
  const decoder = new LiveOpusDecoder(source, pcm => { decodedBytes += pcm.length; }, error => errors.push(error), count => { dropped += count; });
  for (let i = 0; i < 1000; i++) source.push(packet);
  await Bun.sleep(50);
  expect(errors).toHaveLength(0);
  expect(decoder.metrics.peakQueuedPackets).toBeLessThanOrEqual(10);
  expect(decoder.metrics.dropped).toBe(990);
  expect(dropped).toBe(990);
  expect(decodedBytes).toBe(10 * PCM_FRAME_BYTES);
  expect(decoder.metrics.queuedPackets).toBe(0); expect(source.readableLength).toBe(0);
  decoder.destroy(); source.destroy();
});

test('eight independent live decoders preserve every frame without corrupting each other', async () => {
  const packets = await encodeDiscordOpus(tone(50));
  const errors: Error[] = [], decoded = Array(8).fill(0) as number[];
  const sources = decoded.map(() => new AudioReceiveStream({ end: { behavior: EndBehaviorType.Manual } }));
  const decoders = sources.map((source, id) => new LiveOpusDecoder(source, pcm => { decoded[id]! += pcm.length; }, error => errors.push(error), () => { throw new Error('Unexpected overload'); }));
  try {
    for (let frame = 0; frame < 1000; frame++) {
      for (const source of sources) source.push(packets[frame % packets.length]!);
      // Drain each batch without faking wall-clock audio timing.
      await new Promise<void>(resolveDone => setImmediate(resolveDone));
    }
    expect(errors).toHaveLength(0);
    expect(decoded).toEqual(Array(8).fill(1000 * PCM_FRAME_BYTES));
    expect(decoders.every(d => d.metrics.decoded === 1000 && !d.metrics.dropped)).toBe(true);
  } finally { for (const decoder of decoders) decoder.destroy(); for (const source of sources) source.destroy(); }
}, 10000);

test('explicit stop also cancels codec preparation before an audio player starts', async () => {
  const player = new DiscordPlayer(); const abort = new AbortController();
  const result = player.play(tone(1000), abort.signal);
  player.stop();
  expect(await result).toEqual({ completed: false, playedMs: 0 });
  expect(player.audio.state.status).toBe(AudioPlayerStatus.Idle);
}, 10000);

test('playback timestamps follow actual player activity rather than codec preparation', async () => {
  const player = new DiscordPlayer();
  const connection = { state: { status: VoiceConnectionStatus.Ready }, prepareAudioPacket() {}, dispatchAudio() {}, setSpeaking() {}, onSubscriptionRemoved() {} };
  const subscription = Reflect.get(player.audio, 'subscribe').call(player.audio, connection);
  let observedStart = 0;
  player.audio.once(AudioPlayerStatus.Playing, () => { observedStart = Date.now(); });
  const requestedAt = Date.now();
  try {
    const result = await player.play(tone(10), AbortSignal.timeout(5000));
    expect(result.completed).toBe(true); expect(result.playedMs).toBeGreaterThanOrEqual(200);
    expect(observedStart).toBeGreaterThanOrEqual(requestedAt);
    expect(Math.abs(result.startedAt! - observedStart)).toBeLessThan(50);
    expect(result.endedAt!).toBeGreaterThan(result.startedAt!);
    expect(result.endedAt!).toBeLessThanOrEqual(Date.now());
  } finally { player.stop(); subscription.unsubscribe(); }
}, 10000);
