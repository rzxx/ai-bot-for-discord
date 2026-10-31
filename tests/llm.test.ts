import { test, expect } from 'bun:test';
import { parseSSE, PlusBrain, type HTTPTransport } from '../src/llm';
import { defaults } from '../src/config';
import type { PlanAuth } from '../src/auth';

const encoder = new TextEncoder();
function stream(text: string) {
  const bytes = encoder.encode(text);
  // Split every byte, including inside Cyrillic UTF-8 characters and CRLF boundaries.
  return new ReadableStream<Uint8Array>({ start(c) { for (const byte of bytes) c.enqueue(new Uint8Array([byte])); c.close(); } });
}
const snapshot = { sessionId: 'test-session', members: [{ id: '1', name: 'Лёша' }], events: [], botName: 'Лёва', now: 1 };
const auth = { token: async () => 'test-credential' } as unknown as PlanAuth;

test('speech streams before trailing action arguments and actions require completed valid JSON', async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
  const brain = new PlusBrain(auth, { ...defaults, model: 'test' }, async () => new Response(body));
  const spoken: string[] = [];
  const pending = brain.reply(snapshot, new AbortController().signal, { onSentence: text => spoken.push(text) });
  const first = '{"speak":true,"text":"Не уверен, сейчас проверю.",';
  controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: first })}\n\n`));
  for (let i = 0; i < 15; i++) await Promise.resolve();
  expect(spoken).toEqual(['Не уверен, сейчас проверю.']);
  const tail = '"actions":[{"tool":"search","event":1,"query":"Minecraft release"}]}';
  controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: tail })}\n\ndata: {"type":"response.completed"}\n\n`)); controller.close();
  const reply = await pending; expect(reply.actions).toEqual([{ tool: 'search', event: 1, query: 'Minecraft release' }]);
});

test('SSE decodes Cyrillic across arbitrary byte boundaries', async () => {
  const found = [];
  for await (const event of parseSSE(stream('event: message\r\ndata: Привет, Алёна!\r\n\r\ndata: ещё\ndata: строка\n\n'))) found.push(event.data);
  expect(found).toEqual(['Привет, Алёна!', 'ещё\nстрока']);
});

test('buffered callers receive only a completed reply, and plan requests omit forbidden parameters', async () => {
  const transport = (async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    expect(body.store).toBe(false); expect(body.stream).toBe(true);
    for (const key of ['max_output_tokens', 'temperature', 'previous_response_id', 'conversation']) expect(body[key]).toBeUndefined();
    const text = JSON.stringify({ speak: true, text: 'Привет, Алёна! Всё готово.' });
    return new Response(stream(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\ndata: {"type":"response.completed"}\n\n`));
  }) as HTTPTransport;
  const brain = new PlusBrain(auth, { ...defaults, model: 'test' }, transport);
  expect((await brain.reply(snapshot, new AbortController().signal)).text).toBe('Привет, Алёна! Всё готово.');
});

test('a quota failure after output deltas rejects buffered output', async () => {
  const transport: HTTPTransport = async () => new Response(stream('data: {"type":"response.output_text.delta","delta":"{\\"speak\\":true,\\"text\\":\\"Привет\\"}"}\n\ndata: {"type":"response.failed","response":{"error":{"code":"subscription_sharing_usage_limit_exceeded","message":"Limit reached"}}}\n\n'));
  const brain = new PlusBrain(auth, { ...defaults, model: 'test' }, transport);
  await expect(brain.reply(snapshot, new AbortController().signal)).rejects.toThrow('ChatGPT plan usage limit reached');
});

test('a disconnected stream without completion is rejected', async () => {
  const transport: HTTPTransport = async () => new Response(stream('data: {"type":"response.output_text.delta","delta":"{\\"speak\\":true,\\"text\\":\\"Привет\\"}"}\n\n'));
  await expect(new PlusBrain(auth, { ...defaults, model: 'test' }, transport).reply(snapshot, new AbortController().signal)).rejects.toThrow('response.completed');
});

test('a completed reply is released even when the proxy keeps its HTTP stream open', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const text = JSON.stringify({ speak: true, text: 'Да, слышу.' });
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\ndata: {"type":"response.completed"}\n\n`));
      // Deliberately leave the body open after the terminal event.
    }, cancel() { cancelled = true; },
  });
  const brain = new PlusBrain(auth, { ...defaults, model: 'test' }, async () => new Response(body));
  const reply = await Promise.race([brain.reply(snapshot, new AbortController().signal), Bun.sleep(500).then(() => { throw new Error('Waited for HTTP EOF after completion'); })]);
  expect(reply.text).toBe('Да, слышу.'); expect(cancelled).toBe(true);
});

test('one connection-reset retry reuses the exact request without duplicating context', async () => {
  const bodies: string[] = [];
  const transport: HTTPTransport = async (_url, init) => {
    bodies.push(init.body as string);
    if (bodies.length === 1) throw Object.assign(new Error('Connection reset'), { code: 'ECONNRESET' });
    return new Response(stream('data: {"type":"response.output_text.delta","delta":"{\\"speak\\":false,\\"text\\":\\"\\"}"}\n\ndata: {"type":"response.completed"}\n\n'));
  };
  const brain = new PlusBrain(auth, { ...defaults, model: 'test' }, transport);
  expect((await brain.reply(snapshot, new AbortController().signal)).speak).toBe(false);
  expect(bodies).toHaveLength(2); expect(bodies[0]).toBe(bodies[1]);
  expect(brain.contextMetrics(snapshot.sessionId)?.calls).toBe(1);
});

test('per-turn speech limits apply to both streamed clauses and the completed reply', async () => {
  const text = 'Если согласуем маршрут и время заранее и проверим дорогу до места встречи, добраться получится быстрее и спокойнее. ' + 'Дополнительная подробность. '.repeat(12);
  for (const maxChars of [90, 240]) {
    const chunks: string[] = [];
    const raw = JSON.stringify({ speak: true, text });
    const transport: HTTPTransport = async () => new Response(stream([
      { type: 'response.output_text.delta', delta: raw.slice(0, 125) },
      { type: 'response.output_text.delta', delta: raw.slice(125) },
      { type: 'response.completed' },
    ].map(value => `data: ${JSON.stringify(value)}\n\n`).join('')));
    const brain = new PlusBrain(auth, { ...defaults, model: 'test' }, transport);
    const reply = await brain.reply({ ...snapshot, responsePolicy: { triggerEventIds: [1], maxChars, preparingEarly: true } }, new AbortController().signal, { onSentence: text => chunks.push(text) });
    expect(reply.text.length).toBeLessThanOrEqual(maxChars);
    expect(chunks.join(' ')).toBe(reply.text);
  }
});
