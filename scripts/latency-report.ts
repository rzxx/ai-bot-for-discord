import { t } from '../src/locale';
import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { LOCAL } from '../src/config';
import type { LatencyRecord } from '../src/telemetry';

const args = process.argv.slice(2);
const argument = args.find(value => !value.startsWith('--'));
const requestedSession = args.find(value => value.startsWith('--session='))?.slice('--session='.length);
let path = argument ? resolve(argument) : '';
if (!path) {
  const files = await Promise.all((await readdir(LOCAL)).filter(name => /^latency-.*\.jsonl$/.test(name)).map(async name => {
    const path = resolve(LOCAL, name); return { path, modified: (await stat(path)).mtimeMs };
  }));
  path = files.sort((a, b) => b.modified - a.modified)[0]?.path ?? '';
}
if (!path) throw new Error(t("No latency log yet. New timing logs begin after the next approved bot restart."));
let records: LatencyRecord[] = [];
for (const line of (await readFile(path, 'utf8')).split(/\r?\n/)) {
  const json = line.includes('[latency] ') ? line.split('[latency] ')[1]! : line;
  try { const record = JSON.parse(json); if (record.session && record.stage) records.push(record); } catch { /* Other console output or an unfinished last line. */ }
}
let session: string | undefined;
if (requestedSession) {
  const starts = new Map<string, number>();
  for (const record of records) {
    const at = Date.parse(String(record.at));
    if (Number.isFinite(at)) starts.set(record.session, Math.min(starts.get(record.session) ?? Infinity, at));
  }
  session = requestedSession === 'latest' ? [...starts].sort((a, b) => b[1] - a[1])[0]?.[0] : requestedSession;
  records = records.filter(record => record.session === session);
  if (!records.length) throw new Error(t("No records for the requested voice session."));
}
const turnKey = (record: LatencyRecord) => `${record.session}:${record.turn}`;
const localTurns = new Set(records.filter(r => r.stage === 'turn_started' && r.localReply).map(turnKey));
function stats(stage: string, field: string, predicate: (record: LatencyRecord) => boolean = () => true) {
  const values = records.filter(r => r.stage === stage && predicate(r) && typeof r[field] === 'number').map(r => r[field] as number).sort((a, b) => a - b);
  const n = values.length;
  return { samples: n, medianMs: n ? Math.round((values[Math.floor((n - 1) / 2)]! + values[Math.ceil((n - 1) / 2)]!) / 2) : null,
    p95Ms: n ? values[Math.ceil(n * 0.95) - 1] : null, maxMs: n ? values[n - 1] : null };
}
const response = (record: LatencyRecord) => !record.compaction;
const completed = records.filter(r => r.stage === 'playback_finished');
const report = {
  file: path, ...(session ? { session } : {}), records: records.length, turns: records.filter(r => r.stage === 'turn_started').length,
  spoken: completed.filter(r => r.completed).length, interrupted: completed.filter(r => !r.completed).length,
  conversation: {
    earlyEndpoints: records.filter(r => r.stage === 'endpoint_preview' && r.accepted).length,
    localReplies: records.filter(r => r.stage === 'turn_started' && r.localReply).length,
    thinkingCues: records.filter(r => r.stage === 'thinking_cue_audio').length,
    revisions: records.filter(r => r.stage === 'reply_revised').length,
    yielded: records.filter(r => r.stage === 'reply_yielded').length,
    withheld: records.filter(r => r.stage === 'reply_withheld').length,
  },
  transports: Object.fromEntries([...new Set(records.filter(r => r.stage === 'transport_selected').map(r => r.transport as string))].map(transport => [transport, records.filter(r => r.stage === 'transport_selected' && r.transport === transport).length])),
  preparationReasons: Object.fromEntries([...new Set(records.filter(r => r.stage === 'turn_started' && r.triggerReason).map(r => r.triggerReason as string))].map(reason => [reason, records.filter(r => r.stage === 'turn_started' && r.triggerReason === reason).length])),
  metrics: {
    'Speech endpoint detection': stats('utterance_ready', 'endpointMs'),
    'Early endpoint probe (conversion and STT)': stats('endpoint_preview', 'elapsedMs'),
    'Ready audio waiting for a speaking opportunity': stats('floor_acquired', 'elapsedMs'),
    'STT queue': stats('stt_started', 'queueMs'),
    'Input conversion': stats('input_converted', 'elapsedMs'),
    'STT inference': stats('stt_completed', 'elapsedMs'),
    'Speech end → model request (includes endpoint/STT/quiet/busy waits)': stats('turn_started', 'sinceSpeechEndMs'),
    'Turn start → first model text': stats('first_text', 'sinceTurnMs', response),
    'Turn start → first usable sentence': stats('first_sentence', 'sinceTurnMs', response),
    'Turn start → completed model response': stats('model_completed', 'sinceTurnMs', response),
    'TTS per sentence (includes worker queue)': stats('tts_completed', 'elapsedMs'),
    'Output conversion per sentence': stats('pcm_converted', 'elapsedMs'),
    'Opus encoding per sentence': stats('opus_encoded', 'elapsedMs'),
    'Speech end → first Discord playback': stats('first_audio', 'sinceSpeechEndMs'),
    'Model reply: speech end → first Discord playback': stats('first_audio', 'sinceSpeechEndMs', r => !localTurns.has(turnKey(r))),
    'Local reply: speech end → first Discord playback': stats('first_audio', 'sinceSpeechEndMs', r => localTurns.has(turnKey(r))),
    'Waiting for later sentences during playback': stats('playback_finished', 'streamWaitMs'),
  },
  waiting: Object.fromEntries([...new Set(records.filter(r => r.stage === 'turn_waiting').map(r => r.reason as string))].map(reason => [reason, records.filter(r => r.stage === 'turn_waiting' && r.reason === reason).length])),
};
if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
else { console.log(t("File: {0}\nTurns: {1}; spoken: {2}; interrupted: {3}. All durations are milliseconds; stages overlap and must not be added.", report.file, report.turns, report.spoken, report.interrupted)); console.table(report.metrics); console.log(t("Conversation policy:"), report.conversation); console.log(t("Wait observations (sampled at most once per two seconds):"), report.waiting); }
