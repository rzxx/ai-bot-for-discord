import { test, expect } from 'bun:test';
import { PassThrough } from 'node:stream';
import { LiveVad, StdioVad } from '../src/live-vad';
import { PCM_FRAME_BYTES, UtteranceGate, type Utterance } from '../src/audio';

async function settle() { for (let n = 0; n < 12; n++) await Promise.resolve(); }
const frame = () => Buffer.alloc(PCM_FRAME_BYTES, 1);

test('streaming VAD batches audio, preserves capture time, and flushes a short final batch', async () => {
  const calls: { bytes: number; reset: boolean }[] = [], output: { at: number; speech: boolean; pcm: Buffer }[] = [];
  let now = 1000, closed = false;
  const vad = new LiveVad({ async classify(pcm, reset) { calls.push({ bytes: pcm.length, reset }); return true; }, close() { closed = true; } },
    (pcm, at, speech) => output.push({ pcm, at, speech }), () => { throw new Error('Unexpected drop'); }, () => now);
  for (let n = 0; n < 4; n++) { now += 20; vad.push(frame(), now); }
  await settle();
  expect(calls).toEqual([{ bytes: 2560, reset: true }]);
  expect(output.map(f => f.at)).toEqual([1020, 1040, 1060, 1080]);
  now += 20; vad.push(frame(), now); await Bun.sleep(40);
  expect(calls[1]).toEqual({ bytes: 640, reset: false }); expect(output).toHaveLength(5);
  now += 600; vad.push(frame(), now); await Bun.sleep(40);
  expect(calls[2]!.reset).toBe(true); vad.close(); expect(closed).toBe(true);
});

test('VAD overload is bounded and a stale in-flight decision cannot resurrect discarded audio', async () => {
  let finish!: (speech: boolean) => void, now = 1000, drops = 0, emitted = 0;
  const vad = new LiveVad({ classify: () => new Promise(resolve => { finish = resolve; }), close() {} }, () => emitted++, () => drops++, () => now);
  for (let n = 0; n < 15; n++) { now += 20; vad.push(frame(), now); }
  expect(drops).toBe(1); expect(vad.metrics.maxBufferedMs).toBeLessThanOrEqual(200);
  finish(true); await settle(); expect(emitted).toBe(0); vad.close();
});

test('neural VAD rejects loud non-speech and captures speech below the old RMS threshold', () => {
  let now = 1000;
  const output: Utterance[] = [];
  const gate = new UtteranceGate({ silenceMs: 700, minSpeechMs: 200, maxMs: 12000, rms: 0.006 }, u => output.push(u), () => {}, () => now);
  const loud = Buffer.alloc(PCM_FRAME_BYTES), quiet = Buffer.alloc(PCM_FRAME_BYTES);
  for (let n = 0; n < loud.length; n += 2) { loud.writeInt16LE(10000, n); quiet.writeInt16LE(50, n); }
  for (let n = 0; n < 20; n++) { gate.push(loud, now, false); now += 20; }
  gate.flush(); expect(output).toHaveLength(0);
  for (let n = 0; n < 20; n++) { gate.push(quiet, now, true); now += 20; }
  gate.flush(); expect(output).toHaveLength(1); expect(output[0]!.speechMs).toBe(400); gate.close();
});

test('private VAD pipe matches interleaved speakers and ignores ordinary runtime logs', async () => {
  const input = new PassThrough(), output = new PassThrough(), bridge = new StdioVad(input, output);
  let sent = ''; input.on('data', chunk => { sent += chunk.toString(); });
  const a = bridge.open(), b = bridge.open();
  const first = a.classify(Buffer.alloc(1024), true), second = b.classify(Buffer.alloc(1024), true);
  await settle();
  const requests = sent.trim().split('\n').map(line => JSON.parse(line));
  expect(requests[0].stream).not.toBe(requests[1].stream);
  output.write('model ready\n@vad ' + JSON.stringify({ id: requests[1].id, speech: false }) + '\n@va');
  output.write('d ' + JSON.stringify({ id: requests[0].id, speech: true }) + '\n');
  expect(await first).toBe(true); expect(await second).toBe(false);
  const pending = a.classify(Buffer.alloc(1024), false); bridge.close();
  await expect(pending).rejects.toThrow('stopped'); a.close(); b.close(); input.destroy(); output.destroy();
});
