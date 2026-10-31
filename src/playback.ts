import { t } from './locale';
import { Readable } from 'node:stream';
import { performance } from 'node:perf_hooks';
import { AudioPlayerStatus, NoSubscriberBehavior, StreamType, createAudioPlayer, createAudioResource } from '@discordjs/voice';
import { encodeDiscordOpus } from './audio';
import { AsyncBuffer, nextOrAbort } from './async-buffer';
import { log, safeError } from './config';
import type { Player, Playback, PlaybackHooks } from './room';
import { diagnosticsEnabled, type DiagnosticFields } from './telemetry';

export class DiscordPlayer implements Player {
  readonly audio = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Stop } });
  readonly metrics = { maxSchedulerLagMs: 0, maxBufferedPackets: 0, underruns: 0, completed: 0, stoppedForLag: 0 };
  private active?: AbortController;
  constructor(private observation: { diagnostic?: boolean; network?: () => DiagnosticFields } = {}) { this.audio.on('error', error => log(t("Player: {0}", safeError(error)))); }
  play(pcm: Buffer, signal: AbortSignal, hooks?: PlaybackHooks): Promise<Playback> {
    return this.playStream((async function* () { yield pcm; })(), signal, hooks);
  }
  async playStream(chunks: AsyncIterable<Buffer>, signal: AbortSignal, hooks?: PlaybackHooks): Promise<Playback> {
    if (this.active) throw new Error(t("A reply is already playing."));
    if (signal.aborted) return { completed: false, playedMs: 0 };
    const active = new AbortController(); this.active = active;
    const bounded = AbortSignal.any([signal, active.signal]);
    const diagnostic = this.observation.diagnostic ?? diagnosticsEnabled();
    const network = () => { try { return this.observation.network?.() ?? {}; } catch { return { snapshotUnavailable: true }; } };
    const observe = (stage: string, fields: DiagnosticFields) => { if (diagnostic) hooks?.onDiagnostic?.(stage, fields); };
    const encoded = new AsyncBuffer<Buffer[]>(2, bounded);
    let packetCount = 0, producerFinished = false, silenceFrames = 0, consumedPackets = 0;
    // Encode each sentence off the Discord timer. Prepare the next two while
    // the current packets play; never buffer a whole long reply here.
    const producer = (async () => {
      let chunk = 0;
      const input = chunks[Symbol.asyncIterator]();
      for (;;) {
        const next = await nextOrAbort(input, bounded);
        if (next.done) break;
        const pcm = next.value;
        bounded.throwIfAborted();
        const began = performance.now();
        const packets = await encodeDiscordOpus(pcm, bounded, diagnostic ? fields => observe('opus_signal', { chunk: chunk + 1, ...fields }) : undefined);
        hooks?.onTiming?.('opus_encoded', Math.round(performance.now() - began), ++chunk);
        packetCount += packets.length;
        if (packetCount * 20 > 90000) throw new Error(t("Audio reply exceeds 90 seconds."));
        await encoded.put(packets);
      }
      producerFinished = true; encoded.close();
    })().catch(error => encoded.fail(error));
    const iterator = encoded[Symbol.asyncIterator]();
    try {
      const first = await iterator.next();
      if (first.done) return { completed: true, playedMs: 0 };
      bounded.throwIfAborted();
      await hooks?.beforeStart?.();
      bounded.throwIfAborted();
      const packets = async function* () {
        let current = first.value!;
        for (;;) {
          const pending = iterator.next().then(value => ({ value }), error => ({ error }));
          for (const packet of current) { consumedPackets++; yield packet; }
          for (;;) {
            bounded.throwIfAborted();
            let timer: ReturnType<typeof setTimeout> | undefined;
            const next = await Promise.race([pending, new Promise<null>(resolveWait => { timer = setTimeout(() => resolveWait(null), 20); })]);
            clearTimeout(timer);
            if (next === null) {
              // Keep a single Discord resource alive if the next sentence is
              // still being generated. These waits are measured, not hidden.
              silenceFrames++; packetCount++;
              consumedPackets++;
              yield Buffer.from([0xf8, 0xff, 0xfe]); continue;
            }
            if ('error' in next) throw next.error;
            if (next.value.done) return;
            current = next.value.value; break;
          }
        }
      };
      return await new Promise<Playback>(resolvePlayback => {
        const resource = createAudioResource(Readable.from(packets(), { objectMode: true, highWaterMark: 4 }), { inputType: StreamType.Opus });
        resource.playStream.on('error', () => {});
        let settled = false, began = 0, observedMisses = 0, lastProgress = 0;
        const networkBefore = diagnostic ? network() : {};
        observe('audio_player_created', { ...networkBefore, encodedPackets: packetCount });
        let startedAt: number | undefined;
        const cleanup = () => {
          bounded.removeEventListener('abort', cancel);
          this.audio.off(AudioPlayerStatus.Idle, done); this.audio.off(AudioPlayerStatus.Playing, started);
          this.audio.off('error', failed); clearTimeout(timeout); clearInterval(watchdog);
        };
        const finish = (completed: boolean, error?: Error) => {
          if (settled) return; settled = true; cleanup();
          if (completed) this.metrics.completed++;
          const playedMs = resource.playbackDuration;
          const networkAfter = diagnostic ? network() : {};
          const before = networkBefore.voicePackets, after = networkAfter.voicePackets;
          observe('audio_player_finished', { ...networkAfter, completed, playedMs, consumedPackets, encodedPackets: packetCount,
            silenceFrames, dispatchedPackets: typeof before === 'number' && typeof after === 'number' && after >= before ? after - before : null,
            playerState: this.audio.state.status, aborted: bounded.aborted, error: !!error });
          resolvePlayback({ completed, playedMs, ...(startedAt !== undefined && playedMs > 0 ? { startedAt, endedAt: Date.now() } : {}), ...(error ? { error } : {}), ...(silenceFrames ? { streamWaitMs: silenceFrames * 20 } : {}) });
          resource.playStream.destroy();
        };
        const cancel = () => { finish(false); this.audio.stop(true); };
        const done = () => finish(!bounded.aborted && producerFinished && resource.playbackDuration >= packetCount * 20);
        const failed = (error: Error) => { finish(false, error); this.audio.stop(true); };
        const started = () => { began ||= performance.now(); if (startedAt === undefined) { startedAt = Date.now(); observe('audio_player_started', { ...network() }); hooks?.onStart?.(startedAt); } };
        const timeout = setTimeout(() => failed(new Error(t("Discord did not finish the speech stream within 105 seconds."))), 105000);
        const watchdog = setInterval(() => {
          this.metrics.maxBufferedPackets = Math.max(this.metrics.maxBufferedPackets, resource.playStream.readableLength);
          if (this.audio.state.status !== AudioPlayerStatus.Playing || !began) return;
          const lag = Math.max(0, performance.now() - began - resource.playbackDuration);
          this.metrics.maxSchedulerLagMs = Math.max(this.metrics.maxSchedulerLagMs, lag);
          const misses = this.audio.state.missedFrames;
          if (misses > observedMisses) this.metrics.underruns += misses - observedMisses;
          observedMisses = misses;
          if (diagnostic && performance.now() - lastProgress >= 1000) {
            lastProgress = performance.now();
            observe('audio_player_progress', { ...network(), playedMs: resource.playbackDuration, consumedPackets,
              missedFrames: misses, lagMs: Math.round(lag), bufferedPackets: resource.playStream.readableLength });
          }
          if (lag > 500) {
            this.metrics.stoppedForLag++;
            failed(new Error(t("Playback fell behind by more than half a second. Reply stopped.")));
          }
        }, 100);
        bounded.addEventListener('abort', cancel, { once: true });
        this.audio.once(AudioPlayerStatus.Idle, done); this.audio.on(AudioPlayerStatus.Playing, started); this.audio.once('error', failed);
        this.audio.play(resource);
        if (bounded.aborted) cancel();
      });
    } catch (error) {
      if (bounded.aborted) return { completed: false, playedMs: 0 };
      throw error;
    } finally {
      active.abort(); encoded.close();
      await producer;
      if (this.active === active) this.active = undefined;
    }
  }
  stop() { this.active?.abort(); this.audio.stop(true); }
}
