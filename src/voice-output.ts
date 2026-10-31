import { t } from './locale';
import { AsyncBuffer } from './async-buffer';
import type { Playback, PlaybackHooks, Player } from './room';
import type { Reply } from './llm';
import type { Speaker } from './speech';
import { trimSpeechPadding } from './speech-cadence';

/** Concurrent sentence synthesis and playback, scoped to exactly one room turn. */
export class VoiceOutput {
  private abort = new AbortController();
  private signal: AbortSignal;
  private text: AsyncBuffer<string>;
  private pcm: AsyncBuffer<Buffer>;
  private offered = '';
  error?: Error;
  readonly result: Promise<Playback>;
  constructor(speaker: Speaker, convert: (wav: Buffer, signal: AbortSignal) => Promise<Buffer>, player: Player,
    signal: AbortSignal, hooks: PlaybackHooks, onFailure: () => void) {
    this.signal = AbortSignal.any([signal, this.abort.signal]);
    // Text is capped by the reply character limit. Audio has strict backpressure.
    this.text = new AsyncBuffer<string>(Infinity, this.signal);
    this.pcm = new AsyncBuffer<Buffer>(2, this.signal);
    const text = this.text, pcmOutput = this.pcm, activeSignal = this.signal;
    const fail = (error: unknown) => {
      if (!this.signal.aborted) { this.error = error instanceof Error ? error : new Error(String(error)); onFailure(); }
      this.cancel();
    };
    const synthesis = (async () => {
      let chunk = 0;
      for await (const sentence of text) {
        activeSignal.throwIfAborted();
        let began = performance.now();
        const wav = await speaker.synthesize(sentence, activeSignal);
        hooks.onTiming?.('tts_completed', Math.round(performance.now() - began), ++chunk);
        hooks.onDiagnostic?.('tts_audio', { chunk, wavBytes: wav.length });
        activeSignal.throwIfAborted(); began = performance.now();
        const converted = await convert(wav, activeSignal);
        const pcm = trimSpeechPadding(converted);
        hooks.onDiagnostic?.('pcm_audio', { chunk, beforeTrimBytes: converted.length, pcmBytes: pcm.length, durationMs: Math.round(pcm.length / 192) });
        hooks.onTiming?.('pcm_converted', Math.round(performance.now() - began), chunk);
        await pcmOutput.put(pcm);
      }
      pcmOutput.close();
    })().catch(fail);
    this.result = player.playStream!(this.pcm, this.signal, hooks).catch((error): Playback => {
      fail(error); return { completed: false, playedMs: 0 };
    }).then(async played => {
      if (played.error) fail(played.error);
      // A disconnect or early Idle must also cancel pending synthesis/model work.
      if (!played.completed && !this.signal.aborted) fail(new Error(t("Speech stream interrupted before completion.")));
      this.cancel(); await synthesis; return played;
    });
  }
  write(sentence: string) {
    this.signal.throwIfAborted();
    this.offered += (this.offered ? ' ' : '') + sentence.trim();
    // Infinity capacity makes this synchronous apart from the resolved promise.
    void this.text.put(sentence).catch(() => {});
  }
  finish(reply: Reply) {
    const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
    const full = normalize(reply.text), offered = normalize(this.offered);
    if (offered && (!reply.speak || !full.startsWith(offered))) throw new Error(t("Spoken prefix differs from the completed reply."));
    if (reply.speak && full.length > offered.length) this.write(full.slice(offered.length).trim());
    this.text.close();
  }
  cancel() { this.abort.abort(); this.text.fail(this.signal.reason); this.pcm.fail(this.signal.reason); }
}
