/** Numeric signal measurements only. PCM16 samples are never retained. */
export function pcm16Levels(pcm: Uint8Array) {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const samples = Math.floor(pcm.byteLength / 2);
  let sum = 0, peak = 0, nonzero = 0;
  for (let n = 0; n < samples; n++) {
    const value = view.getInt16(n * 2, true);
    sum += value * value; peak = Math.max(peak, Math.abs(value));
    if (value) nonzero++;
  }
  const rms = samples ? Math.sqrt(sum / samples) : 0;
  return { samples, rms, peak, nonzero,
    rmsDbfs: rms ? Math.round(200 * Math.log10(rms / 32768)) / 10 : null };
}
