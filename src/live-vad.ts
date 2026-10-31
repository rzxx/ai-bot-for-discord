import { t } from './locale';
import type { Readable, Writable } from 'node:stream';
import { PCM_FRAME_BYTES, toMono16k } from './audio';

export interface VadStream { classify(pcm16k: Buffer, reset: boolean): Promise<boolean>; close(): void }
export interface VadProvider { open(): VadStream }

/** Private pipe to the already-running Python speech process. No per-frame
 * HTTP requests, new server, or additional model/runtime dependency. */
export class StdioVad implements VadProvider {
  private sequence = 0;
  private pending = new Map<number, { resolve: (speech: boolean) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private streams = new Set<string>();
  private buffer = '';
  private closed = false;
  constructor(private input: Writable, private output: Readable) { output.on('data', this.read); }
  private read = (chunk: Buffer) => {
    this.buffer += chunk.toString('utf8');
    if (this.buffer.length > 65536) { this.close(); return; }
    let end: number;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
      if (!line.startsWith('@vad ')) continue;
      try {
        const data = JSON.parse(line.slice(5)) as { id: number; speech?: boolean; error?: string };
        const job = this.pending.get(data.id); if (!job) continue;
        this.pending.delete(data.id); clearTimeout(job.timer);
        if (typeof data.speech === 'boolean') job.resolve(data.speech); else job.reject(new Error(t("Voice activity detector error.")));
      } catch { /* Other speech-runtime logs never become VAD decisions. */ }
    }
  };
  open(): VadStream {
    if (this.closed || this.streams.size >= 16) throw new Error(t("Voice activity detector unavailable or busy (maximum 16 streams)."));
    const stream = crypto.randomUUID(); this.streams.add(stream);
    let closed = false;
    return {
      classify: (pcm, reset) => {
        if (closed || this.closed || this.pending.size >= 32 || this.input.writableLength > 65536 || pcm.length > 5120) return Promise.reject(new Error(t("Voice activity detector queue is full.")));
        const id = ++this.sequence;
        return new Promise<boolean>((resolve, reject) => {
          const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(t("Voice activity detector did not respond within 500 ms."))); }, 500);
          this.pending.set(id, { resolve, reject, timer });
          this.input.write(JSON.stringify({ id, stream, reset, pcm: pcm.toString('base64') }) + '\n', error => {
            if (!error) return;
            const job = this.pending.get(id); if (!job) return;
            this.pending.delete(id); clearTimeout(job.timer); job.reject(new Error(t("Voice activity detector channel closed.")));
          });
        });
      },
      close: () => {
        if (closed) return; closed = true; this.streams.delete(stream);
        if (!this.closed && this.input.writableLength <= 65536) this.input.write(JSON.stringify({ stream, close: true }) + '\n');
      },
    };
  }
  close() {
    if (this.closed) return; this.closed = true;
    this.output.off('data', this.read);
    for (const job of this.pending.values()) { clearTimeout(job.timer); job.reject(new Error(t("Voice activity detector stopped."))); }
    this.pending.clear(); this.streams.clear(); this.buffer = '';
  }
}

/** At most 80ms per inference batch and 200ms queued audio per speaker. Neural
 * decisions gate the original PCM; no resampled audio replaces the recording. */
export class LiveVad {
  private frames: { pcm: Buffer; at: number }[] = [];
  private remainder = Buffer.alloc(0);
  private busy = false;
  private closed = false;
  private generation = 0;
  private resetNext = true;
  private lastAt = 0;
  private timer?: ReturnType<typeof setTimeout>;
  readonly metrics = { batches: 0, dropped: 0, failures: 0, maxInferenceMs: 0, maxBufferedMs: 0 };
  constructor(private stream: VadStream, private onPCM: (pcm: Buffer, at: number, speech: boolean) => void, private onDrop: () => void,
    private now: () => number = Date.now) {}
  push(pcm: Buffer, at = this.now()) {
    if (this.closed) return;
    // Long packet gaps must not carry recurrent model state from an old phrase.
    if (this.lastAt && at - this.lastAt > 500) this.resetNext = true;
    this.lastAt = at;
    this.remainder = Buffer.concat([this.remainder, pcm]);
    const count = Math.floor(this.remainder.length / PCM_FRAME_BYTES);
    for (let n = 0; n < count; n++) this.frames.push({ pcm: Buffer.from(this.remainder.subarray(n * PCM_FRAME_BYTES, (n + 1) * PCM_FRAME_BYTES)), at: at - (count - n - 1) * 20 });
    this.remainder = Buffer.from(this.remainder.subarray(count * PCM_FRAME_BYTES));
    if (this.frames.length > 10) { this.metrics.dropped += this.frames.length; this.discard(); this.onDrop(); return; }
    this.metrics.maxBufferedMs = Math.max(this.metrics.maxBufferedMs, this.frames.length * 20);
    clearTimeout(this.timer);
    if (this.frames.length >= 4) void this.drain();
    // Discord stops delivering packets at the end of speech; flush a short
    // final batch instead of stranding the last one to three frames.
    this.timer = setTimeout(() => { void this.drain(); }, 25);
  }
  private async drain() {
    if (this.busy || this.closed || !this.frames.length) return;
    const generation = this.generation, batch = this.frames.splice(0, 4), reset = this.resetNext;
    this.resetNext = false; this.busy = true;
    const began = performance.now();
    try {
      const speech = await this.stream.classify(toMono16k(Buffer.concat(batch.map(f => f.pcm))), reset);
      this.metrics.batches++; this.metrics.maxInferenceMs = Math.max(this.metrics.maxInferenceMs, performance.now() - began);
      if (generation !== this.generation || this.closed) return;
      if (this.now() - batch[0]!.at > 250) { this.metrics.dropped += batch.length; this.discard(); this.onDrop(); return; }
      for (const frame of batch) this.onPCM(frame.pcm, frame.at, speech);
    } catch {
      if (generation !== this.generation || this.closed) return;
      this.metrics.failures++; this.discard(); this.onDrop();
    } finally {
      this.busy = false;
      if (!this.closed && this.frames.length) void this.drain();
    }
  }
  discard() { this.generation++; this.frames = []; this.remainder = Buffer.alloc(0); this.resetNext = true; clearTimeout(this.timer); }
  close() { if (this.closed) return; this.closed = true; this.discard(); this.stream.close(); }
}
