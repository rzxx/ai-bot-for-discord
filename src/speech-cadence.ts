/** Remove redundant model padding while preserving a little breath at chunk edges.
 * Works on Discord's stereo PCM16, in 20 ms frames; quiet speech uses a relative
 * threshold. It never stitches words or changes the interior of an utterance. */
export function trimSpeechPadding(pcm: Buffer): Buffer {
  const frame = 3840;
  if (pcm.length < frame * 4 || pcm.length % 4) return pcm;
  const count = Math.ceil(pcm.length / frame);
  const level = (index: number) => {
    const start = index * frame, end = Math.min(start + frame, pcm.length);
    let sum = 0, count = 0;
    for (let i = start; i + 1 < end; i += 2) { const x = pcm.readInt16LE(i) / 32768; sum += x * x; count++; }
    return Math.sqrt(sum / count);
  };
  // Sample the level instead of scanning every interior sample on the audio
  // scheduler's thread. Only edge frames need exact inspection.
  let peak = 0;
  for (let index = 0; index < count; index += Math.max(1, Math.floor(count / 32))) peak = Math.max(peak, level(index));
  const threshold = Math.max(0.0002, Math.min(0.002, peak * 0.015));
  if (peak < threshold) return pcm;
  let first = 0, last = count - 1;
  while (first < last && level(first) < threshold) first++;
  while (last > first && level(last) < threshold) last--;
  return pcm.subarray(Math.max(0, first - 2) * frame, Math.min(pcm.length, (last + 4) * frame));
}
