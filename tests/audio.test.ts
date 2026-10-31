import { test, expect } from 'bun:test';
import { pcm16ToWav, UtteranceGate, toSTTWav, toDiscordPCM, type Utterance } from '../src/audio';

test('direct PCM conversion preserves duration and the sample rate and channels required by Discord', async () => {
  const pcm = Buffer.alloc(960 * 4 * 15);
  for (let i = 0; i < pcm.length / 4; i++) { const sample = Math.round(Math.sin(2 * Math.PI * 440 * i / 48000) * 5000); pcm.writeInt16LE(sample, i * 4); pcm.writeInt16LE(sample, i * 4 + 2); }
  const wav = await toSTTWav(pcm);
  expect(wav.readUInt16LE(22)).toBe(1); expect(wav.readUInt32LE(24)).toBe(16000);
  const restored = await toDiscordPCM(wav); expect(restored.length).toBe(pcm.length);
}, 10000);

test('ASR downsampling rejects above-Nyquist noise rather than aliasing it into speech', async () => {
  async function energy(frequency: number) {
    const pcm = Buffer.alloc(48000 * 4);
    for (let n = 0; n < 48000; n++) { const value = Math.round(12000 * Math.sin(2 * Math.PI * frequency * n / 48000)); pcm.writeInt16LE(value, n * 4); pcm.writeInt16LE(value, n * 4 + 2); }
    const wav = await toSTTWav(pcm); let sum = 0;
    for (let n = 44 + 128; n < wav.length - 128; n += 2) sum += wav.readInt16LE(n) ** 2;
    return sum;
  }
  expect(await energy(12000) / await energy(1000)).toBeLessThan(0.0001);
});

test('direct WAV conversion skips metadata chunks and rejects truncated or unsupported audio', async () => {
  const pcm = Buffer.from([100, 0, 200, 0, 44, 1]), base = pcm16ToWav(pcm, 48000, 1);
  const metadata = Buffer.from([...'JUNK'].map(c => c.charCodeAt(0)).concat([3, 0, 0, 0, 1, 2, 3, 0]));
  const wav = Buffer.concat([base.subarray(0, 12), metadata, base.subarray(12)]);
  wav.writeUInt32LE(wav.length - 8, 4);
  const result = await toDiscordPCM(wav);
  expect([...result]).toEqual([100, 0, 100, 0, 200, 0, 200, 0, 44, 1, 44, 1]);
  await expect(toDiscordPCM(wav.subarray(0, wav.length - 1))).rejects.toThrow('Truncated');
  base.writeUInt16LE(3, 20); await expect(toDiscordPCM(base)).rejects.toThrow('PCM16');
});

test('silence and short clicks do not create utterances; Russian speech frames retain pre-roll', () => {
  let now = 10000;
  const captured: Utterance[] = [], activity: boolean[] = [];
  const gate = new UtteranceGate({ silenceMs: 700, minSpeechMs: 200, maxMs: 12000, rms: 0.006 }, u => captured.push(u), active => activity.push(active), () => now);
  const silence = Buffer.alloc(3840), speech = Buffer.alloc(3840);
  for (let i = 0; i < speech.length; i += 2) speech.writeInt16LE(2000, i);
  for (let i = 0; i < 15; i++) { gate.push(silence); now += 20; }
  gate.push(speech); now += 20; gate.flush(); expect(captured).toHaveLength(0);
  for (let i = 0; i < 10; i++) { gate.push(silence); now += 20; }
  for (let i = 0; i < 20; i++) { gate.push(speech); now += 20; }
  gate.flush();
  expect(captured).toHaveLength(1); expect(captured[0]!.speechMs).toBe(400);
  expect(captured[0]!.pcm.length).toBe(30 * 3840); expect(activity.at(-1)).toBe(false); gate.close();
});

test('an accepted pause preview closes early and preserves recognized text and capture times', async () => {
  let now = 10000;
  const output: Utterance[] = [];
  const speech = Buffer.alloc(3840);
  for (let i = 0; i < speech.length; i += 2) speech.writeInt16LE(2000, i);
  const gate = new UtteranceGate({ silenceMs: 500, previewSilenceMs: 10, minSpeechMs: 200, maxMs: 12000, rms: 0.006 },
    u => output.push(u), () => {}, () => now, (_u, accept) => accept('Лёва сколько будет два плюс два'));
  try {
    for (let i = 0; i < 25; i++) { gate.push(speech); now += 20; }
    await Bun.sleep(25);
    expect(output).toHaveLength(1);
    expect(output[0]!.recognizedText).toBe('Лёва сколько будет два плюс два');
    expect(output[0]!.endedAt).toBe(10500);
    expect(output[0]!.pcm.length).toBe(25 * 3840);
    expect(gate.bufferedMs).toBe(0);
  } finally { gate.close(); }
});

test('resumed speech invalidates an outstanding pause preview without losing captured audio', async () => {
  let now = 10000, accept!: (text: string) => boolean;
  const output: Utterance[] = [], speech = Buffer.alloc(3840);
  for (let i = 0; i < speech.length; i += 2) speech.writeInt16LE(2000, i);
  const gate = new UtteranceGate({ silenceMs: 500, previewSilenceMs: 10, minSpeechMs: 200, maxMs: 12000, rms: 0.006 },
    u => output.push(u), () => {}, () => now, (_u, done) => { accept = done; });
  try {
    for (let i = 0; i < 25; i++) { gate.push(speech); now += 20; }
    await Bun.sleep(25);
    expect(accept).toBeDefined();
    gate.push(speech); now += 20;
    expect(accept('Старый неполный результат')).toBe(false);
    expect(output).toHaveLength(0);
    gate.flush();
    expect(output[0]!.pcm.length).toBe(26 * 3840);
    expect(output[0]!.recognizedText).toBeUndefined();
  } finally { gate.close(); }
});
