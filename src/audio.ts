import { t } from './locale';
import { spawn } from 'node:child_process';
import { encodeOpus } from './opus-encoder';
import type { DiagnosticFields } from './telemetry';

export const PCM_FRAME_BYTES = 960 * 2 * 2;
export const AUDIO_FRAME_MS = 20;

/** Encode in a persistent native worker, outside Discord's 20ms timer thread. */
export async function encodeDiscordOpus(pcm: Buffer, signal?: AbortSignal, onDiagnostic?: (fields: DiagnosticFields) => void): Promise<Buffer[]> {
  if (!pcm.length || pcm.length % 4 || pcm.length > 48000 * 4 * 90) throw new Error(t("Invalid audio reply length (maximum 90 seconds)."));
  const packets = await encodeOpus(pcm, signal, onDiagnostic);
  // At most one extra 20ms packet for Opus lookahead/final padding.
  const expected = Math.ceil(pcm.length / PCM_FRAME_BYTES);
  if (packets.length < expected || packets.length > expected + 1) throw new Error(t("Encoded Opus duration mismatch."));
  return packets;
}

export function pcm16ToWav(pcm: Buffer, rate: number, channels: number): Buffer {
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(pcm.length + 36, 4); head.write('WAVEfmt ', 8);
  head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(channels, 22);
  head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * channels * 2, 28);
  head.writeUInt16LE(channels * 2, 32); head.writeUInt16LE(16, 34);
  head.write('data', 36); head.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([head, pcm]);
}

export async function ffmpeg(input: Buffer, args: string[], signal?: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.FFMPEG_PATH ?? 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', ...args, 'pipe:1'], { windowsHide: true, signal, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [], errors: Buffer[] = [];
    let bytes = 0;
    child.stdout.on('data', (b: Buffer) => { bytes += b.length; if (bytes > 30_000_000) child.kill(); else chunks.push(b); });
    child.stderr.on('data', b => errors.push(b));
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(t("FFmpeg: {0}", Buffer.concat(errors).toString('utf8').slice(0, 300) || `exit code ${code}`))));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

// A low-pass FIR before 3:1 decimation prevents high-frequency microphone noise
// from aliasing into ASR's speech band. 63 taps, 7kHz cutoff at 48kHz.
const downsampleFilter = Array.from({ length: 63 }, (_, n) => {
  const x = n - 31, cutoff = 7000 / 48000;
  return (x ? Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x) : 2 * cutoff) * (0.54 - 0.46 * Math.cos(2 * Math.PI * n / 62));
});
const filterSum = downsampleFilter.reduce((a, b) => a + b, 0);
for (let n = 0; n < downsampleFilter.length; n++) downsampleFilter[n]! /= filterSum;

export function toMono16k(pcm: Buffer): Buffer {
  if (!pcm.length || pcm.length % 4 || pcm.length > 48000 * 4 * 30) throw new Error(t("Expected PCM16 48 kHz stereo, up to 30 seconds."));
  const count = pcm.length / 4, mono = new Float32Array(count);
  for (let n = 0; n < count; n++) mono[n] = (pcm.readInt16LE(n * 4) + pcm.readInt16LE(n * 4 + 2)) / 2;
  const result = Buffer.alloc(Math.ceil(count / 3) * 2);
  for (let n = 0; n < result.length / 2; n++) {
    let value = 0;
    for (let k = 0; k < 63; k++) value += mono[Math.max(0, Math.min(count - 1, n * 3 + k - 31))]! * downsampleFilter[k]!;
    result.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value))), n * 2);
  }
  return result;
}

export async function toSTTWav(pcm: Buffer, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted();
  return pcm16ToWav(toMono16k(pcm), 16000, 1);
}

