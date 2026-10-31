import type { LatencyRecord } from './telemetry';
import type { TokenContributor, TokenSource } from './token-accounting';

const key = (r: LatencyRecord) => `${r.session}:${r.request ?? `t${r.turn}:a${r.attempt ?? 0}`}`;
const numeric = (r: LatencyRecord | undefined, field: string) => typeof r?.[field] === 'number' ? r[field] as number : null;
function list<T>(value: unknown, valid: (row: any) => boolean): T[] | null {
  if (typeof value !== 'string') return null;
  try { const rows = JSON.parse(value); return Array.isArray(rows) ? rows.filter(valid) : null; } catch { return null; }
}
const sources = (value: unknown) => list<TokenSource>(value, r => r && typeof r.source === 'string' && Number.isFinite(r.tokens) && Number.isFinite(r.bytes));
const people = (value: unknown) => list<TokenContributor>(value, r => r && ['speech', 'chat', 'assistant'].includes(r.kind)
  && (r.person === undefined || /^u[1-9]\d{0,5}$/.test(r.person))
  && ['events', 'wireBytes', 'wireTokens', 'textBytes', 'textTokens'].every(field => Number.isFinite(r[field])));

/** A context window is a snapshot, not the sum of input on every request.
 * Keep each voice session separate and join worker observations by request ID:
 * a slow observation may be logged after a more recent request has finished. */
export function contextWindowReport(records: LatencyRecord[]) {
  records = records.filter(r => r.purpose !== 'report');
  const ends = records.filter(r => r.stage === 'request_ended');
  const terminal = new Set(ends.map(key));
  const usage = [...ends, ...records.filter(r => r.stage === 'model_completed' && !terminal.has(key(r)))];
  const measured = new Map(records.filter(r => r.stage === 'context_tokens').map(r => [key(r), r]));
  const outputs = new Map(records.filter(r => r.stage === 'response_text_tokens').map(r => [key(r), r]));
  const starts = records.filter(r => r.stage === 'request_started');
  // Older logs can have usage without request_started.
  const startsByKey = new Map(starts.map(r => [key(r), r]));
  const ordered = [...usage].sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')));
  const sessionIds = [...new Set(ordered.map(r => r.session))];
  const sessions = sessionIds.map(session => {
    const rows = ordered.filter(r => r.session === session && numeric(r, 'inputTokens') !== null);
    const timeline = rows.map((r, index) => {
      const start = startsByKey.get(key(r)), observation = measured.get(key(r)), previous = rows[index - 1];
      return { at: r.at ?? null, turn: r.turn ?? null, request: r.request ?? null, outcome: r.outcome ?? 'legacy',
        inputTokens: numeric(r, 'inputTokens')!, cachedTokens: numeric(r, 'cachedTokens'), outputTokens: numeric(r, 'outputTokens'),
        inputGrowthSincePreviousRequest: previous ? numeric(r, 'inputTokens')! - numeric(previous, 'inputTokens')! : null,
        appendedVisibleTextTokens: numeric(observation, 'appendedTextTokens'),
        appendedSources: sources(observation?.appendedSourceTokens),
        appendedBreakdown: sources(observation?.appendedBreakdown), appendedContributors: people(observation?.appendedContributors),
        appendedSpeechEvents: numeric(start, 'appendedSpeech'), appendedChatEvents: numeric(start, 'appendedChat'),
        appendedToolEvents: numeric(start, 'appendedTools'), stateUpdates: numeric(start, 'stateUpdates'), rosterUpdates: numeric(start, 'rosterUpdates') };
    });
    const first = rows[0], last = rows.at(-1), observation = last ? measured.get(key(last)) : undefined;
    const output = last ? outputs.get(key(last)) : undefined;
    const input = timeline.map(r => r.inputTokens), initial = numeric(first, 'inputTokens'), latest = numeric(last, 'inputTokens');
    const visible = numeric(observation, 'visibleTextTokens');
    const totalInput = input.reduce((n, v) => n + v, 0);
    const breakdown = sources(observation?.breakdown);
    const partitionTotal = breakdown?.reduce((n, row) => n + row.tokens, 0) ?? null;
    return { session, firstInputTokens: initial, lastInputTokens: latest, lastOutputTokens: numeric(last, 'outputTokens'),
      inputGrowthTokens: latest !== null && initial !== null ? latest - initial : null,
      lastReportedAt: last?.at ?? null, reportedRequests: rows.length,
      tokenizedRequests: rows.filter(r => measured.has(key(r))).length,
      partitionedRequests: rows.filter(r => typeof measured.get(key(r))?.breakdown === 'string').length,
      droppedTokenMeasurements: records.filter(r => r.session === session && r.stage === 'token_accounting_dropped').length,
      averageInputTokens: input.length ? totalInput / input.length : null,
      cumulativeInputTokens: totalInput,
      visibleTextTokens: visible, sources: sources(observation?.sourceTokens), contributors: people(observation?.contributors),
      breakdown, breakdownTokenTotal: partitionTotal, breakdownMatchesVisibleText: partitionTotal !== null && visible !== null ? partitionTotal === visible : null,
      lastResponseContributors: people(output?.contributors),
      lastResponseBreakdown: sources(output?.breakdown),
      providerFramingAndUnattributedTokens: latest !== null && visible !== null ? latest - visible : null,
      largestAdditions: timeline.filter(r => r.appendedVisibleTextTokens !== null).sort((a, b) => b.appendedVisibleTextTokens! - a.appendedVisibleTextTokens!).slice(0, 10),
      timeline };
  });
  const latestSession = ordered.at(-1)?.session ?? null;
  return { latestSession, sessions,
    note: 'lastInputTokens is the whole input on the last request with reported usage in that voice session. cumulativeInputTokens sums repeated full inputs across requests and is not a context-window size. Breakdown token buckets are disjoint and sum to visibleTextTokens. Contributor contentWireTokens count encoded text values as sent, toolCallWireTokens count action objects, and their remainder in wireTokens is local event/decision metadata. textTokens count standalone unescaped words, a separate non-additive view. Provider framing/unattributed tokens are outside visible text; do not assign that residual to participants. Missing old-log contributions are null.' };
}
