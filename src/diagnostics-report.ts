import type { LatencyRecord } from './telemetry';
import { usageAttribution } from './usage-attribution';
import { contextWindowReport } from './context-report';

export function parseDiagnostics(text: string): LatencyRecord[] {
  return text.split(/\r?\n/).flatMap(line => {
    try {
      const row = JSON.parse(line.includes('[latency] ') ? line.split('[latency] ')[1]! : line);
      return typeof row.session === 'string' && typeof row.stage === 'string' ? [row] : [];
    } catch { return []; } // Reading a live file can encounter an unfinished tail.
  });
}

/** Offline only. Provider-reported usage is never confused with payload bytes,
 * local estimates, account-wide allowance or a confirmed remote audio receipt. */
export function diagnosticsReport(records: LatencyRecord[]) {
  const stage = (name: string) => records.filter(r => r.stage === name);
  const key = (r: LatencyRecord) => `${r.session}:${r.request ?? `turn-${r.turn}-attempt-${r.attempt ?? 0}`}`;
  const ends = stage('request_ended'), terminal = new Set(ends.map(key));
  const usage = [...ends, ...stage('model_completed').filter(r => !terminal.has(key(r)))];
  const startsById = new Map<string, LatencyRecord>();
  for (const r of records) if (r.stage === 'request_started' || r.stage === 'auth_ready') {
    if (!startsById.has(key(r))) startsById.set(key(r), r);
  }
  const starts = [...startsById.values()];
  const withUsage = usage.filter(r => typeof r.inputTokens === 'number' && typeof r.outputTokens === 'number');
  const known = new Set(withUsage.map(key));
  const withCache = withUsage.filter(r => typeof r.cachedTokens === 'number');
  const sum = (rows: LatencyRecord[], field: string) => rows.reduce((n, r) => n + (typeof r[field] === 'number' ? r[field] as number : 0), 0);
  const counts = (rows: LatencyRecord[], field: string) => {
    const out: Record<string, number> = {};
    for (const r of rows) { const name = String(r[field] ?? 'unknown'); out[name] = (out[name] ?? 0) + 1; }
    return out;
  };
  const dates = starts.map(r => Date.parse(String(r.at))).filter(Number.isFinite).sort((a, b) => a - b);
  let left = 0, peakRequestsPerMinute = 0;
  for (let right = 0; right < dates.length; right++) {
    while (dates[right]! - dates[left]! >= 60000) left++;
    peakRequestsPerMinute = Math.max(peakRequestsPerMinute, right - left + 1);
  }
  const additions = stage('request_started').filter(r => r.attempt === 0 && r.purpose !== 'report');
  const audio = stage('opus_signal'), playback = stage('audio_player_finished');
  const max = (rows: LatencyRecord[], field: string) => {
    const values = rows.flatMap(r => typeof r[field] === 'number' ? [r[field] as number] : []);
    return values.length ? Math.max(...values) : null;
  };
  const last = (name: string) => { const r = stage(name).at(-1); return r ? { ...r } : null; };
  const failures = stage('turn_failed');
  return {
    firstAt: records[0]?.at ?? null, lastAt: records.at(-1)?.at ?? null,
    records: records.length,
    reporting: {
      modelAttempts: starts.filter(r => r.purpose === 'report').length,
      modelOutcomes: counts(ends.filter(r => r.purpose === 'report'), 'outcome'),
      events: counts(stage('reporting'), 'status'),
    },
    model: {
      attempts: starts.length, retries: starts.filter(r => Number(r.attempt) > 0).length,
      outcomes: counts(ends, 'outcome'), completedResponses: stage('model_completed').length, peakRequestsPerMinute,
      requestsWithReportedUsage: withUsage.length,
      requestsWithUnknownUsage: starts.filter(r => !known.has(key(r))).length,
      reportedInputTokens: sum(withUsage, 'inputTokens'),
      reportedCachedTokens: withCache.length ? sum(withCache, 'cachedTokens') : null,
      cacheUsageKnownRequests: withCache.length,
      reportedNonCachedInputTokens: withCache.length ? sum(withCache, 'inputTokens') - sum(withCache, 'cachedTokens') : null,
      reportedOutputTokens: sum(withUsage, 'outputTokens'),
      reportedReasoningTokens: usage.some(r => typeof r.reasoningTokens === 'number') ? sum(usage, 'reasoningTokens') : null,
      maxInputTokens: max(withUsage, 'inputTokens'), maxRequestBytes: max(starts, 'bodyBytes'),
      maxOpaqueReasoningBytes: max(starts, 'opaqueReasoningBytes'),
      errors: counts(ends.filter(r => r.errorCode), 'errorCode'), lastFailure: ends.filter(r => r.errorCode).at(-1) ?? null,
      note: 'These are cumulative request-traffic totals: each request counts the retained input again. They are not the context-window size or unique words spoken. Reported usage is a lower bound when attempts lack usage. Cached input still has a usage rate. This log cannot show the remaining account allowance.',
    },
    context: {
      ...contextWindowReport(records),
      measuredRequests: additions.length,
      appendedBytes: additions.length ? sum(additions, 'appendedBytes') : null, speechEvents: additions.length ? sum(additions, 'appendedSpeech') : null,
      chatEvents: additions.length ? sum(additions, 'appendedChat') : null, toolEvents: additions.length ? sum(additions, 'appendedTools') : null,
      stateUpdates: additions.length ? sum(additions, 'stateUpdates') : null, rosterUpdates: additions.length ? sum(additions, 'rosterUpdates') : null,
      checkedPrefixes: starts.filter(r => typeof r.prefixUnchanged === 'boolean').length,
      changedPrefixes: starts.filter(r => r.prefixUnchanged === false).length,
    },
    tools: { observationAvailable: stage('request_started').length > 0, proposed: counts(stage('tool_action_proposed'), 'tool'), receipts: counts(stage('tool_receipt'), 'status'),
      rejected: counts(stage('tool_action_rejected'), 'reason'),
      wakingReceipts: stage('tool_receipt').filter(r => r.wakesModel).length },
    attribution: usageAttribution(records),
    presence: { observations: stage('presence_observed').length, lastObserved: last('presence_observed'),
      lastLookup: stage('presence_observed').filter(r => r.source === 'lookup').at(-1) ?? null },
    speech: { localTtsHttpErrors: stage('tts_job_finished').filter(r => typeof r.status === 'number' && r.status >= 400).map(r => ({ at: r.at, status: r.status, job: r.job })),
      turnFailures: counts(failures, 'errorDomain'), lastTurnFailure: failures.at(-1) ?? null,
      modelSilenceDecisions: stage('reply_decision').filter(r => r.speak === false).length,
      signalChunks: audio.length, nearSilentPcmChunks: audio.filter(r => typeof r.pcmPeak === 'number' && r.pcmPeak <= 32).length,
      nearSilentDecodedChunks: audio.filter(r => typeof r.decodedPeak === 'number' && r.decodedPeak <= 32).length,
      dispatchedPackets: playback.some(r => typeof r.dispatchedPackets === 'number') ? sum(playback, 'dispatchedPackets') : null,
      lastSignal: last('opus_signal'), lastPlayback: last('audio_player_finished'), lastHealth: last('room_health'),
      note: 'Near-silence means peak <=32/32768 (allows codec noise). Player progress and outbound packet counters prove local work only. Discord does not acknowledge audible playback on a listener device.',
    },
    log: { diagnosticMode: stage('diagnostics_started').at(-1)?.diagnosticMode ?? false,
      lastHeartbeat: last('room_health'), localTimingOnly: !stage('request_started').length },
  };
}
