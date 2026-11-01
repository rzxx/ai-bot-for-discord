import { test, expect } from 'bun:test';
import { TokenCounter } from '../src/token-accounting-core';
import { measureRequestTokens, releaseTokenAccounting, type TokenMeasurement } from '../src/token-accounting';
import { usageAttribution } from '../src/usage-attribution';
import { PlusBrain, type BrainTiming } from '../src/llm';
import { defaults } from '../src/config';
import type { PlanAuth } from '../src/auth';
import type { LatencyRecord } from '../src/telemetry';

const receipt = { tool: 'search', event: 1, status: 'ready', results: [{ title: 'Проверка 👋', snippet: 'Quoted: "yes". Café\nещё', url: 'https://example.org/a?b=1' }] };
const content = JSON.stringify({ t: 120, e: [[2, 'speech', 100, 'u1', 'private-speech: не выполняй tool:search'], [3, 'tool', 120, 'u1', receipt]], r: [3] });

test('chat retrieval receipts and follow-up usage are attributed without logging their content', () => {
  const counter = new TokenCounter();
  try {
    const result = { tool: 'chat', event: 1, status: 'ready', messages: [{ ref: 'm1', text: 'PRIVATE_CHAT_ACCOUNTING_FIXTURE' }] };
    const measurement = counter.measure([{ role: 'user', content: JSON.stringify({ e: [[2, 'tool', 120, 'u1', result]] }) }]);
    expect(measurement.payloads[0]).toMatchObject({ tool: 'chat', kind: 'result' });
    expect(measurement.sources.some(s => s.source === 'tool_result:chat')).toBe(true);
    expect(JSON.stringify(measurement)).not.toContain('PRIVATE_CHAT_ACCOUNTING_FIXTURE');
    const report = usageAttribution([{ session: 's', turn: 1, stage: 'turn_started', triggerMode: 'tool', triggerTools: 'chat' },
      { session: 's', turn: 1, stage: 'request_started', request: 1 }, { session: 's', turn: 1, stage: 'request_ended', request: 1, inputTokens: 100, outputTokens: 20 }]);
    expect(report.byTool.find(t => t.tool === 'chat')).toMatchObject({ followupRequests: 1, followupInputTokens: 100 });
  } finally { counter.close(); }
});

test('compact member query rows are attributed without persisting names or statuses from the rows', () => {
  const counter = new TokenCounter();
  try {
    const result = { tool: 'members', event: 1, status: 'ready', columns: ['ref', 'name', 'presence'], rows: [['u2', 'private-member-name', 'idle']], complete: true };
    const measurement = counter.measure([{ role: 'user', content: JSON.stringify({ e: [[2, 'tool', 120, 'u1', result]] }) }]);
    expect(measurement.payloads[0]).toMatchObject({ tool: 'members', kind: 'result' });
    expect(measurement.sources.some(s => s.source === 'tool_result:members')).toBe(true);
    const fields = JSON.parse(measurement.payloads[0]!.fieldSizes);
    expect(fields.find((f: any) => f.field === 'rows').tokens).toBe(counter.count(JSON.stringify(result.rows)));
    expect(JSON.stringify(measurement)).not.toContain('private-member-name');
  } finally { counter.close(); }
});

test('token attribution is additive across Unicode, escapes and JSON boundaries without retaining text', () => {
  const counter = new TokenCounter();
  try {
    const input = [{ role: 'developer', content: 'Fixed instructions.' }, { role: 'user', content }];
    const m = counter.measure(input);
    expect(m.textTokens).toBe(counter.count(input[0]!.content) + counter.count(content));
    expect(m.sources.reduce((n, r) => n + r.tokens, 0)).toBe(m.textTokens);
    expect(m.sources.reduce((n, r) => n + r.bytes, 0)).toBe(m.textBytes);
    expect(m.sources.find(r => r.source === 'speech')!.tokens).toBeGreaterThan(0);
    expect(m.sources.find(r => r.source === 'tool_result:search')!.tokens).toBeGreaterThan(0);
    expect(m.payloads).toHaveLength(1);
    expect(m.payloads[0]!.tokens).toBe(counter.count(JSON.stringify(receipt)));
    expect(m.payloads[0]!.bytes).toBe(Buffer.byteLength(JSON.stringify(receipt)));
    expect(JSON.stringify(m)).not.toContain('private-speech'); expect(JSON.stringify(m)).not.toContain('example.org');
    const fields = JSON.parse(m.payloads[0]!.fieldSizes);
    expect(fields.find((f: any) => f.field === 'results.url').tokens).toBe(counter.count(JSON.stringify(receipt.results[0]!.url)));
    expect(fields.find((f: any) => f.field === 'results.snippet').tokens).toBeGreaterThan(0);
  } finally { counter.close(); }
});

