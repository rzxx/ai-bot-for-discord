import type { LatencyRecord } from './telemetry';
import type { TokenSource } from './token-accounting';

const names = ['search', 'activity', 'members', 'message', 'remind', 'cancel_reminder', 'reminders', 'chat'];
const number = (row: LatencyRecord | undefined, key: string) => typeof row?.[key] === 'number' ? row[key] as number : 0;
const requestKey = (r: LatencyRecord) => `${r.session}:${r.request ?? `t${r.turn}:a${r.attempt ?? 0}`}`;
const turnKey = (r: LatencyRecord) => `${r.session}:${r.turn}`;
function sources(row: LatencyRecord): TokenSource[] {
  try {
    const value = JSON.parse(String(row.sourceTokens));
    return Array.isArray(value) ? value.filter(r => typeof r.source === 'string' && Number.isFinite(r.tokens) && Number.isFinite(r.bytes)) : [];
  } catch { return []; }
}

/** Distinguish result size, retained text, repeated exposure and the actual
 * model usage of tool-triggered turns. Never split a provider bill by byte ratio. */
export function usageAttribution(records: LatencyRecord[]) {
  records = records.filter(r => r.purpose !== 'report');
  const starts = records.filter(r => r.stage === 'request_started');
  const ends = new Map(records.filter(r => r.stage === 'request_ended').map(r => [requestKey(r), r]));
  const turns = new Map(records.filter(r => r.stage === 'turn_started').map(r => [turnKey(r), r]));
  const measurements = records.filter(r => r.stage === 'context_tokens');
  const payloads = records.filter(r => r.stage === 'tool_payload_tokens');
  const receipts = records.filter(r => r.stage === 'tool_receipt');
  const byTool = names.map(tool => {
    const results = receipts.filter(r => r.tool === tool);
    const attemptedPayloadByteReferences = results.reduce((total, result) => {
      const after = records.indexOf(result);
      const references = records.slice(after + 1).filter(r => r.session === result.session && r.stage === 'request_started').length;
      return total + references * number(result, 'bytes');
    }, 0);
    const tokens = payloads.filter(r => r.tool === tool && r.kind === 'result' && r.direction === 'input');
    const calls = payloads.filter(r => r.tool === tool && r.kind === 'call' && r.direction === 'output');
    const fieldSizes = new Map<string, { field: string; bytes: number; standaloneValueTokens: number }>();
    for (const payload of tokens) {
      try { for (const field of JSON.parse(String(payload.fieldSizes))) {
        if (typeof field.field !== 'string' || !Number.isFinite(field.tokens) || !Number.isFinite(field.bytes)) continue;
        const row = fieldSizes.get(field.field) ?? { field: field.field, bytes: 0, standaloneValueTokens: 0 };
        row.bytes += field.bytes; row.standaloneValueTokens += field.tokens; fieldSizes.set(field.field, row);
      } } catch { /* Legacy logs omit field sizes. */ }
    }
    return { tool, executions: records.filter(r => r.stage === 'tool_job_started' && r.tool === tool).length,
      returnedResults: results.length, returnedResultBytes: results.reduce((n, r) => n + number(r, 'bytes'), 0),
      attemptedPayloadByteReferences,
      tokenizedResults: tokens.length, resultPayloadTokens: tokens.length || !results.length ? tokens.reduce((n, r) => n + number(r, 'tokens'), 0) : null,
      tokenizedCalls: calls.length, generatedCallTextTokens: calls.length ? calls.reduce((n, r) => n + number(r, 'tokens'), 0) : null,
      resultFields: [...fieldSizes.values()],
      latestRetainedResultTextTokens: null as number | null, cumulativeResultTokenReferences: measurements.length ? 0 : null as number | null,
      followupRequests: 0, inferredFollowupRequests: 0, followupInputTokens: 0, followupCachedTokens: 0, followupOutputTokens: 0,
      followupReasoningTokens: 0, followupReasoningKnownRequests: 0,
      followupUnknownUsage: 0, followupCacheUnknownRequests: 0 };
  });
  const categories = new Map<string, { source: string; latestTextTokens: number; cumulativeTokenReferences: number }>();
  const latestBySession = new Map<string, LatencyRecord>();
  for (const row of measurements) {
    const previous = latestBySession.get(row.session);
    if (!previous || Number(row.request ?? row.turn ?? 0) >= Number(previous.request ?? previous.turn ?? 0)) latestBySession.set(row.session, row);
  }
  for (const row of measurements) for (const source of sources(row)) {
    const aggregate = categories.get(source.source) ?? { source: source.source, latestTextTokens: 0, cumulativeTokenReferences: 0 };
    aggregate.cumulativeTokenReferences += source.tokens;
    if (latestBySession.get(row.session) === row) aggregate.latestTextTokens += source.tokens;
    categories.set(source.source, aggregate);
  }
  for (const tool of byTool) {
    const result = categories.get(`tool_result:${tool.tool}`);
    if (measurements.length) { tool.latestRetainedResultTextTokens = result?.latestTextTokens ?? 0; tool.cumulativeResultTokenReferences = result?.cumulativeTokenReferences ?? 0; }
  }
  const followups: { session: string; turn?: number; tool: string; attribution: string; inputTokens: number | null; cachedTokens: number | null; outputTokens: number | null }[] = [];
  const previousBySession = new Map<string, LatencyRecord>();
  for (const start of starts) {
    const previous = previousBySession.get(start.session); previousBySession.set(start.session, start);
    const turn = turns.get(turnKey(start));
    let tool: string | undefined, attribution = '';
    if (turn?.triggerMode === 'tool' && names.includes(String(turn.triggerTools))) { tool = String(turn.triggerTools); attribution = 'explicit_trigger'; }
    else if (turn?.triggerMode === undefined && start.appendedSpeech === 0 && start.appendedTools === 1 && previous) {
      // Old logs lack trigger IDs. Expose the narrower observed association,
      // rather than silently claiming the same certainty as explicit triggers.
      const candidates = receipts.filter(r => r.session === start.session && r.wakesModel && String(r.at) > String(previous.at) && String(r.at) <= String(start.at));
      if (candidates.length === 1 && names.includes(String(candidates[0]!.tool))) { tool = String(candidates[0]!.tool); attribution = 'legacy_isolated_tool_turn'; }
    }
    if (!tool) continue;
    const aggregate = byTool.find(r => r.tool === tool)!, end = ends.get(requestKey(start));
    aggregate.followupRequests++;
    if (attribution !== 'explicit_trigger') aggregate.inferredFollowupRequests++;
    const known = typeof end?.inputTokens === 'number' && typeof end?.outputTokens === 'number';
    if (known) {
      aggregate.followupInputTokens += number(end, 'inputTokens');
      if (typeof end?.cachedTokens === 'number') aggregate.followupCachedTokens += end.cachedTokens;
      else aggregate.followupCacheUnknownRequests++;
      aggregate.followupOutputTokens += number(end, 'outputTokens');
      if (typeof end?.reasoningTokens === 'number') { aggregate.followupReasoningTokens += end.reasoningTokens; aggregate.followupReasoningKnownRequests++; }
    } else aggregate.followupUnknownUsage++;
    followups.push({ session: start.session, turn: start.turn, tool, attribution,
      inputTokens: known ? number(end, 'inputTokens') : null, cachedTokens: typeof end?.cachedTokens === 'number' ? end.cachedTokens : null,
      outputTokens: known ? number(end, 'outputTokens') : null });
  }
  const reconciliation = [...latestBySession.values()].map(row => {
    const usage = ends.get(requestKey(row));
    return { session: row.session, request: row.request, visibleTextTokens: number(row, 'visibleTextTokens'),
      providerInputTokens: typeof usage?.inputTokens === 'number' ? usage.inputTokens : null,
      providerFramingAndUnattributedTokens: typeof usage?.inputTokens === 'number' ? usage.inputTokens - number(row, 'visibleTextTokens') : null };
  });
  return { byTool: byTool.map(t => ({ ...t, followupNonCachedInputTokens: t.followupCacheUnknownRequests ? null : t.followupInputTokens - t.followupCachedTokens })), categories: [...categories.values()].sort((a, b) => b.latestTextTokens - a.latestTextTokens), followups, reconciliation,
    tokenizer: measurements.length ? 'o200k_base' : null, tokenizedRequests: measurements.length,
    droppedMeasurements: records.filter(r => r.stage === 'token_accounting_dropped').length,
    mixedOrMultipleToolRequests: starts.filter(start => { const t = turns.get(turnKey(start)); return t?.triggerMode === 'mixed' || t?.triggerMode === 'tool' && String(t.triggerTools).includes(','); }).length,
    note: 'BPE text counts use o200k_base; payload counts tokenize the exact standalone JSON. Wire-source tokens are assigned once by starting byte. Repeated token references are not new context or a separate bill. Follow-up usage includes the whole retained conversation; old-log associations are explicitly marked. Hidden message framing/opaque reasoning and canceled usage remain separate.' };
}
