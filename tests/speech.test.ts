import { test, expect } from 'bun:test';
import { SpeechClient } from '../src/speech';
import { defaults } from '../src/config';

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
async function within<T>(promise: Promise<T>, ms = 500): Promise<T> {
  return Promise.race([promise, Bun.sleep(ms).then(() => { throw new Error('Timed out waiting for cancellation or synthesis'); })]);
}
function backend(options: { status?: number; streamBody?: boolean } = {}) {
  const release = deferred<void>(), entered = deferred<void>(), starts: string[] = [];
  let busy = false, rejected = 0, connectionAborted = false;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const { text } = await request.json() as { text: string };
    starts.push(text);
    if (busy) { rejected++; return Response.json({ error: 'busy' }, { status: 429 }); }
    busy = true;
    request.signal.addEventListener('abort', () => { connectionAborted = true; }, { once: true });
    if (text === 'Хм.') {
      entered.resolve();
      if (options.streamBody) return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('cue'));
          void release.promise.then(() => { busy = false; try { controller.close(); } catch { /* Test server was closed after a failed assertion. */ } });
        },
      }));
      await release.promise;
    }
    busy = false;
    return new Response(text, { status: text === 'Хм.' ? options.status ?? 200 : 200 });
  } });
  const client = new SpeechClient({ ...defaults, speechPort: server.port! }, 'synthetic-worker-token');
  return { client, entered: entered.promise, release: () => release.resolve(), starts, rejected: () => rejected,
    connectionAborted: () => connectionAborted, close: () => { release.resolve(); server.stop(true); } };
}

test('canceling a thinking cue returns promptly but keeps the worker slot until inference finishes', async () => {
  const f = backend(), cueAbort = new AbortController();
  try {
    const cue = f.client.synthesize('Хм.', cueAbort.signal);
    await within(f.entered); cueAbort.abort(); await expect(within(cue)).rejects.toBe(cueAbort.signal.reason);
    const answer = f.client.synthesize('Готовый ответ.', new AbortController().signal).then(value => ({ value }), error => ({ error }));
    await Bun.sleep(25);
    expect(f.starts).toEqual(['Хм.']); expect(f.rejected()).toBe(0); expect(f.connectionAborted()).toBe(false);
    f.release();
    const result = await within(answer);
    expect('error' in result).toBe(false);
    if ('value' in result) expect(result.value.toString()).toBe('Готовый ответ.');
    expect(f.starts).toEqual(['Хм.', 'Готовый ответ.']);
  } finally { f.close(); }
});

test('canceling queued synthesis skips its HTTP request without holding its caller open', async () => {
  const f = backend(), obsolete = new AbortController();
  try {
    const first = f.client.synthesize('Хм.', new AbortController().signal); await within(f.entered);
    const queued = f.client.synthesize('Устаревший ответ.', obsolete.signal);
    obsolete.abort(); await expect(within(queued, 100)).rejects.toBe(obsolete.signal.reason);
    expect(f.starts).toEqual(['Хм.']);
    const current = f.client.synthesize('Новый ответ.', new AbortController().signal);
    f.release(); await within(first); expect((await within(current)).toString()).toBe('Новый ответ.');
    expect(f.starts).toEqual(['Хм.', 'Новый ответ.']);
  } finally { f.close(); }
});

test('canceled synthesis drains its entire HTTP body before allowing the next inference', async () => {
  const f = backend({ streamBody: true }), abort = new AbortController();
  try {
    const cue = f.client.synthesize('Хм.', abort.signal); await within(f.entered); await Bun.sleep(5);
    abort.abort(); await expect(within(cue)).rejects.toBe(abort.signal.reason);
    const answer = f.client.synthesize('Ответ.', new AbortController().signal).then(value => ({ value }), error => ({ error }));
    await Bun.sleep(25); expect(f.starts).toEqual(['Хм.']);
    f.release(); const result = await within(answer); expect('error' in result).toBe(false); expect(f.rejected()).toBe(0);
  } finally { f.close(); }
});

test('an error finishing a canceled cue cannot poison the next synthesis request', async () => {
  const f = backend({ status: 500 }), abort = new AbortController();
  try {
    const cue = f.client.synthesize('Хм.', abort.signal); await within(f.entered); abort.abort(); await expect(within(cue)).rejects.toThrow();
    f.release();
    expect((await within(f.client.synthesize('Ответ.', new AbortController().signal))).toString()).toBe('Ответ.');
    expect(f.rejected()).toBe(0);
  } finally { f.close(); }
});
