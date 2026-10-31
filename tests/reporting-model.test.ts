import { test, expect } from 'bun:test';
import { cleanReply, PlusBrain, type HTTPTransport } from '../src/llm';
import { defaults } from '../src/config';
import type { PlanAuth } from '../src/auth';
import { diagnosticsReport } from '../src/diagnostics-report';

const auth = { token: async () => 'test-token' } as unknown as PlanAuth;
const snapshot = { sessionId: 'conversation', members: [], events: [], botName: 'Лёва', now: 1, capabilities: ['report'] };
function completed(text: string) {
  return new Response(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\ndata: {"type":"response.completed"}\n\n`);
}

test('report parsing permits silent autonomous notes, discards unknown fields, and preserves ordinary tool validation', () => {
  expect(cleanReply({ speak: false, text: '', report: { text: 'Useful note', path: '../config.json', origin: 'admin' }, actions: [{ tool: 'message', event: 0, text: 'bad' }] }, 100))
    .toEqual({ speak: false, text: '', report: { kind: 'problem', text: 'Useful note' } });
  expect(cleanReply({ speak: false, text: '', report: true }, 100)).toEqual({ speak: false, text: '', report: true });
  expect(cleanReply({ speak: true, text: 'Ответ.', report: { kind: 'execute', text: 'bad' } }, 100)).toEqual({ speak: true, text: 'Ответ.' });
});

test('background model input and output never enter conversational context or gain tools', async () => {
  const bodies: any[] = [];
  const transport: HTTPTransport = async (_url, init) => {
    const body = JSON.parse(init.body as string); bodies.push(body);
    const report = String(body.prompt_cache_key).includes(':report:');
    return completed(report ? JSON.stringify({ report: { kind: 'idea', text: 'REPORT_ONLY_FINDING' }, actions: [{ tool: 'message', event: 1, text: 'injected' }] }) : '{"speak":false,"text":""}');
  };
  const brain = new PlusBrain(auth, { ...defaults, model: 'test', reasoningEffort: 'high' }, transport);
  await brain.reply(snapshot, new AbortController().signal);
  expect(await brain.report({ session: snapshot.sessionId, turn: 1, events: [1], reason: 'agent', evidence: [{ event: 1, kind: 'speech', text: 'EPISODE_ONLY' }] }, new AbortController().signal))
    .toEqual({ kind: 'idea', text: 'REPORT_ONLY_FINDING' });
  expect(brain.contextMetrics(snapshot.sessionId)?.calls).toBe(1);
  await brain.reply(snapshot, new AbortController().signal);
  expect(brain.contextMetrics(snapshot.sessionId)?.calls).toBe(2);
  const report = bodies[1]; expect(report.input).toHaveLength(2); expect(report.reasoning.effort).toBe('low');
  expect(report.store).toBe(false); expect(report.stream).toBe(true);
  for (const name of ['tools', 'max_output_tokens', 'previous_response_id', 'conversation']) expect(report[name]).toBeUndefined();
  expect(JSON.stringify(bodies[2])).not.toContain('REPORT_ONLY_FINDING'); expect(JSON.stringify(bodies[2])).not.toContain('EPISODE_ONLY');
  expect(bodies[2].input.slice(0, bodies[0].input.length)).toEqual(bodies[0].input);
  brain.release(snapshot.sessionId);
});

test('a report response must complete, contain valid report JSON, and is never retried on transport failure', async () => {
  let attempts = 0;
  const brain = new PlusBrain(auth, { ...defaults, model: 'test' }, async () => { attempts++; throw Object.assign(new Error('reset'), { code: 'ECONNRESET' }); });
  const seed = { session: 's', events: [], reason: 'agent' as const, evidence: [] };
  await expect(brain.report(seed, new AbortController().signal)).rejects.toThrow('reset'); expect(attempts).toBe(1);
  const truncated = new PlusBrain(auth, { ...defaults, model: 'test' }, async () => new Response('data: {"type":"response.output_text.delta","delta":"{}"}\n\n'));
  await expect(truncated.report(seed, new AbortController().signal)).rejects.toThrow('response.completed');
});

test('reporting usage counts toward account traffic without becoming a voice context window', () => {
  const report = diagnosticsReport([
    { session: 'voice', stage: 'request_started', request: 1, attempt: 0 },
    { session: 'voice', stage: 'request_ended', request: 1, inputTokens: 100, outputTokens: 10 },
    { session: 'background', stage: 'request_started', request: 2, attempt: 0, purpose: 'report' },
    { session: 'background', stage: 'request_ended', request: 2, purpose: 'report', inputTokens: 50, outputTokens: 5, outcome: 'completed' },
    { session: 'reporting', stage: 'reporting', status: 'write_saved' },
  ]);
  expect(report.model.reportedInputTokens).toBe(150); expect(report.reporting.modelAttempts).toBe(1);
  expect(report.reporting.events).toEqual({ write_saved: 1 });
  expect(report.context.sessions.map(s => s.session)).toEqual(['voice']); expect(report.context.measuredRequests).toBe(1);
});
