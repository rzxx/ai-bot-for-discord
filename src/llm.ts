import { t, withLocale } from './locale';
import { PlanAuth, OpenAIError, responseError } from './auth';
import { roomInstructions, reviewInstructions } from './prompts';
import { type Config, log } from './config';
import { SessionContext, type ContextMetrics, type InputItem, type ModelResult } from './context';
import { ReplySentences } from './reply-stream';
import { ResponsesTransport, type ResponsesTransportMode } from './responses-transport';
import { parseActions, type ToolAction } from './room-tools';
import { createHash } from 'node:crypto';
import { diagnosticsEnabled, latency } from './telemetry';
import { measureRequestTokens, releaseTokenAccounting } from './token-accounting';
import { parseReport, type ReportDraft } from './reports';
import type { ReportSeed } from './reporting';
import { parseTaskResults, type TaskResult } from './tasks';

export interface Member { id: string; name: string }
export interface TurnEvent { id: number; at: number; end?: number; playedMs?: number; kind: 'speech' | 'join' | 'leave' | 'rename' | 'assistant' | 'interrupted' | 'chat' | 'tool'; userId?: string; name?: string; text: string; attention?: string; replyTo?: number }
export interface MemberState { userId: string; status?: string; activity?: string; muted: boolean; deafened: boolean }
export interface RoomSnapshot {
  sessionId: string; members: Member[]; events: TurnEvent[]; botName: string; now: number;
  timeline?: { sessionStartedAt: number; quietForMs: number; sinceLastBotSpeechMs: number | null };
  responsePolicy?: { triggerEventIds: number[]; maxChars: number; preparingEarly: boolean };
  states?: MemberState[];
  capabilities?: string[];
}
export interface Reply { speak: boolean; text: string; actions?: ToolAction[]; taskResults?: TaskResult[]; report?: ReportDraft | true }
export interface BrainTiming {
  [key: string]: string | number | boolean | null | undefined;
  stage: string; elapsedMs: number; attempt: number; compaction: boolean;
  inputTokens?: number; cachedTokens?: number; outputTokens?: number; reasoningTokens?: number;
  transport?: string;
}
export interface ReplyHooks { onSentence?: (text: string) => void; onTiming?: (timing: BrainTiming) => void }
export interface Brain {
  reply(snapshot: RoomSnapshot, signal: AbortSignal, hooks?: ReplyHooks): Promise<Reply>;
  contextMetrics?(sessionId: string): Readonly<ContextMetrics> | undefined;
  release?(sessionId: string): void;
  warm?(sessionId: string): Promise<void>;
  maintain?(): Promise<void>;
  resolveUser?(sessionId: string, ref: string): string | undefined;
  referenceUser?(sessionId: string, id: string): string | undefined;
  report?(seed: ReportSeed, signal: AbortSignal): Promise<ReportDraft | undefined>;
}
export type HTTPTransport = (url: string, init: RequestInit) => Promise<Response>;

