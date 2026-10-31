import { t } from '../src/locale';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { LOCAL } from '../src/config';

const specified = process.argv[2];
const latest = (await readdir(LOCAL)).filter(n => n.startsWith('model-benchmark-') && !n.endsWith('-local')).sort().at(-1);
if (!specified && !latest) throw new Error(t("No benchmark found"));
const directory = resolve(specified ?? resolve(LOCAL, latest!));
const method = JSON.parse(await readFile(resolve(directory, 'method.json'), 'utf8'));
const records = (await readFile(resolve(directory, 'trials.jsonl'), 'utf8')).trim().split(/\r?\n/).map(l => JSON.parse(l));
const trials = records.filter(r => r.kind === 'trial' && !r.warmup);
const probes = records.filter(r => r.kind === 'probe');
for (const t of trials) {
  const text = t.traces.find((r: any) => r.stage === 'first_text');
  const event = t.traces.find((r: any) => r.stage === 'first_event' && r.attempt === text?.attempt);
  t.firstTextToSentenceMs = typeof t.firstSentenceMs === 'number' && typeof t.firstTextMs === 'number' ? t.firstSentenceMs - t.firstTextMs : null;
  t.firstEventToTextMs = text && event ? text.sinceTurnMs - event.sinceTurnMs : null;
  t.sentenceToAudibleMs = typeof t.modelRequestToFirstAudibleMs === 'number' && typeof t.firstSentenceMs === 'number' ? t.modelRequestToFirstAudibleMs - t.firstSentenceMs : null;
  t.firstTtsMs = t.traces.find((r: any) => r.stage === 'tts_completed' && r.chunk === 1)?.elapsedMs ?? null;
  t.firstPcmMs = t.traces.find((r: any) => r.stage === 'pcm_converted' && r.chunk === 1)?.elapsedMs ?? null;
  t.firstOpusMs = t.traces.find((r: any) => r.stage === 'opus_encoded' && r.chunk === 1)?.elapsedMs ?? null;
  t.firstSentenceChars = t.sentences[0]?.length ?? null;
  t.spokenAudioMs = t.playbackTruncated ? null : t.traces.find((r: any) => r.stage === 'playback_finished')?.playedMs ?? null;
  t.turnBusyMs = t.playbackTruncated ? null : t.traces.find((r: any) => r.stage === 'turn_finished')?.sinceTurnMs ?? null;
  t.streamWaitMs = t.traces.find((r: any) => r.stage === 'playback_finished')?.streamWaitMs ?? null;
}
const sol = 'gpt-6.1-sol', terra = 'gpt-6.1-terra';
const numbers = (values: unknown[]) => values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
function quantile(values: number[], p: number): number | null {
  const v = numbers(values); if (!v.length) return null;
  const i = (v.length - 1) * p, low = Math.floor(i), high = Math.ceil(i);
  return Math.round(v[low]! + (v[high]! - v[low]!) * (i - low));
}
const stats = (values: number[]) => ({ n: numbers(values).length, median: quantile(values, .5), p90: quantile(values, .9), min: quantile(values, 0), max: quantile(values, 1) });
const metrics = ['firstTextMs', 'firstSentenceMs', 'completionMs', 'firstAudibleMs', 'modelRequestToFirstAudibleMs', 'speechEndToRequestMs', 'askStartToFirstAudibleMs', 'firstEventToTextMs', 'firstTextToSentenceMs', 'sentenceToAudibleMs', 'firstTtsMs', 'firstPcmMs', 'firstOpusMs', 'spokenAudioMs', 'turnBusyMs', 'streamWaitMs'];
const byModel: Record<string, any> = Object.fromEntries([sol, terra].map(model => {
  const rows = trials.filter(t => t.model === model);
  const success = rows.filter(t => t.successful);
  const spoken = success.filter(t => t.expectedSpeak && t.reply?.speak && t.firstAudibleMs !== null);
  return [model, { attempted: rows.length, successful: success.length,
    failures: rows.filter(t => !t.successful).map(t => ({ id: t.id, error: t.error, code: t.errorCode, firstAudibleMs: t.firstAudibleMs })),
    expectedSpoken: rows.filter(t => t.expectedSpeak).length, spoken: spoken.length,
    wrongParticipation: success.filter(t => t.reply?.speak !== t.expectedSpeak).map(t => t.id),
    zeroReasoning: success.filter(t => t.reasoningTokens === 0).length,
    replyChars: stats(spoken.map(t => t.reply.text.length)),
    retries: rows.filter(t => t.requests.length > 1).length,
    deliberatePlaybackCuts: rows.filter(t => t.playbackTruncated).map(t => t.id),
    metrics: Object.fromEntries(metrics.map(k => [k, stats(spoken.map(t => t[k]))])),
    headerMs: stats(rows.flatMap(t => t.requests.map((r: any) => r.headersMs))),
    cachedFraction: success.reduce((sum, t) => sum + (t.cachedTokens ?? 0), 0) / Math.max(1, success.reduce((sum, t) => sum + (t.inputTokens ?? 0), 0)),
    totalInputTokens: success.reduce((sum, t) => sum + (t.inputTokens ?? 0), 0),
    totalOutputTokens: success.reduce((sum, t) => sum + (t.outputTokens ?? 0), 0),
  }];
}));
const pairIds = [...new Set(trials.map(t => t.pair))] as string[];
const pairs = pairIds.map(pair => {
  const s = trials.find(t => t.pair === pair && t.model === sol), t = trials.find(t => t.pair === pair && t.model === terra);
  const network = probes.filter(p => p.pair === pair);
  const matched = !!s && !!t && !!s.requests.length && !!t.requests.length && s.requests[0].inputHash === t.requests[0].inputHash;
  const complete = !!s?.successful && !!t?.successful;
  // Threshold chosen before inspecting aggregate results. This is only an
  // exploratory sensitivity cut; catalog calls also include server time.
  const stableConnectivity = network.length === 2 && network.every(p => !p.error && p.status === 200 && p.elapsedMs <= 2500);
  const sCache = (s?.cachedTokens ?? 0) / Math.max(1, s?.inputTokens ?? 0), tCache = (t?.cachedTokens ?? 0) / Math.max(1, t?.inputTokens ?? 0);
  return { pair, fixture: s?.fixture ?? t?.fixture, round: s?.round ?? t?.round, complete, matched,
    expectedSpeak: s?.expectedSpeak ?? t?.expectedSpeak,
    bothSpoke: !!s?.reply?.speak && !!t?.reply?.speak,
    stableConnectivity,
    solCachedFraction: sCache, terraCachedFraction: tCache,
    coldBoth: s?.cachedTokens === 0 && t?.cachedTokens === 0,
    warmBoth: s?.cachedTokens > 0 && t?.cachedTokens > 0,
    similarCache: Math.abs(sCache - tCache) <= 0.15,
    solFirst: s?.order === 1,
    delta: Object.fromEntries(metrics.map(k => [k, typeof s?.[k] === 'number' && typeof t?.[k] === 'number' ? t[k] - s[k] : null])),
    sol: s?.id, terra: t?.id,
  };
});
let rng = 941938;
function random() { rng ^= rng << 13; rng ^= rng >>> 17; rng ^= rng << 5; return (rng >>> 0) / 4294967296; }
function compare(rows: typeof pairs, key: string) {
  const valid = rows.filter(p => p.complete && p.matched && p.expectedSpeak && p.bothSpoke && typeof p.delta[key] === 'number');
  const values = valid.map(p => p.delta[key] as number);
  const cases = [...new Set(valid.map(p => p.fixture))];
  const samples: number[] = [];
  if (cases.length >= 5) for (let i = 0; i < 10000; i++) {
    const resampled: number[] = [];
    for (let c = 0; c < cases.length; c++) {
      const chosen = cases[Math.floor(random() * cases.length)];
      resampled.push(...valid.filter(p => p.fixture === chosen).map(p => p.delta[key] as number));
    }
    samples.push(quantile(resampled, .5)!);
  }
  return { ...stats(values), terraFaster: values.filter(v => v < 0).length, solFaster: values.filter(v => v > 0).length, ties: values.filter(v => v === 0).length,
    medianDelta95ClusterBootstrap: samples.length ? [quantile(samples, .025), quantile(samples, .975)] : null,
  };
}
const groups: Record<string, typeof pairs> = {
  all: pairs,
  stableConnectivity: pairs.filter(p => p.stableConnectivity),
  coldBoth: pairs.filter(p => p.coldBoth),
  warmBoth: pairs.filter(p => p.warmBoth),
  similarCache: pairs.filter(p => p.similarCache),
  fixedWording: pairs.filter(p => p.fixture.startsWith('fixed-')),
  longerContext: pairs.filter(p => p.fixture.startsWith('long-')),
  round1: pairs.filter(p => p.round === 1), round2: pairs.filter(p => p.round === 2),
  solFirst: pairs.filter(p => p.solFirst), terraFirst: pairs.filter(p => !p.solFirst),
};
const analysis = { directory, trials: trials.length, pairCount: pairs.length,
  successfulMatchedSpokenPairs: pairs.filter(p => p.complete && p.matched && p.expectedSpeak && p.bothSpoke).length,
  mismatchedPairs: pairs.filter(p => !p.matched).map(p => p.pair),
  byModel,
  comparisons: Object.fromEntries(Object.entries(groups).map(([name, rows]) => [name, Object.fromEntries(metrics.map(k => [k, compare(rows, k)]))])),
  network: { probes: probes.length, failed: probes.filter(p => p.error || p.status !== 200).length, elapsedMs: stats(probes.filter(p => !p.error && p.status === 200).map(p => p.elapsedMs)) },
  pairs,
  notes: ['Deltas are Terra minus Sol; negative favors Terra.', 'Statistics use successful expected-spoken trials; failures and wrong participation are reported separately.', 'Successful means completed inference and, for speak=true, audible onset. Playback can be deliberately cut after 12 seconds following onset, only when inference has completed; cuts are reported and excluded from spokenAudioMs/turnBusyMs. First-onset metrics are unaffected.', 'Bootstrap resamples whole fixture clusters, retaining both rounds. Exploratory interval: small synthetic workload, temporally correlated network. No interval is shown for fewer than five distinct fixture clusters.', 'Catalog probes are end-to-end connectivity controls, not pure network RTT. Do not subtract them from inference.', 'First audible dispatch is a decoded Opus frame with RMS>=0.003, before Discord transit and listener jitter buffer.', 'Repeated scenario contexts are fresh sessions with identical input payloads across models; timestamps/session metadata canonicalized. Not a human quality preference study.'],
};
await writeFile(resolve(directory, 'analysis.json'), JSON.stringify(analysis, null, 2));
const csvColumns = ['id', 'pair', 'round', 'order', 'model', 'fixture', 'expectedSpeak', 'successful', ...metrics, 'firstDispatchMs', 'firstPlayerMs', 'inputTokens', 'cachedTokens', 'outputTokens', 'reasoningTokens', 'errorCode', 'error'];
const quote = (v: unknown) => '"' + String(v ?? '').replaceAll('"', '""') + '"';
await writeFile(resolve(directory, 'trials.csv'), csvColumns.join(',') + '\n' + trials.map(t => csvColumns.map(k => quote(t[k])).join(',')).join('\n') + '\n');
const quality = method.fixtures.map((f: any) => {
  const responses = trials.filter(t => t.fixture === f.id).map(t => ({ trial: t.id, model: t.model, success: t.successful, speak: t.reply?.speak, text: t.reply?.text, transcript: t.transcript }));
  return { fixture: f.id, question: f.question, expectedSpeak: f.speak, rubric: f.rubric, responses };
});
await writeFile(resolve(directory, 'quality-responses.json'), JSON.stringify(quality, null, 2));
const sec = (n: number | null) => n === null ? '—' : (n / 1000).toFixed(2) + ' s';
const md = [
  '# Sol vs Terra voice benchmark', '',
  `Run: ${method.at}. ${trials.length} calls; ${pairs.length} pairs; ${analysis.successfulMatchedSpokenPairs} successful matched spoken pairs. Both models: low reasoning, standard service tier.`, '',
  '| Measurement (median / p90) | GPT-6.1 Sol | GPT-6.1 Terra |', '|---|---:|---:|',
  ...metrics.map(k => `| ${k} | ${sec(byModel[sol].metrics[k].median)} / ${sec(byModel[sol].metrics[k].p90)} | ${sec(byModel[terra].metrics[k].median)} / ${sec(byModel[terra].metrics[k].p90)} |`), '',
  'Paired deltas are Terra minus Sol (negative is faster).', '',
  '| Subset | Pairs | Median first-audible delta | 95% fixture-cluster bootstrap interval | Terra faster |', '|---|---:|---:|---|---:|',
  ...Object.entries(analysis.comparisons).map(([name, values]) => {
    const v = values.firstAudibleMs!;
    return `| ${name} | ${v.n} | ${sec(v.median)} | ${v.medianDelta95ClusterBootstrap?.map(sec).join(' to ') ?? '—'} | ${v.terraFaster}/${v.n} |`;
  }), '',
  '## Scope and limitations', '', method.scope, '',
  ...analysis.notes.map(s => '- ' + s), '',
  `Sol failures: ${byModel[sol].failures.length}/${byModel[sol].attempted}. Terra failures: ${byModel[terra].failures.length}/${byModel[terra].attempted}.`,
  `Connectivity probes: ${analysis.network.failed}/${analysis.network.probes} failed; median ${sec(analysis.network.elapsedMs.median)}, max ${sec(analysis.network.elapsedMs.max)}.`,
  `Input mismatches: ${analysis.mismatchedPairs.join(', ') || 'none'}.`, '',
  'Synthetic prompts and full replies: quality-responses.json. Raw attempts, timings, usage and failures: trials.jsonl. Flat measurements: trials.csv. Generated input and reply audio: *.wav.', '',
];
await writeFile(resolve(directory, 'report.md'), md.join('\n'));
const chartData = pairs.filter(p => p.complete && p.matched && p.expectedSpeak && p.bothSpoke).map(p => ({
  pair: p.pair, fixture: p.fixture, round: p.round, stable: p.stableConnectivity,
  sol: trials.find(t => t.id === p.sol), terra: trials.find(t => t.id === p.terra),
})).map(p => ({ ...p, sol: Object.fromEntries(metrics.map(k => [k, p.sol[k]])), terra: Object.fromEntries(metrics.map(k => [k, p.terra[k]])) }));
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
:root{font-family:var(--font-sans);color:var(--foreground)}body{margin:0}h2{font-size:17px;margin:0 0 8px}p{font-size:12px;line-height:1.5;color:var(--muted-foreground);margin:6px 0 14px}.controls{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}select{font:inherit;font-size:12px;color:var(--foreground);background:var(--secondary);border:1px solid var(--border);border-radius:var(--radius);padding:6px}.summary{display:grid;grid-template-columns:1fr 1fr;gap:12px}.box{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:16px}.big{font-size:25px;font-weight:650;margin:5px 0}.small{font-size:12px;color:var(--muted-foreground)}.sol{color:var(--chart-1)}.terra{color:var(--chart-2)}.legend{display:flex;gap:18px;font-size:12px;margin:14px 0 6px}.key{width:9px;height:9px;border-radius:50%;display:inline-block;margin-right:5px}svg{width:100%;display:block}#graph{height:575px}text{font-family:var(--font-sans);fill:var(--foreground);font-size:11px}.note{border-top:1px solid var(--border);padding-top:10px;margin-top:10px}
</style></head><body><h2>Sol vs Terra · measured voice latency</h2><p>${trials.length} real Plus calls · ${pairs.length} matched pairs · low reasoning · October 27, 2026</p><div class="controls"><select id="metric" aria-label="Measurement"><option value="firstAudibleMs">Speech end → audible dispatch</option><option value="firstTextMs">Request → first text</option><option value="firstSentenceMs">Request → first sentence</option><option value="completionMs">Request → completed response</option></select><select id="round" aria-label="Round"><option value="all">Both passes</option><option value="1">Pass 1</option><option value="2">Pass 2</option></select><select id="network" aria-label="Connectivity subset"><option value="all">All connectivity conditions</option><option value="stable">Both probes ≤2.5 s</option></select></div><div class="summary"><div class="box"><div class="small sol">GPT-6.1 Sol</div><div id="sMedian" class="big"></div><div id="sTail" class="small"></div></div><div class="box"><div class="small terra">GPT-6.1 Terra</div><div id="tMedian" class="big"></div><div id="tTail" class="small"></div></div></div><p id="paired"></p><div class="legend"><span><i class="key" style="background:var(--chart-1)"></i>Sol</span><span><i class="key" style="background:var(--chart-2)"></i>Terra</span><span>Each line joins the same question and pass.</span></div><div id="graph"></div><p class="note">${byModel[sol].failures.length}/${byModel[sol].attempted} Sol failures; ${byModel[terra].failures.length}/${byModel[terra].attempted} Terra failures. ${analysis.network.failed}/${analysis.network.probes} connectivity probes failed. Silence cases have no audible onset and are excluded from this plot.<br>Actual endpointing, STT, Plus inference, TTS, encoding and Discord scheduler. Stops at local non-silent Opus dispatch; Discord transit and listener buffering are additional. Fixed and longer-context cases are included. Small synthetic workload; today's proxy conditions apply.</p><script>
const data=${JSON.stringify(chartData).replaceAll('<', '\\u003c')};
const $=s=>document.getElementById(s);const q=(a,p)=>{a=a.slice().sort((x,y)=>x-y);if(!a.length)return null;const i=(a.length-1)*p;return a[Math.floor(i)]+(a[Math.ceil(i)]-a[Math.floor(i)])*(i-Math.floor(i))};const seconds=n=>n===null?'—':(n/1000).toFixed(2)+' s';
function draw(){const k=$('metric').value,r=$('round').value,n=$('network').value;const rows=data.filter(d=>(r==='all'||d.round===+r)&&(n==='all'||d.stable)&&typeof d.sol[k]==='number'&&typeof d.terra[k]==='number');const s=rows.map(d=>d.sol[k]),t=rows.map(d=>d.terra[k]);$('sMedian').textContent=seconds(q(s,.5));$('tMedian').textContent=seconds(q(t,.5));$('sTail').textContent='median · p90 '+seconds(q(s,.9));$('tTail').textContent='median · p90 '+seconds(q(t,.9));const delta=q(rows.map(d=>d.terra[k]-d.sol[k]),.5);$('paired').textContent=rows.length+' matched spoken pairs; Terra faster in '+rows.filter(d=>d.terra[k]<d.sol[k]).length+'. Median paired change: '+(delta!==null&&delta>0?'+':'')+seconds(delta)+' (Terra minus Sol).';const max=Math.ceil(Math.max(1000,...s,...t)/1000)*1000;const left=145,right=665,w=right-left,h=Math.max(90,rows.length*23+44);$('graph').style.height=h+'px';let out='<svg viewBox="0 0 710 '+h+'" role="img" aria-label="Paired model latency chart">';for(let i=0;i<=4;i++){const x=left+w*i/4;out+='<line x1="'+x+'" x2="'+x+'" y1="17" y2="'+(h-20)+'" stroke="var(--border)"/><text x="'+x+'" y="12" text-anchor="middle">'+(max*i/4000).toFixed(1)+' s</text>'}rows.forEach((d,i)=>{const y=32+i*23,a=left+w*d.sol[k]/max,b=left+w*d.terra[k]/max;out+='<text x="0" y="'+(y+4)+'">'+d.fixture+' · '+d.round+'</text><line x1="'+a+'" x2="'+b+'" y1="'+y+'" y2="'+y+'" stroke="var(--muted-foreground)"/><circle cx="'+a+'" cy="'+y+'" r="4" fill="var(--chart-1)"><title>Sol '+seconds(d.sol[k])+'</title></circle><circle cx="'+b+'" cy="'+y+'" r="4" fill="var(--chart-2)"><title>Terra '+seconds(d.terra[k])+'</title></circle>'});$('graph').innerHTML=out+'</svg>'}['metric','round','network'].forEach(id=>$(id).addEventListener('change',draw));draw();
</script></body></html>`;
await writeFile(resolve(directory, 'comparison.html'), html);
console.log(JSON.stringify({ directory, trials: analysis.trials, pairCount: analysis.pairCount, byModel: analysis.byModel, comparisons: analysis.comparisons.all, network: analysis.network, mismatchedPairs: analysis.mismatchedPairs }, null, 2));