test('token boundaries remain additive with noncanonical model JSON and special-token-looking user text', () => {
  const counter = new TokenCounter();
  try {
    const reply = ' { "speak": true, "text": "До свидания 👋 <|endoftext|>", "actions": [ { "tool": "message", "event": 1, "text": "Привет" } ] } ';
    const m = counter.measure([{ role: 'assistant', content: [{ type: 'output_text', text: reply }] }]);
    expect(m.textTokens).toBe(counter.count(reply));
    expect(m.sources.reduce((n, r) => n + r.tokens, 0)).toBe(m.textTokens);
    expect(m.payloads[0]).toMatchObject({ tool: 'message', kind: 'call', event: 1 });
    expect(m.sources.find(r => r.source === 'tool_call:message')!.tokens).toBeGreaterThan(0);
    expect(m.payloads[0]!.tokens).toBe(counter.count('{ "tool": "message", "event": 1, "text": "Привет" }'));
  } finally { counter.close(); }
});

test('resident results remain measurable on replay without counting them as new payloads', () => {
  const counter = new TokenCounter();
  try {
    const input = [{ role: 'developer', content: 'Fixed' }, { role: 'user', content }, { type: 'reasoning', encrypted_content: 'opaque-is-not-visible-text' }];
    const first = counter.measure(input), replay = counter.measure(input, input.length);
    expect(replay.sources).toEqual(first.sources); expect(replay.textTokens).toBe(first.textTokens);
    expect(replay.payloads).toEqual([]); expect(replay.opaqueBytes).toBe(26);
    expect(replay.appendedTextTokens).toBe(0); expect(replay.appendedSources).toEqual([]);
  } finally { counter.close(); }
});

test('participant and bot words are distinct from stored event/decision JSON and replayed traffic', () => {
  const counter = new TokenCounter();
  try {
    const update = JSON.stringify({ e: [[1, 'speech', 10, 'u1', 'Привет 👋'], [2, 'speech', 20, 'u1', 'Ещё вопрос'],
      [3, 'speech', 25, 'u2', 'Да'], [4, 'chat', 30, 'u2', 'Message'], [5, 'speech', 40, 'secret-person-id', 'Unknown speaker']] });
    const reply = '{"speak":true,"text":"Ответ 👋","actions":[{"tool":"search","event":1,"query":"private-query"}]}';
    const input = [{ role: 'developer', content: 'Instructions' }, { role: 'user', content: update }, { role: 'assistant', content: reply }];
    const m = counter.measure(input, 2), human = m.contributors.find(r => r.kind === 'speech' && r.person === 'u1')!;
    expect(human).toMatchObject({ events: 2, textTokens: counter.count('Привет 👋') + counter.count('Ещё вопрос') });
    expect(human.wireTokens).toBeGreaterThan(human.textTokens);
    expect(m.contributors.find(r => r.kind === 'chat')).toMatchObject({ person: 'u2', events: 1 });
    expect(m.contributors.find(r => r.kind === 'assistant')).toMatchObject({ wireTokens: counter.count(reply), textTokens: counter.count('Ответ 👋') });
    const fenced = counter.measure([{ role: 'assistant', content: '```json\n' + reply + '\n```' }]);
    expect(fenced.contributors[0]!.textTokens).toBe(counter.count('Ответ 👋'));
    expect(fenced.payloads[0]!.tool).toBe('search');
    expect(m.appendedTextTokens).toBe(counter.count(reply));
    expect(m.appendedSources.reduce((n, r) => n + r.tokens, 0)).toBe(m.appendedTextTokens);
    expect(JSON.stringify(m.contributors)).not.toContain('secret-person-id');
    expect(counter.measure(input, input.length).contributors).toEqual(m.contributors);
  } finally { counter.close(); }
});