export async function* parseSSE(stream: ReadableStream<Uint8Array>): AsyncGenerator<{ event?: string; data: string }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '', event: string | undefined, data: string[] = [];
  function line(value: string): { event?: string; data: string } | undefined {
    if (!value) {
      const result = data.length ? { event, data: data.join('\n') } : undefined;
      data = []; event = undefined; return result;
    }
    if (value.startsWith('event:')) event = value.slice(6).trimStart();
    else if (value.startsWith('data:')) data.push(value.slice(5).replace(/^ /, ''));
  }
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (buffer.length > 2_000_000) throw new Error(t("SSE event is too large."));
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const item = line(buffer.slice(0, end).replace(/\r$/, ''));
        buffer = buffer.slice(end + 1);
        if (item) yield item;
      }
      if (done) break;
    }
    if (buffer) line(buffer.replace(/\r$/, ''));
    const tail = line(''); if (tail) yield tail;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export function cleanReply(value: unknown, maxChars: number): Reply {
  if (!value || typeof value !== 'object' || typeof (value as Reply).speak !== 'boolean' || typeof (value as Reply).text !== 'string') throw new Error(t("Model returned an invalid reply."));
  const raw = (value as Reply).text.replace(/<[^>]*>/g, '').replace(/[`*_#]/g, '').trim();
  const actions = parseActions((value as Reply).actions);
  const report = (value as Reply).report === true ? true : parseReport((value as Reply).report);
  const taskResults = parseTaskResults((value as Reply).taskResults);
  const extra = { ...(actions.length ? { actions } : {}), ...(taskResults.length ? { taskResults } : {}), ...(report ? { report: report as ReportDraft | true } : {}) };
  if (!raw || !(value as Reply).speak) return { speak: false, text: '', ...extra };
  let text = raw;
  if (raw.length > maxChars) {
    const prefix = raw.slice(0, maxChars);
    const boundary = Math.max(prefix.lastIndexOf('.'), prefix.lastIndexOf('!'), prefix.lastIndexOf('?'));
    text = boundary >= maxChars / 3 ? prefix.slice(0, boundary + 1) : `${prefix.slice(0, Math.max(1, prefix.lastIndexOf(' ')))}…`;
  }
  return { speak: true, text, ...extra };
}

export class PlusBrain implements Brain {
  private sessions = new Map<string, SessionContext>();
  private activeSessions = new Set<string>();
  private sockets?: ResponsesTransport;
  private requestSequence = 0;
  private submittedPrefixes = new Map<string, { items: number; digest: string }>();
  private readonly settings: { model: string; reasoning: { effort: string; context?: string } };
  readonly transport: HTTPTransport;
  constructor(readonly auth: PlanAuth, readonly config: Config, transport?: HTTPTransport, private observation: { diagnostic?: boolean; tokenAccounting?: boolean } = {}) {
    this.settings = { model: config.model, reasoning: { effort: config.reasoningEffort } };
    if (transport) this.transport = transport;
    else { this.sockets = new ResponsesTransport(config.modelTransport as ResponsesTransportMode); this.transport = this.sockets.fetch; }
  }
  async warm(sessionId: string) {
    this.activeSessions.add(sessionId);
    const token = await this.auth.token();
    if (this.activeSessions.has(sessionId)) await this.sockets?.warm(sessionId, token);
  }
  async maintain() {
    const token = await this.auth.token();
    await Promise.allSettled([...this.activeSessions].map(id => this.sockets?.warm(id, token)));
  }
  contextMetrics(sessionId: string) { return this.sessions.get(sessionId)?.metrics; }
  resolveUser(sessionId: string, ref: string) { return this.sessions.get(sessionId)?.resolveUser(ref); }
  referenceUser(sessionId: string, id: string) { return this.sessions.get(sessionId)?.referenceUser(id); }
  release(sessionId: string) { this.activeSessions.delete(sessionId); this.sockets?.release(sessionId); this.sessions.get(sessionId)?.release(); this.sessions.delete(sessionId); this.submittedPrefixes.delete(sessionId); releaseTokenAccounting(sessionId); }
  async reply(snapshot: RoomSnapshot, signal: AbortSignal, hooks?: ReplyHooks): Promise<Reply> {
    return withLocale(this.config.locale, async () => {
    this.activeSessions.add(snapshot.sessionId);
    const maxChars = Math.min(this.config.maxReplyChars, snapshot.responsePolicy?.maxChars ?? this.config.maxReplyChars);
    let context = this.sessions.get(snapshot.sessionId);
    if (!context) {
      context = new SessionContext(roomInstructions(this.config, snapshot), this.config);
      this.sessions.set(snapshot.sessionId, context);
    }
    const result = await context.run(snapshot, (input, activeSignal) => this.request(input, snapshot.sessionId, activeSignal, hooks, maxChars), signal);
    return cleanReply(JSON.parse(result.text.replace(/^```(?:json)?\s*|\s*```$/g, '')), maxChars);
    });
  }
  async report(seed: ReportSeed, signal: AbortSignal): Promise<ReportDraft | undefined> {
    return withLocale(this.config.locale, async () => {
    // Independent input and cache key: no session history, tools, or model output
    // from this analysis is ever appended to the conversational SessionContext.
    const sessionId = `${seed.session}:report:${crypto.randomUUID()}`;
    const input: InputItem[] = [
      { role: 'developer', content: reviewInstructions(this.config) },
      { role: 'user', content: JSON.stringify({ reason: seed.reason, evidence: seed.evidence }) },
    ];
    try {
      const result = await this.sendRequest(input, sessionId, signal, 0,
        { onTiming: timing => latency({ ...timing, session: sessionId, purpose: 'report' }) }, 1200, true);
      signal.throwIfAborted();
      return parseReport(JSON.parse(result.text).report);
    } finally { this.sockets?.release(sessionId); this.submittedPrefixes.delete(sessionId); releaseTokenAccounting(sessionId); }
    });
  }
  private async request(input: InputItem[], sessionId: string, signal: AbortSignal, hooks?: ReplyHooks, maxChars = this.config.maxReplyChars): Promise<ModelResult> {
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(this.config.maxResponseAgeMs)]);
    let published = false;
    const activeHooks = { onTiming: hooks?.onTiming, onSentence: hooks?.onSentence ? (text: string) => { published = true; hooks.onSentence!(text); } : undefined };
    for (let attempt = 0; ; attempt++) {
      try { return await this.sendRequest(input, sessionId, bounded, attempt, activeHooks, maxChars); }
      catch (error) {
        const code = String((error as { code?: string; cause?: { code?: string } })?.code ?? (error as { cause?: { code?: string } })?.cause?.code ?? '');
        // Once speech has escaped, a retry could repeat it to the room.
        if (published || attempt || bounded.aborted || !['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET'].includes(code)) throw error;
        log(t("ChatGPT connection reset; retrying once."));
        await Bun.sleep(250);
      }
    }
  }
  private async sendRequest(input: InputItem[], sessionId: string, signal: AbortSignal, attempt: number, hooks: ReplyHooks, maxChars: number, reporting = false): Promise<ModelResult> {
    const began = performance.now();
    const request = ++this.requestSequence;
    const timing = (stage: string, extra: Partial<BrainTiming> = {}) => hooks.onTiming?.({ stage, elapsedMs: Math.round(performance.now() - began), attempt, request, compaction: false, ...extra });
    const settings = reporting ? { ...this.settings, reasoning: { effort: 'low' } } : this.settings;
    const body = JSON.stringify({ ...settings, prompt_cache_key: sessionId, input, store: false, stream: true });
    const metrics = this.contextMetrics(sessionId);
    let prefixUnchanged: boolean | undefined;
    let opaqueReasoningBytes: number | undefined;
    if (this.observation.diagnostic ?? diagnosticsEnabled()) {
      const hash = (items: InputItem[]) => createHash('sha256').update(JSON.stringify(items)).digest('hex');
      const previous = this.submittedPrefixes.get(sessionId);
      if (previous) prefixUnchanged = input.length >= previous.items && hash(input.slice(0, previous.items)) === previous.digest;
      this.submittedPrefixes.set(sessionId, { items: input.length, digest: hash(input) });
      opaqueReasoningBytes = input.reduce((n, item) => n + (typeof item.encrypted_content === 'string' ? Buffer.byteLength(item.encrypted_content) : 0), 0);
    }
    timing('request_started', { model: settings.model, reasoningEffort: settings.reasoning.effort,
      bodyBytes: Buffer.byteLength(body), opaqueReasoningBytes, inputItems: input.length, estimatedTokens: metrics?.estimatedTokens,
      appendedBytes: metrics?.appendedBytes, appendedChars: metrics?.appendedChars,
      appendedSpeech: metrics?.appendedSpeech, appendedChat: metrics?.appendedChat, appendedTools: metrics?.appendedTools,
      stateUpdates: metrics?.stateUpdates, rosterUpdates: metrics?.rosterUpdates, prefixUnchanged });
    if (this.observation.tokenAccounting ?? diagnosticsEnabled()) {
      // The tokenizer runs in a bounded worker queue. Its counters and hashes
      // never enter the request body and never delay a sentence or tool action.
      void measureRequestTokens(sessionId, body, (measurement, elapsedMs) => {
        if (!measurement) { timing('token_accounting_dropped'); return; }
        timing('context_tokens', { encoding: measurement.encoding, tokenizationMs: elapsedMs,
          visibleTextTokens: measurement.textTokens, visibleTextBytes: measurement.textBytes,
          sourceTokens: JSON.stringify(measurement.sources), contributors: JSON.stringify(measurement.contributors),
          breakdown: JSON.stringify(measurement.breakdown), appendedTextTokens: measurement.appendedTextTokens,
          appendedSourceTokens: JSON.stringify(measurement.appendedSources), appendedBreakdown: JSON.stringify(measurement.appendedBreakdown),
          appendedContributors: JSON.stringify(measurement.appendedContributors) });
        for (const payload of measurement.payloads) timing('tool_payload_tokens', { ...payload, direction: 'input' });
      });
    }
    let usage: ModelResult['usage'];
    let completed = false, published = false, status: number | undefined, requestId: string | undefined;
    let outcome = 'failed', errorCode: string | undefined;
    try {
      const token = await this.auth.token(signal); timing('auth_ready'); signal.throwIfAborted();
      const response = await this.transport('https://api.openai.com/v1/responses', {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'session-id': sessionId },
        body,
        signal,
      });
      status = response.status;
      const safeHeader = (key: string) => { const value = response.headers.get(key); return value && /^[\w.:/ -]{1,160}$/.test(value) ? value : undefined; };
      requestId = safeHeader('x-request-id');
      timing('response_headers', { status, requestId, retryAfter: safeHeader('retry-after'),
        remainingRequests: safeHeader('x-ratelimit-remaining-requests'), remainingTokens: safeHeader('x-ratelimit-remaining-tokens'),
        resetRequests: safeHeader('x-ratelimit-reset-requests'), resetTokens: safeHeader('x-ratelimit-reset-tokens') });
      timing('transport_selected', { transport: response.headers.get('x-bot-transport') ?? 'http' });
      if (!response.ok) throw await responseError(response);
      if (!response.body) throw new Error(t("OpenAI returned no stream."));
      let text = '';
      let seenEvent = false, seenText = false, seenSentence = false;
      const sentences = hooks.onSentence ? new ReplySentences(maxChars, sentence => {
        signal.throwIfAborted();
        if (!seenSentence) { seenSentence = true; timing('first_sentence'); }
        published = true;
        hooks.onSentence!(sentence);
      }) : undefined;
      const output = new Map<number, InputItem>();
      for await (const event of parseSSE(response.body)) {
        if (event.data === '[DONE]') continue;
        const item = JSON.parse(event.data) as any;
        if (!seenEvent) { seenEvent = true; timing('first_event'); }
        const type = item.type ?? event.event;
        if (type === 'response.output_item.done' && item.item) output.set(item.output_index, item.item);
        if (type === 'response.output_text.delta') {
          if (!seenText && item.delta) { seenText = true; timing('first_text'); }
          text += item.delta ?? '';
        }
        if (text.length > (reporting ? 4000 : 20000)) throw new Error(t("Model reply is too long."));
        if (type === 'response.output_text.delta') sentences?.feed(text);
        if (type === 'error' || type === 'response.failed') {
          usage = item.response?.usage;
          const error = item.response?.error ?? item.error ?? item;
          throw new OpenAIError(0, error.code ?? 'response_failed', String(error.message ?? 'OpenAI generation failed'));
        }
        if (type === 'response.incomplete') { usage = item.response?.usage; throw new OpenAIError(0, 'response_incomplete', 'OpenAI response was incomplete.'); }
        if (type === 'response.completed') {
          completed = true;
          usage = item.response?.usage;
          if (item.response?.output?.length) for (const [index, value] of item.response.output.entries()) output.set(index, value);
          if (!text) text = (item.response?.output ?? []).flatMap((o: any) => o.content ?? []).filter((c: any) => c.type === 'output_text').map((c: any) => c.text).join('');
          // Completion is terminal. Proxies may keep the HTTP stream open; waiting
          // for its EOF can hold a finished reply until a timeout or connection reset.
          break;
        }
      }
      if (!completed) throw new Error(t("OpenAI stream ended before response.completed; reply will not be spoken."));
      const items = [...output.entries()].sort(([a], [b]) => a - b).map(([, value]) => value);
      if (!text) text = items.flatMap(o => o.content ?? []).filter(c => c.type === 'output_text').map(c => c.text).join('');
      if (reporting && text.length > 4000) throw new Error(t("Model report is too long."));
      // Some transports send only deltas and completion; retain the visible decision
      // even then. Normal Responses streams preserve the exact provider items.
      if (!items.length && text) items.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] });
      signal.throwIfAborted();
      sentences?.finish(cleanReply(JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '')), maxChars));
      timing('model_completed', { inputTokens: usage?.input_tokens, cachedTokens: usage?.input_tokens_details?.cached_tokens, outputTokens: usage?.output_tokens, reasoningTokens: usage?.output_tokens_details?.reasoning_tokens });
      if (this.observation.tokenAccounting ?? diagnosticsEnabled()) {
        void measureRequestTokens(sessionId, JSON.stringify({ input: [{ role: 'assistant', content: text }] }), (measurement, elapsedMs) => {
          if (!measurement) { timing('token_accounting_dropped', { direction: 'output' }); return; }
          timing('response_text_tokens', { encoding: measurement.encoding, tokenizationMs: elapsedMs, visibleTextTokens: measurement.textTokens,
            sourceTokens: JSON.stringify(measurement.sources), contributors: JSON.stringify(measurement.contributors), breakdown: JSON.stringify(measurement.breakdown) });
          for (const payload of measurement.payloads) timing('tool_payload_tokens', { ...payload, direction: 'output' });
        }, true);
      }
      outcome = 'completed';
      return { text, output: items, usage };
    } catch (error) {
      const code = error instanceof OpenAIError ? error.code : (error as any)?.code ?? (error as any)?.name ?? 'unknown';
      errorCode = /^[\w.-]{1,100}$/.test(String(code)) ? String(code) : 'unknown';
      if (signal.aborted) outcome = signal.reason?.name === 'TimeoutError' ? 'timeout' : 'canceled';
      if (error instanceof OpenAIError) {
        status ||= error.status;
        if (!requestId && error.requestId && /^[\w.:-]{1,160}$/.test(error.requestId)) requestId = error.requestId;
      }
      throw error;
    } finally {
      // Record attempts even when canceled after the server starts work. Missing
      // usage means unknown consumption, never zero and never an estimated bill.
      timing('request_ended', { outcome, responseCompleted: completed, published, status, requestId, errorCode,
        usageKnown: typeof usage?.input_tokens === 'number' && typeof usage?.output_tokens === 'number',
        inputTokens: usage?.input_tokens, cachedTokens: usage?.input_tokens_details?.cached_tokens,
        cacheWriteTokens: usage?.input_tokens_details?.cache_write_tokens,
        outputTokens: usage?.output_tokens, reasoningTokens: usage?.output_tokens_details?.reasoning_tokens });
    }
  }
}
