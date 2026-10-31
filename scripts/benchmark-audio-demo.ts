import { t } from '../src/locale';
/** Reconstruct one matched question/pause/first-sentence example from measured onset times. */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { toDiscordPCM, pcm16ToWav, PCM_FRAME_BYTES } from '../src/audio';

if (!process.argv[2]) throw new Error(t("Pass a completed model-benchmark directory"));
const directory = resolve(process.argv[2]);
const analysis = JSON.parse(await readFile(resolve(directory, 'analysis.json'), 'utf8'));
const trials = (await readFile(resolve(directory, 'trials.jsonl'), 'utf8')).trim().split(/\r?\n/).map(l => JSON.parse(l)).filter(t => t.kind === 'trial');
const target = analysis.comparisons.all.firstAudibleMs.median;
// Prefer identical spoken wording, then choose the pair nearest the overall
// median paired delay. This is an illustration, never a substitute for all data.
const eligible = analysis.pairs.filter((p: any) => p.complete && p.matched && p.expectedSpeak && p.bothSpoke);
const sameWording = eligible.filter((p: any) => trials.find(t => t.id === p.sol).sentences[0] === trials.find(t => t.id === p.terra).sentences[0]);
const selected = (sameWording.length ? sameWording : eligible).sort((a: any, b: any) => Math.abs(a.delta.firstAudibleMs - target) - Math.abs(b.delta.firstAudibleMs - target))[0];
if (!selected) throw new Error(t("No comparable audible pair"));
const input = await toDiscordPCM(Buffer.from(await readFile(resolve(directory, `${selected.fixture}-input.wav`))));
const demos: any[] = [];
for (const id of [selected.sol, selected.terra]) {
  const row = trials.find(t => t.id === id);
  const voice = await toDiscordPCM(Buffer.from(await readFile(resolve(directory, `${id}-sentence-1.wav`))));
  let leadFrames = 0;
  for (let offset = 0; offset + PCM_FRAME_BYTES <= voice.length; offset += PCM_FRAME_BYTES) {
    let power = 0;
    for (let n = offset; n < offset + PCM_FRAME_BYTES; n += 2) power += (voice.readInt16LE(n) / 32768) ** 2;
    if (Math.sqrt(power / (PCM_FRAME_BYTES / 2)) >= 0.003) break;
    leadFrames++;
  }
  const questionFrames = Math.max(1, Math.round(row.speechDurationMs / 20));
  const questionBytes = Math.min(input.length - input.length % 4, questionFrames * PCM_FRAME_BYTES);
  const gapFrames = Math.max(0, Math.round(row.firstAudibleMs / 20) - leadFrames);
  const pcm = Buffer.concat([input.subarray(0, questionBytes), Buffer.alloc(gapFrames * PCM_FRAME_BYTES), voice]);
  const filename = `reconstructed-demo-${row.model.replace('gpt-6.1-', '')}.wav`;
  await writeFile(resolve(directory, filename), pcm16ToWav(pcm, 48000, 2));
  demos.push({ model: row.model, trial: id, filename, measuredSpeechEndToAudibleMs: row.firstAudibleMs, firstSentence: row.sentences[0] });
}
const metadata = { pair: selected.pair, fixture: selected.fixture, selection: 'Identical first-sentence wording, pair closest to the overall median paired first-audible difference.',
  scope: 'Reconstructed from synthetic question and reply WAVs, with silence aligned to measured local audible-dispatch latency (20ms resolution). Not a live Discord recording. Only the first reply sentence is included.', demos };
await writeFile(resolve(directory, 'audio-demo.json'), JSON.stringify(metadata, null, 2));
console.log(JSON.stringify(metadata, null, 2));
