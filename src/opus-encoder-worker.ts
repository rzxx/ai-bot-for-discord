import { Encoder, Decoder } from '@evan/opus';
import { pcm16Levels } from './audio-levels';

const encoder = new Encoder({ sample_rate: 48000, channels: 2, application: 'voip' });
encoder.bitrate = 64000;
encoder.signal = 'voice';
encoder.complexity = 5;

self.onmessage = ({ data }: MessageEvent<{ id: number; pcm: Uint8Array; diagnostic?: boolean }>) => {
  try {
    encoder.reset();
    const pcm = data.pcm, size = 3840;
    // Discord consumes raw packets, without Ogg pre-skip. Drain codec lookahead
    // so a word at the very end of a chunk isn't truncated.
    // The package's .d.ts misspells lookahead; OPUS_GET_LOOKAHEAD is stable.
    const samples = pcm.byteLength / 4 + encoder.ctl(4027);
    const packets: Uint8Array[] = [];
    for (let n = 0; n < Math.ceil(samples / 960); n++) {
      const frame = new Uint8Array(size);
      frame.set(pcm.subarray(n * size, Math.min(pcm.length, (n + 1) * size)));
      packets.push(Uint8Array.from(encoder.encode(frame)));
    }
    let diagnostic;
    if (data.diagnostic) {
      // Off the Discord timer thread. Inspect exactly the production packets;
      // diagnosis never substitutes a tone or changes the encoder settings.
      try {
        const before = pcm16Levels(pcm);
        const decoder = new Decoder({ sample_rate: 48000, channels: 2 });
        let squares = 0, samples = 0, peak = 0, nonzero = 0;
        for (const packet of packets) {
          const decoded = decoder.decode(packet);
          const levels = pcm16Levels(decoded);
          squares += levels.rms ** 2 * levels.samples; samples += levels.samples;
          peak = Math.max(peak, levels.peak); nonzero += levels.nonzero;
        }
        diagnostic = { pcmRms: Math.round(before.rms * 100) / 100, pcmPeak: before.peak, pcmDbfs: before.rmsDbfs,
          decodedRms: samples ? Math.round(Math.sqrt(squares / samples)) : 0, decodedPeak: peak,
          decodedNonzero: nonzero, packets: packets.length, opusBytes: packets.reduce((n, p) => n + p.length, 0) };
      } catch { diagnostic = { diagnosticError: true }; }
    }
    self.postMessage({ id: data.id, packets, diagnostic }, { transfer: packets.map(p => p.buffer) });
  } catch (error) {
    self.postMessage({ id: data.id, error: error instanceof Error ? error.message : 'Opus encoding failed' });
  }
};