/** Parse RIFF chunks rather than assuming every WAV has a 44-byte header. */
export async function toDiscordPCM(wav: Buffer, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted();
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw new Error(t("Invalid WAV."));
  let format: Buffer | undefined, pcm: Buffer | undefined;
  for (let at = 12; at + 8 <= wav.length;) {
    const kind = wav.toString('ascii', at, at + 4), size = wav.readUInt32LE(at + 4), end = at + 8 + size;
    if (end > wav.length) throw new Error(t("Truncated WAV."));
    if (kind === 'fmt ') format = wav.subarray(at + 8, end);
    if (kind === 'data') pcm = wav.subarray(at + 8, end);
    at = end + (size % 2);
  }
  if (!format || format.length < 16 || format.readUInt16LE(0) !== 1 || format.readUInt16LE(14) !== 16 || !pcm?.length) throw new Error(t("Expected PCM16 WAV."));
  const channels = format.readUInt16LE(2), rate = format.readUInt32LE(4);
  if (![1, 2].includes(channels) || ![16000, 24000, 48000].includes(rate) || pcm.length % (channels * 2) || pcm.length > rate * channels * 2 * 90) throw new Error(t("Unsupported speech audio format."));
  if (rate === 48000 && channels === 2) return Buffer.from(pcm);
  const samples = pcm.length / (channels * 2), factor = 48000 / rate;
  const output = Buffer.alloc(samples * factor * 4);
  for (let n = 0; n < output.length / 4; n++) {
    const position = n / factor, left = Math.floor(position), right = Math.min(samples - 1, left + 1), fraction = position - left;
    for (let c = 0; c < 2; c++) {
      const channel = Math.min(c, channels - 1);
      const a = pcm.readInt16LE((left * channels + channel) * 2), b = pcm.readInt16LE((right * channels + channel) * 2);
      output.writeInt16LE(Math.round(a + (b - a) * fraction), n * 4 + c * 2);
    }
  }
  return output;
}

export interface Utterance { pcm: Buffer; startedAt: number; endedAt: number; speechMs: number; overlap?: boolean; recognizedText?: string }
interface GateOptions { silenceMs: number; minSpeechMs: number; maxMs: number; rms: number; previewSilenceMs?: number }