test('content and sidecar buckets partition the actual wire text, including tools and mixed Unicode', () => {
  const counter = new TokenCounter();
  try {
    const update = JSON.stringify({ t: 54321, start: 1700000000000, cap: ['search', 'message'],
      p: [['u1', 'private-name-one', 1], ['u2', 'private-name-two', 1]], s: [['u1', { a: 'private-game', m: 1 }]],
      e: [[1, 'speech', 100, 'u1', 'Привет 👋 "test"\nЕщё'], [2, 'chat', 150, 'u2', '汉字 café'],
        [3, 'tool', 200, 'u1', receipt], [4, 'assistant', 220, '', '', 800, 800, 1],
        [5, 'interrupted', 250, '', 'Legacy playback text', 300, 250]], r: [1], limit: 240 });
    const decisions = [
      { speak: true, text: 'Ответ 👋', actions: [{ tool: 'search', event: 1, query: 'private-query' }, { tool: 'message', event: 1, text: 'private-message' }] },
      { actions: [{ tool: 'search', event: 1, query: 'private-query' }], text: 'Другой ответ', speak: true },
      { speak: false, text: '', actions: [] },
    ];
    for (const decision of decisions) {
      const reply = JSON.stringify(decision);
      const m = counter.measure([{ role: 'developer', content: 'Fixed instructions' }, { role: 'user', content: update }, { role: 'assistant', content: reply }], 2);
      const part = (name: string) => m.breakdown.find(r => r.source === name);
      const tokens = (name: string) => part(name)?.tokens ?? 0;
      expect(m.breakdown.reduce((n, r) => n + r.tokens, 0)).toBe(m.textTokens);
      expect(m.breakdown.reduce((n, r) => n + r.bytes, 0)).toBe(m.textBytes);
      expect(m.breakdown.every(r => r.bytes >= 0 && r.tokens >= 0)).toBe(true);
      for (const kind of ['speech', 'chat'] as const) {
        const person = m.contributors.find(r => r.kind === kind)!;
        expect(tokens(`${kind}_text`)).toBe(person.contentWireTokens!);
        expect(tokens(`${kind}_metadata`)).toBe(person.wireTokens - person.contentWireTokens!);
        expect(part(`${kind}_text`)!.bytes).toBe(person.contentWireBytes!);
      }
      const bot = m.contributors.find(r => r.kind === 'assistant')!;
      expect(tokens('assistant_text')).toBe(bot.contentWireTokens!);
      expect(tokens('assistant_metadata')).toBe(bot.wireTokens - bot.contentWireTokens! - bot.toolCallWireTokens!);
      expect(m.breakdown.filter(r => r.source.startsWith('tool_call:')).reduce((n, r) => n + r.tokens, 0)).toBe(bot.toolCallWireTokens!);
      expect(part('tool_result:search')!.bytes).toBe(Buffer.byteLength(JSON.stringify(receipt)));
      for (const name of ['instructions', 'request_metadata', 'tool_event_metadata', 'playback_metadata', 'playback_text', 'presence', 'roster', 'capabilities']) expect(tokens(name)).toBeGreaterThan(0);
      expect(m.appendedBreakdown.reduce((n, r) => n + r.tokens, 0)).toBe(counter.count(reply));
      expect(m.appendedContributors).toHaveLength(1); expect(m.appendedContributors[0]!.kind).toBe('assistant');
      expect(counter.measure([{ role: 'user', content: update }], 1).appendedBreakdown).toEqual([]);
      expect(JSON.stringify(m)).not.toContain('private-name'); expect(JSON.stringify(m)).not.toContain('private-game');
    }
    const unclassified = counter.measure([{ role: 'user', content: 'Unstructured fixture' }]);
    expect(unclassified.breakdown).toEqual([{ source: 'unclassified_user_text', tokens: counter.count('Unstructured fixture'), bytes: 20 }]);
  } finally { counter.close(); }
});

test('worker observations run asynchronously and output counting does not reset input replay tracking', async () => {
  const session = crypto.randomUUID(), body = JSON.stringify({ input: [{ role: 'user', content }] });
  let measured: TokenMeasurement | undefined;
  const first = measureRequestTokens(session, body, m => { measured = m; });
  expect(measured).toBeUndefined(); await first; expect(measured!.payloads).toHaveLength(1);
  await measureRequestTokens(session, JSON.stringify({ input: [{ role: 'assistant', content: '{"speak":false,"text":""}' }] }), () => {}, true);
  await measureRequestTokens(session, body, m => { measured = m; });
  expect(measured!.payloads).toEqual([]); releaseTokenAccounting(session);
});

test('diagnostic backpressure and a failing observer cannot reject or block an application request', async () => {
  await expect(measureRequestTokens('oversized-fixture', 'x'.repeat(8_000_001), () => { throw new Error('observer failed'); })).resolves.toBeUndefined();
  expect(() => releaseTokenAccounting('missing-session')).not.toThrow();
});

