import { t } from '../src/locale';
import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { LOCAL } from '../src/config';
import { parseDiagnostics, diagnosticsReport } from '../src/diagnostics-report';

const args = process.argv.slice(2);
const argument = args.find(a => !a.startsWith('--'));
let path = argument ? resolve(argument) : '';
if (!path) {
  const candidates = await Promise.all((await readdir(LOCAL)).filter(n => /^latency-.*\.jsonl$/.test(n)).map(async n => {
    const path = resolve(LOCAL, n), info = await stat(path);
    return { path, size: info.size, at: info.mtimeMs };
  }));
  path = candidates.filter(c => c.size > 0).sort((a, b) => b.at - a.at)[0]?.path ?? '';
}
if (!path) throw new Error(t("No diagnostic log yet. Start your next run with bun run start:diagnostic."));
let records = parseDiagnostics(await readFile(path, 'utf8'));
const session = args.find(a => a.startsWith('--session='))?.slice('--session='.length);
if (session) {
  const id = session === 'latest' ? records.filter(r => r.stage === 'turn_started').at(-1)?.session : session;
  records = records.filter(r => r.session === id || r.session === 'runtime');
  if (!records.some(r => r.session === id)) throw new Error(t("No records for the requested voice session."));
}
const report = diagnosticsReport(records);
if (args.includes('--json')) console.log(JSON.stringify({ file: path, ...report }, null, 2));
else {
  const m = report.model, c = report.context, s = report.speech;
  const window = c.sessions.find(row => row.session === c.latestSession);
  console.log(t("File: {0}\nRange: {1} — {2}", path, report.firstAt, report.lastAt));
  if (window?.lastInputTokens !== null && window?.lastInputTokens !== undefined) {
    console.log(t("WHOLE CONTEXT on the last reported request: {0} input tokens. First request: {1}; growth: {2}; last response: {3} output tokens.", window.lastInputTokens, window.firstInputTokens, window.inputGrowthTokens, window.lastOutputTokens ?? 'unknown'));
    console.log(t("This session: {0} requests with input usage; average input {1} tokens per request.", window.reportedRequests, Math.round(window.averageInputTokens!)));
    console.log(t("Content/sidecar breakdown recorded on {0}/{1} reported requests. Dropped input/output token measurements: {2}.", window.partitionedRequests, window.reportedRequests, window.droppedTokenMeasurements));
    if (window.breakdown) {
      console.table(window.breakdown.map(row => ({ contextPart: row.source, retainedTokens: row.tokens, bytes: row.bytes })));
      console.log(t("Breakdown sum: {0}; visible text: {1}; matches: {2}. Provider framing/unattributed: {3} tokens.", window.breakdownTokenTotal, window.visibleTextTokens, window.breakdownMatchesVisibleText, window.providerFramingAndUnattributedTokens ?? 'unknown'));
    }
    else if (window.sources) console.table(window.sources.map(row => ({ contextSource: row.source, retainedTokens: row.tokens, bytes: row.bytes })));
    else console.log(t("Context composition by instructions/people/bot/tools was not recorded in this older run."));
    if (window.contributors) {
      console.table(window.contributors.map(row => ({ contributor: row.kind === 'assistant' ? 'bot generated replies' : `${row.person ?? 'unattributed'} ${row.kind}`,
        entries: row.events, contentTokensAsSent: row.contentWireTokens ?? 'not recorded',
        toolCallTokens: row.toolCallWireTokens ?? (row.kind === 'assistant' ? 'not recorded' : 0),
        sidecarTokens: row.contentWireTokens !== undefined && (row.kind !== 'assistant' || row.toolCallWireTokens !== undefined)
          ? row.wireTokens - row.contentWireTokens - (row.toolCallWireTokens ?? 0) : 'not recorded',
        totalStoredTokens: row.wireTokens })));
      console.log(t("For each contributor: content + tool calls + local event/decision sidecar = total stored tokens. Unescaped word counts are a separate view in --json; provider framing stays separate."));
    }
    if (window.largestAdditions.length) {
      console.log(t("Largest additions since the preceding measured request (first request includes startup instructions):"));
      console.table(window.largestAdditions.slice(0, 5).map(row => ({ turn: row.turn, request: row.request, addedTokens: row.appendedVisibleTextTokens,
        largestPart: [...row.appendedBreakdown ?? []].sort((a, b) => b.tokens - a.tokens)[0]?.source ?? 'not recorded',
        people: (row.appendedContributors ?? []).filter(p => p.kind !== 'assistant').map(p => `${p.person ?? '?'}:${p.kind}`).join(',') })));
    }
  } else console.log(t("Whole context size: no provider input usage recorded yet."));
  console.log(t("Model attempts: {0}; retries: {1}; peak in 60 seconds: {2}.", m.attempts, m.retries, m.peakRequestsPerMinute));
  console.log(t("CUMULATIVE REQUEST TRAFFIC (recounts old context every request): input {0}; cached {1}; non-cached {2}; generated output {3}; reasoning {4}.", m.reportedInputTokens, m.reportedCachedTokens ?? 'unknown', m.reportedNonCachedInputTokens ?? 'unknown', m.reportedOutputTokens, m.reportedReasoningTokens ?? 'unknown'));
  console.log(t("Usage missing for {0} attempts. {1}", m.requestsWithUnknownUsage, m.note));
  console.log(t("Model outcomes:"), m.outcomes, 'Errors:', m.errors);
  console.log(c.measuredRequests ? `Context appended: ${c.appendedBytes} bytes; speech ${c.speechEvents}; chat ${c.chatEvents}; tools ${c.toolEvents}; state changes ${c.stateUpdates}. Prefix changes: ${c.changedPrefixes}/${c.checkedPrefixes} checked.` : 'No measured context additions in this log.');
  console.log(t("Tool proposals:"), report.tools.proposed, 'Receipts:', report.tools.receipts, 'Rejected:', report.tools.rejected);
  console.table(report.attribution.byTool.map(t => ({ tool: t.tool, executions: t.executions, resultBytes: t.returnedResultBytes,
    resultTokens: t.resultPayloadTokens ?? 'not recorded', retainedTokens: t.latestRetainedResultTextTokens ?? 'not recorded',
    generatedCallTokens: t.generatedCallTextTokens ?? 'not recorded' })));
  console.log(t("Tool follow-up traffic in --json includes the whole conversation on those requests. It is not the size of tool results."));
  console.log(report.attribution.note);
  if (report.presence.lastObserved) console.log(t("Last presence observation:"), report.presence.lastLookup ?? report.presence.lastObserved);
  console.log(t("Audio: {0} measured chunks; near-silent PCM {1}; near-silent decoded Opus {2}; outbound packets {3}.", s.signalChunks, s.nearSilentPcmChunks, s.nearSilentDecodedChunks, s.dispatchedPackets ?? 'not measured'));
  console.log(s.note);
  for (const [label, row] of Object.entries({ lastModelFailure: m.lastFailure, lastTurnFailure: s.lastTurnFailure,
    lastSignal: s.lastSignal, lastPlayback: s.lastPlayback, lastHealth: s.lastHealth })) if (row) console.log(label, row);
  if (!report.log.diagnosticMode) console.log(t("Deep diagnostics were not enabled. Next run: bun run start:diagnostic."));
}
