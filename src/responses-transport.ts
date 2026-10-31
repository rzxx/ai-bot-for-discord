import { t } from './locale';
import type { HTTPTransport } from './llm';
import { withAbort } from './abort';

interface Pending {
  controller: ReadableStreamDefaultController<Uint8Array>;
  signal?: AbortSignal | null;
  cancel: () => void;
}
interface Connection {
  socket: Bun.WebSocket; token: string; ready: Promise<void>; opened: boolean; created: number;
  pending?: Pending; ping?: ReturnType<typeof setInterval>; rejectOpen?: (error: Error) => void;
}
export type ResponsesTransportMode = 'auto' | 'http' | 'websocket';
interface Options { url?: string; http?: HTTPTransport; proxy?: string; connectTimeoutMs?: number; retryAfterMs?: number }
const encoder = new TextEncoder();
const NativeWebSocket = WebSocket as unknown as { new(url: string, options: Bun.WebSocketOptions): Bun.WebSocket };
const reset = (message: string) => Object.assign(new Error(message), { code: 'ECONNRESET' });

/** Same text endpoint/account, through Bun's native persistent WebSocket.
 * Replay full input each time; no provider-stored history is assumed.
 * Auto mode never makes a cold/unavailable socket delay an HTTP request. */
export class ResponsesTransport {
  private connections = new Map<string, Connection>();
  private failedUntil = new Map<string, number>();
  private readonly http: HTTPTransport;
  constructor(readonly mode: ResponsesTransportMode, private options: Options = {}) { this.http = options.http ?? fetch; }

  async warm(session: string, token: string): Promise<void> {
    if (this.mode === 'http' || Date.now() < (this.failedUntil.get(session) ?? 0)) return;
    const previous = this.connections.get(session);
    if (previous) {
      if (previous.pending || previous.token === token && Date.now() - previous.created < 55 * 60000) return previous.ready;
      this.drop(session, previous);
    }
    const url = this.options.url ?? 'wss://api.openai.com/v1/responses';
    const proxy = this.options.proxy ?? (new URL(url).hostname === '127.0.0.1' ? undefined
      : process.env.https_proxy || process.env.HTTPS_PROXY || process.env.all_proxy || process.env.ALL_PROXY);
    let socket: Bun.WebSocket;
    try { socket = new NativeWebSocket(url, { headers: { Authorization: `Bearer ${token}`, 'session-id': session }, proxy }); }
    catch {
      this.failedUntil.set(session, Date.now() + (this.options.retryAfterMs ?? 60000));
      throw reset(t("Responses WebSocket could not be created."));
    }
    let opened!: () => void, failed!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { opened = resolve; failed = reject; });
    void ready.catch(() => {});
    const connection: Connection = { socket, token, ready, opened: false, created: Date.now() };
    this.connections.set(session, connection);
    const timeout = setTimeout(() => this.drop(session, connection, reset(t("Responses WebSocket handshake timed out.")), true), this.options.connectTimeoutMs ?? 8000);
    connection.rejectOpen = error => { clearTimeout(timeout); failed(error); };
    socket.onopen = () => {
      if (this.connections.get(session) !== connection) { socket.close(); return; }
      clearTimeout(timeout); connection.opened = true; opened();
      connection.ping = setInterval(() => {
        try { connection.socket.ping(); } catch { this.drop(session, connection, reset(t("Responses WebSocket keepalive failed.")), true); }
      }, 20000);
      connection.ping.unref();
    };
    const disconnected = () => this.drop(session, connection, reset(t("Responses WebSocket disconnected.")), true);
    socket.onerror = disconnected; socket.onclose = disconnected;
    socket.onmessage = event => {
      const pending = connection.pending;
      if (!pending) return;
      try {
        const raw = String(event.data);
        if (raw.length > 2_000_000) throw new Error(t("Responses WebSocket event is too large."));
        const item = JSON.parse(raw);
        pending.controller.enqueue(encoder.encode(`data: ${raw}\n\n`));
        if ((pending.controller.desiredSize ?? 0) < -2_000_000) throw new Error(t("Responses WebSocket consumer fell behind."));
        if (['response.completed', 'response.failed', 'response.incomplete', 'error'].includes(item.type)) {
          connection.pending = undefined; pending.signal?.removeEventListener('abort', pending.cancel);
          pending.controller.close();
        }
      } catch (error) { this.drop(session, connection, error instanceof Error ? error : reset(t("Invalid Responses WebSocket event.")), true); }
    };
    return ready;
  }

  private drop(session: string, connection: Connection, error: Error = reset(t("Responses WebSocket closed.")), backoff = false) {
    if (this.connections.get(session) !== connection) return;
    this.connections.delete(session); clearInterval(connection.ping); connection.rejectOpen?.(error);
    if (backoff) this.failedUntil.set(session, Date.now() + (this.options.retryAfterMs ?? 60000));
    const pending = connection.pending; connection.pending = undefined;
    if (pending) { pending.signal?.removeEventListener('abort', pending.cancel); pending.controller.error(error); }
    connection.socket.close();
  }
  release(session: string) {
    const connection = this.connections.get(session);
    if (connection) this.drop(session, connection);
    this.failedUntil.delete(session);
  }
  private async overHTTP(url: string, init: RequestInit): Promise<Response> {
    const response = await this.http(url, init), headers = new Headers(response.headers);
    headers.set('x-bot-transport', 'http');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
  readonly fetch: HTTPTransport = async (url, init) => {
    init.signal?.throwIfAborted();
    const headers = new Headers(init.headers), session = headers.get('session-id'), token = headers.get('authorization');
    if (this.mode === 'http' || !session || !token?.startsWith('Bearer ')) return this.overHTTP(url, init);
    const accessToken = token.slice(7);
    let connection = this.connections.get(session);
    if (!connection?.opened || connection.token !== accessToken || Date.now() - connection.created >= 55 * 60000) {
      const warming = this.warm(session, accessToken);
      if (this.mode === 'auto') { void warming.catch(() => {}); return this.overHTTP(url, init); }
      await withAbort(warming, init.signal ?? undefined);
      connection = this.connections.get(session);
    }
    if (!connection?.opened) {
      if (this.mode === 'auto') return this.overHTTP(url, init);
      throw reset(t("Responses WebSocket is unavailable."));
    }
    if (connection.pending) throw new Error(t("Concurrent Responses requests on one session are not supported."));
    const body = JSON.parse(String(init.body));
    const { stream: _, background: __, ...request } = body;
    const active = connection;
    const stream = new ReadableStream<Uint8Array>({
      start: controller => {
        const cancel = () => this.drop(session, active, init.signal?.reason ?? reset(t("Responses request canceled.")));
        active.pending = { controller, signal: init.signal, cancel };
        init.signal?.addEventListener('abort', cancel, { once: true });
        if (init.signal?.aborted) { cancel(); return; }
        try { active.socket.send(JSON.stringify({ type: 'response.create', ...request })); }
        catch { this.drop(session, active, reset(t("Responses WebSocket send failed.")), true); }
      },
      cancel: () => { if (active.pending) this.drop(session, active); },
    }, { highWaterMark: 256 * 1024, size: value => value?.byteLength ?? 0 });
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'x-bot-transport': 'websocket' } });
  };
}