/** Per-user 20ms PCM gate. Silence timers end utterances without inventing samples. */
export class UtteranceGate {
  private remainder = Buffer.alloc(0);
  private pre: Buffer[] = [];
  private frames: Buffer[] = [];
  private startedAt = 0;
  private lastVoiceAt = 0;
  private speechMs = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private previewTimer?: ReturnType<typeof setTimeout>;
  private revision = 0;
  private previews = 0;
  private lastPreviewAt = 0;
  private closed = false;
  private overlap = false;
  constructor(private options: GateOptions, private onUtterance: (u: Utterance) => void, private onActivity: (speaking: boolean, at: number) => void, private now: () => number = Date.now,
    private onPreview?: (u: Utterance, accept: (text: string) => boolean) => void) {}
  get bufferedMs() { return (this.frames.length + this.pre.length) * 20 + this.remainder.length / 192; }
  push(data: Buffer, capturedAt = this.now(), neuralSpeech?: boolean) {
    if (this.closed) return;
    this.remainder = Buffer.concat([this.remainder, data]);
    const frameSize = 960 * 2 * 2;
    const count = Math.floor(this.remainder.length / frameSize);
    for (let n = 0; n < count; n++) {
      const frame = Buffer.from(this.remainder.subarray(n * frameSize, (n + 1) * frameSize));
      const at = capturedAt - (count - n - 1) * 20;
      this.frame(frame, at, neuralSpeech);
    }
    this.remainder = Buffer.from(this.remainder.subarray(count * frameSize));
  }
  private frame(frame: Buffer, at: number, neuralSpeech?: boolean) {
    // Arrival jitter is not proof of lost audio: delayed UDP packets can arrive in a
    // burst. Never add synthetic PCM from wall-clock gaps without RTP timestamps.
    let square = 0;
    for (let n = 0; n < frame.length; n += 2) square += (frame.readInt16LE(n) / 32768) ** 2;
    // With neural VAD, RMS is only a low digital-silence floor. Quiet human
    // speech needn't cross the old microphone-volume threshold.
    const voiced = neuralSpeech === undefined ? Math.sqrt(square / (frame.length / 2)) >= this.options.rms
      : neuralSpeech && Math.sqrt(square / (frame.length / 2)) >= Math.min(this.options.rms, 0.0005);
    if (!this.frames.length) {
      if (!voiced) { this.pre.push(frame); if (this.pre.length > 10) this.pre.shift(); return; }
      this.startedAt = at - this.pre.length * 20;
      this.frames = this.pre; this.pre = [];
      this.onActivity(true, at);
    }
    this.frames.push(frame);
    if (voiced) { this.revision++; this.lastVoiceAt = at; this.speechMs += 20; this.onActivity(true, at); this.schedulePreview(); }
    if (this.frames.length * 20 >= this.options.maxMs) {
      const tail = this.frames.slice(-20);
      this.flush(at);
      this.frames = tail; this.startedAt = at - (tail.length - 1) * 20; this.overlap = true;
      this.onActivity(true, at);
      this.timer = setTimeout(() => this.flush(this.now()), Math.max(0, this.options.silenceMs - (this.now() - this.lastVoiceAt)));
    } else if (at - this.lastVoiceAt >= this.options.silenceMs) {
      this.flush(at);
    } else {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.flush(this.now()), Math.max(0, this.options.silenceMs - (this.now() - this.lastVoiceAt)));
    }
  }
  private schedulePreview() {
    clearTimeout(this.previewTimer);
    const delay = this.options.previewSilenceMs;
    if (!this.onPreview || !delay || delay >= this.options.silenceMs || this.previews >= 2 || this.speechMs < Math.max(400, this.options.minSpeechMs)) return;
    this.previewTimer = setTimeout(() => {
      if (!this.frames.length || this.closed || this.now() - this.lastPreviewAt < 800) return;
      const revision = this.revision;
      this.previews++; this.lastPreviewAt = this.now();
      this.onPreview!({ pcm: Buffer.concat(this.frames), startedAt: this.startedAt, endedAt: this.lastVoiceAt + 20, speechMs: this.speechMs, overlap: this.overlap }, text => {
        // An ASR result may arrive after the speaker resumed or the gate was reset.
        if (this.closed || revision !== this.revision || !this.frames.length || this.now() - this.lastVoiceAt < delay) return false;
        this.flush(this.now(), text); return true;
      });
    }, Math.max(0, delay - (this.now() - this.lastVoiceAt)));
  }
  flush(at = this.now(), recognizedText?: string) {
    clearTimeout(this.timer);
    clearTimeout(this.previewTimer); this.revision++;
    if (!this.frames.length) return;
    const frames = this.frames, startedAt = this.startedAt, speechMs = this.speechMs;
    const overlap = this.overlap; this.overlap = false;
    const endedAt = Math.min(at, this.lastVoiceAt + 20);
    this.frames = []; this.speechMs = 0; this.previews = 0;
    // Mark STT pending synchronously before the activity callback can schedule a room turn.
    if (speechMs >= this.options.minSpeechMs) this.onUtterance({ pcm: Buffer.concat(frames), startedAt, endedAt, speechMs, overlap, ...(recognizedText !== undefined ? { recognizedText } : {}) });
    this.onActivity(false, endedAt);
  }
  close(flush = true) { this.closed = true; if (flush) this.flush(); clearTimeout(this.timer); clearTimeout(this.previewTimer); this.frames = []; this.pre = []; this.remainder = Buffer.alloc(0); }
  discard() {
    clearTimeout(this.timer);
    clearTimeout(this.previewTimer); this.revision++; this.previews = 0;
    this.frames = []; this.pre = []; this.remainder = Buffer.alloc(0); this.speechMs = 0; this.overlap = false;
    this.onActivity(false, this.now());
  }
}