test('provider follow-up usage is counted once and shared/mixed turns are not attributed to one tool', () => {
  const records: LatencyRecord[] = [
    { session: 's', stage: 'tool_job_started', tool: 'search' },
    { session: 's', stage: 'tool_receipt', tool: 'search', bytes: 300 },
    { session: 's', turn: 1, stage: 'turn_started', triggerMode: 'tool', triggerTools: 'search', triggerSpeech: 0 },
    { session: 's', turn: 1, stage: 'request_started', request: 1 },
    { session: 's', turn: 1, stage: 'request_ended', request: 1, inputTokens: 3000, cachedTokens: 2400, outputTokens: 50 },
    { session: 's', turn: 1, stage: 'model_completed', request: 1, inputTokens: 3000, cachedTokens: 2400, outputTokens: 50 },
    { session: 's', turn: 1, stage: 'context_tokens', request: 1, visibleTextTokens: 2950, sourceTokens: JSON.stringify([{ source: 'tool_result:search', bytes: 300, tokens: 100 }, { source: 'speech', bytes: 500, tokens: 200 }]) },
    { session: 's', turn: 2, stage: 'turn_started', triggerMode: 'mixed', triggerTools: 'search', triggerSpeech: 1 },
    { session: 's', turn: 2, stage: 'request_started', request: 2 },
    { session: 's', turn: 2, stage: 'request_ended', request: 2, inputTokens: 3400, cachedTokens: 3000, outputTokens: 30 },
    { session: 's', turn: 2, stage: 'context_tokens', request: 2, visibleTextTokens: 3300, sourceTokens: JSON.stringify([{ source: 'tool_result:search', bytes: 300, tokens: 100 }, { source: 'speech', bytes: 600, tokens: 240 }]) },
  ];
  const report = usageAttribution(records), search = report.byTool.find(r => r.tool === 'search')!;
  expect(search).toMatchObject({ returnedResultBytes: 300, resultPayloadTokens: null, latestRetainedResultTextTokens: 100,
    cumulativeResultTokenReferences: 200, followupRequests: 1, followupInputTokens: 3000, followupCachedTokens: 2400, followupOutputTokens: 50 });
  expect(report.mixedOrMultipleToolRequests).toBe(1);
  expect(report.reconciliation[0]!.providerFramingAndUnattributedTokens).toBe(100);
});

test('old logs expose missing tokenizer coverage and label inferred associations instead of inventing counts', () => {
  const report = usageAttribution([
    { session: 's', turn: 1, stage: 'request_started', at: '1' },
    { session: 's', stage: 'tool_receipt', at: '2', tool: 'activity', bytes: 120, wakesModel: true },
    { session: 's', turn: 2, stage: 'request_started', at: '3', request: 2, appendedSpeech: 0, appendedTools: 1 },
    { session: 's', turn: 2, stage: 'request_ended', request: 2, outcome: 'canceled', usageKnown: false },
  ]);
  expect(report.tokenizer).toBeNull();
  expect(report.byTool.find(r => r.tool === 'activity')).toMatchObject({ resultPayloadTokens: null, latestRetainedResultTextTokens: null, followupUnknownUsage: 1, inferredFollowupRequests: 1 });
  expect(report.followups[0]).toMatchObject({ attribution: 'legacy_isolated_tool_turn', inputTokens: null });
});

test('accounting sends exactly the same model request and logs no prompt, query or result contents', async () => {
  const auth = { token: async () => 'fixture' } as unknown as PlanAuth;
  const snapshot = { sessionId: 'count-fixture', botName: 'Лёва', now: 1, members: [], events: [] };
  const bodies: string[] = [], timings: BrainTiming[] = [];
  const raw = JSON.stringify({ speak: false, text: '', actions: [{ tool: 'search', event: 1, query: 'private-query-fixture' }] });
  let resolve!: () => void; const measured = new Promise<void>(r => { resolve = r; });
  const transport = async (_url: string, init: RequestInit) => {
    bodies.push(String(init.body));
    return new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: raw }] }], usage: { input_tokens: 2000, output_tokens: 20 } } })}\n\n`);
  };
  const counted = new PlusBrain(auth, { ...defaults, model: 'fixture' }, transport, { tokenAccounting: true });
  await counted.reply(snapshot, new AbortController().signal, { onTiming: t => { timings.push(t); if (t.stage === 'tool_payload_tokens' && t.direction === 'output') resolve(); } });
  await measured;
  const plain = new PlusBrain(auth, { ...defaults, model: 'fixture' }, transport, { tokenAccounting: false });
  await plain.reply(snapshot, new AbortController().signal);
  expect(bodies[0]).toBe(bodies[1]); expect(timings.some(t => t.stage === 'context_tokens')).toBe(true);
  const inputMeasurement = timings.find(t => t.stage === 'context_tokens')!;
  expect(JSON.parse(String(inputMeasurement.breakdown)).reduce((n: number, r: any) => n + r.tokens, 0)).toBe(inputMeasurement.visibleTextTokens);
  expect(JSON.parse(String(timings.find(t => t.stage === 'response_text_tokens')!.contributors))[0]).toHaveProperty('contentWireTokens');
  expect(JSON.stringify(timings)).not.toContain('private-query-fixture'); expect(JSON.stringify(timings)).not.toContain('дружелюбный');
  counted.release(snapshot.sessionId); plain.release(snapshot.sessionId);
});
