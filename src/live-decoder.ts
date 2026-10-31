import type { Readable } from 'node:stream';
import { performance } from 'node:perf_hooks';
import { Decoder } from '@evan/opus';

export interface ReceiveMetrics {
  received: number; decoded: number; dropped: number;
  queuedPackets: number; peakQueuedPackets: number;
  maxQueueAgeMs: number; maxDecodeMs: number;
}

/** UDP cannot honor stream backpressure. Consume it immediately into a bounded
 * queue, yield between decode batches, and drop stale audio rather than replaying
 * seconds of backlog. This bounds app latency; it cannot repair network loss. */
export class LiveOpusDecoder {
  readonly metrics: ReceiveMetrics = { received: 0, decoded: 0, dropped: 0, queuedPackets: 0, peakQueuedPackets: 0, maxQueueAgeMs: 0, maxDecodeMs: 0 };
  private queue: { packet: Buffer; queuedAt: number; capturedAt: number }[] = [];
  private decoder?: Decoder;
  private scheduled?: ReturnType<typeof setImmediate>;
  private closed = false;
  constructor(readonly source: Readable, readonly onPCM: (pcm: Buffer, at: number) => void,
    readonly onError: (error: Error) => void, readonly onDrop: (count: number) => void,
    readonly maxPackets = 10, readonly maxAgeMs = 200) {
    this.decoder = new Decoder({ sample_rate: 48000, channels: 2 });
    source.on('data', this.enqueue);
  }
  private enqueue = (packet: Buffer) => {
    if (this.closed) return;
    this.metrics.received++;
    // Discord Opus packets are normally 20ms. Age is enforced independently of
    // packet duration, so unusual packet sizes cannot create a long catch-up queue.
    this.queue.push({ packet, queuedAt: performance.now(), capturedAt: Date.now() });
    const excess = Math.max(0, this.queue.length - this.maxPackets);
    if (excess) { this.queue.splice(0, excess); this.dropped(excess); }
    this.updateDepth();
    this.scheduled ??= setImmediate(this.drain);
  };
  private updateDepth() {
    this.metrics.queuedPackets = this.queue.length;
    this.metrics.peakQueuedPackets = Math.max(this.metrics.peakQueuedPackets, this.queue.length);
  }
  private dropped(count: number) { this.metrics.dropped += count; this.onDrop(count); }
  private drain = () => {
    this.scheduled = undefined;
    if (this.closed) return;
    const started = performance.now();
    let expired = 0;
    while (this.queue.length && started - this.queue[0]!.queuedAt > this.maxAgeMs) { this.queue.shift(); expired++; }
    if (expired) this.dropped(expired);
    let processed = 0;
    while (this.queue.length && processed < 4 && performance.now() - started < 1) {
      const entry = this.queue.shift()!;
      const age = performance.now() - entry.queuedAt;
      this.metrics.maxQueueAgeMs = Math.max(this.metrics.maxQueueAgeMs, age);
      const before = performance.now();
      // Both decoder and PCM consumer are synchronous: there is no hidden
      // writable queue behind this explicitly bounded one.
      try {
        const pcm = this.decoder!.decode(entry.packet);
        this.metrics.decoded++;
        this.onPCM(Buffer.from(pcm), entry.capturedAt);
      } catch (error) {
        this.destroy(); this.onError(error instanceof Error ? error : new Error(String(error))); break;
      }
      this.metrics.maxDecodeMs = Math.max(this.metrics.maxDecodeMs, performance.now() - before);
      processed++;
      if (this.closed) break;
    }
    this.updateDepth();
    if (!this.closed && this.queue.length) this.scheduled = setImmediate(this.drain);
  };
  destroy() {
    if (this.closed) return; this.closed = true;
    this.source.off('data', this.enqueue); clearImmediate(this.scheduled);
    this.queue = []; this.updateDepth();
    // Native handles are finalized by the binding; WASM fallback supports drop().
    (this.decoder as Decoder & { drop?: () => void })?.drop?.();
    this.decoder = undefined;
  }
}
