import { expect, test } from 'bun:test';
import { ResponsesTransport } from '../src/responses-transport';
import { parseSSE, PlusBrain, type HTTPTransport } from '../src/llm';
import type { PlanAuth } from '../src/auth';
import { defaults } from '../src/config';

function fixture(onMessage?: (socket: Bun.ServerWebSocket<undefined>, body: any) => void) {
  let opens = 0, httpCalls = 0;
  const messages: any[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0,
    fetch(request, server) { if (server.upgrade(request)) return; return new Response('', { status: 400 }); },
    websocket: { open() { opens++; }, message(socket, data) {
      const body = JSON.parse(String(data)); messages.push(body);
      if (onMessage) onMessage(socket, body);
      else {
        socket.send(JSON.stringify({ type: 'response.output_text.delta', delta: '{"speak":true,"text":"Да."}' }));
        socket.send(JSON.stringify({ type: 'response.completed' }));
      }
    } },
  });
  const http: HTTPTransport = async () => { httpCalls++; return new Response('data: {"type":"response.completed"}\n\n'); };
  const transport = new ResponsesTransport('auto', { url: `ws://127.0.0.1:${server.port}`, http });
  const init = (signal?: AbortSignal): RequestInit => ({ method: 'POST', headers: { Authorization: 'Bearer test-fixture', 'session-id': 'room' },
    body: JSON.stringify({ model: 'fixture', input: [{ role: 'user', content: 'fixture' }], store: false, stream: true }), signal });
  return { transport, server, messages, init, opens: () => opens, httpCalls: () => httpCalls, close: async () => { transport.release('room'); await server.stop(true); } };
}
async function events(response: Response) { const result = []; for await (const event of parseSSE(response.body!)) result.push(JSON.parse(event.data)); return result; }

test('warm sockets reuse the connection, replay full input, and close at terminal events without waiting for socket EOF', async () => {
  const f = fixture();
  try {
    await f.transport.warm('room', 'test-fixture');
    for (let i = 0; i < 2; i++) {
      const response = await f.transport.fetch('https://unused.test/responses', f.init());
      expect(response.headers.get('x-bot-transport')).toBe('websocket');
      expect((await events(response)).at(-1).type).toBe('response.completed');
    }
    expect(f.opens()).toBe(1); expect(f.httpCalls()).toBe(0);
    expect(f.messages).toHaveLength(2);
    expect(f.messages[0]).toMatchObject({ type: 'response.create', store: false, input: [{ role: 'user', content: 'fixture' }] });
    expect(f.messages[0].stream).toBeUndefined(); expect(f.messages[0].previous_response_id).toBeUndefined();
  } finally { await f.close(); }
});

test('a cold auto connection uses HTTP immediately and a failed warmup does not block HTTP', async () => {
  const f = fixture();
  try {
    const response = await f.transport.fetch('https://unused.test/responses', f.init());
    expect(response.headers.get('x-bot-transport')).toBe('http'); await events(response);
    expect(f.httpCalls()).toBe(1);
    await f.transport.warm('room', 'test-fixture');
  } finally { await f.close(); }
  const failed = new ResponsesTransport('auto', { url: 'ws://127.0.0.1:1', http: async () => new Response('fallback'), connectTimeoutMs: 30 });
  try {
    await failed.warm('room', 'test-fixture').catch(() => {});
    expect(await (await failed.fetch('https://unused.test/responses', f.init())).text()).toBe('fallback');
  } finally { failed.release('room'); }
});

test('canceling an in-flight socket closes it and reconnects without leaking late events to the next request', async () => {
  let old!: Bun.ServerWebSocket<undefined>;
  const f = fixture(socket => { old = socket; });
  try {
    await f.transport.warm('room', 'test-fixture');
    const abort = new AbortController(); const response = await f.transport.fetch('https://unused.test/responses', f.init(abort.signal));
    const pending = events(response); abort.abort();
    await expect(pending).rejects.toThrow();
    await f.transport.warm('room', 'test-fixture');
    expect(f.opens()).toBe(2);
    expect(old).toBeDefined();
  } finally { await f.close(); }
});

test('provider quota errors retain their codes and pause semantics through a WebSocket', async () => {
  const f = fixture(socket => socket.send(JSON.stringify({ type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'fixture limit' } } })));
  try {
    await f.transport.warm('room', 'test-fixture');
    const brain = new PlusBrain({ token: async () => 'test-fixture' } as unknown as PlanAuth, defaults, f.transport.fetch);
    await expect(brain.reply({ sessionId: 'room', botName: 'Лёва', members: [], events: [], now: 1 }, new AbortController().signal)).rejects.toThrow('ChatGPT plan usage limit reached');
    expect(f.httpCalls()).toBe(0);
  } finally { await f.close(); }
});

test('a disconnected socket retries once over HTTP before speech, but never replays an escaped sentence', async () => {
  for (const speakFirst of [false, true]) {
    const f = fixture(socket => {
      if (speakFirst) socket.send(JSON.stringify({ type: 'response.output_text.delta', delta: '{"speak":true,"text":"Да. ' }));
      setTimeout(() => socket.close(), 15);
    });
    try {
      await f.transport.warm('room', 'test-fixture');
      const brain = new PlusBrain({ token: async () => 'test-fixture' } as unknown as PlanAuth, defaults, f.transport.fetch);
      const request = brain.reply({ sessionId: 'room', botName: 'Лёва', members: [], events: [], now: 1 }, new AbortController().signal, { onSentence: () => {} });
      // The fallback fixture intentionally has no valid final JSON: the important
      // invariant here is exactly one fallback before speech and none afterward.
      await expect(request).rejects.toThrow();
      expect(f.httpCalls()).toBe(speakFirst ? 0 : 1);
    } finally { await f.close(); }
  }
});

test('token changes replace an idle socket and release rejects a pending warmup', async () => {
  const f = fixture();
  try {
    await f.transport.warm('room', 'test-fixture');
    await f.transport.warm('room', 'new-test-fixture');
    expect(f.opens()).toBe(2);
  } finally { await f.close(); }
  const waiting = new ResponsesTransport('websocket', { url: 'ws://127.0.0.1:1' });
  const promise = waiting.warm('room', 'test-fixture'); waiting.release('room');
  await expect(promise).rejects.toThrow();
});
