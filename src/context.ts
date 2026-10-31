import { t } from './locale';
import type { RoomSnapshot } from './llm';
import { ContextWire } from './context-wire';

export type InputItem = Record<string, any>;
export interface ModelUsage {
  input_tokens?: number; output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
}
export interface ModelResult { text: string; output: InputItem[]; usage?: ModelUsage }
export type ContextRequest = (input: InputItem[], signal: AbortSignal) => Promise<ModelResult>;
export interface ContextOptions { contextMaxTokens: number }
export interface ContextMetrics {
  calls: number; retainedItems: number; estimatedTokens: number; submittedThroughEventId: number;
  lastInputTokens: number | null; lastCachedTokens: number | null;
  totalInputTokens: number; totalCachedTokens: number; totalOutputTokens: number;
  appendedChars: number;
  appendedBytes: number; appendedSpeech: number; appendedChat: number; appendedTools: number; stateUpdates: number; rosterUpdates: number;
}
export class ContextLimitError extends Error {
  constructor() { super(t("Session context limit reached. History is preserved without trimming; start a new session with /leave and /join.")); }
}
interface Entry { item: InputItem; tokens: number }
function estimate(item: InputItem): number {
  const { encrypted_content: _, ...visible } = item;
  return Math.ceil(Buffer.byteLength(JSON.stringify(visible), 'utf8') / 3) + 12;
}

/** Every submitted prefix remains byte-for-byte immutable until /leave.
 * No rolling windows, summaries, history rebuilds or automatic session rotation. */
export class SessionContext {
  private entries: Entry[];
  private through = 0;
  private observedTokens = 0;
  private observedItems = 0;
  private released = false;
  private running = false;
  private wire = new ContextWire();
  readonly metrics: ContextMetrics = {
    calls: 0, retainedItems: 1, estimatedTokens: 0, submittedThroughEventId: 0,
    lastInputTokens: null, lastCachedTokens: null,
    totalInputTokens: 0, totalCachedTokens: 0, totalOutputTokens: 0, appendedChars: 0,
    appendedBytes: 0, appendedSpeech: 0, appendedChat: 0, appendedTools: 0, stateUpdates: 0, rosterUpdates: 0,
  };
  constructor(readonly instructions: string, readonly options: ContextOptions) {
    const item = { role: 'developer', content: instructions };
    this.entries = [{ item, tokens: estimate(item) }]; this.refresh();
  }
  resolveUser(ref: string) { return this.wire.resolve(ref); }
  referenceUser(id: string) { return this.wire.ref(id); }
  private append(item: InputItem, tokens = estimate(item)) { this.entries.push({ item, tokens }); this.refresh(); }
  private refresh() {
    this.metrics.retainedItems = this.entries.length;
    this.metrics.estimatedTokens = this.observedTokens + this.entries.slice(this.observedItems).reduce((n, e) => n + e.tokens, 0);
  }
  async run(snapshot: RoomSnapshot, request: ContextRequest, signal: AbortSignal): Promise<ModelResult> {
    if (this.running) throw new Error(t("Concurrent requests in one voice session are forbidden."));
    this.running = true;
    try {
      if (this.released) throw new Error(t("Voice session context is already closed."));
      signal.throwIfAborted();
      if (this.metrics.estimatedTokens >= this.options.contextMaxTokens) throw new ContextLimitError();
      const events = snapshot.events.filter(e => e.id > this.through).sort((a, b) => a.at - b.at || a.id - b.id);
      const update = this.wire.encode(snapshot, events);
      const content = JSON.stringify(update);
      this.metrics.appendedChars = content.length;
      this.metrics.appendedBytes = Buffer.byteLength(content);
      this.metrics.appendedSpeech = events.filter(e => e.kind === 'speech').length;
      this.metrics.appendedChat = events.filter(e => e.kind === 'chat').length;
      this.metrics.appendedTools = events.filter(e => e.kind === 'tool').length;
      this.metrics.stateUpdates = Array.isArray(update.s) ? update.s.length : 0;
      this.metrics.rosterUpdates = Array.isArray(update.p) ? update.p.length : 0;
      this.through = Math.max(this.through, ...events.map(e => e.id));
      this.append({ role: 'user', content });
      // Keep this tail too if the budget is reached: never undo a submitted prefix.
      if (this.metrics.estimatedTokens >= this.options.contextMaxTokens) throw new ContextLimitError();
      this.metrics.submittedThroughEventId = this.through;
      const result = await request(this.entries.map(e => e.item), signal);
      signal.throwIfAborted();
      if (this.released) throw new Error(t("Voice session context is already closed."));
      const usage = result.usage;
      this.metrics.calls++;
      this.metrics.lastInputTokens = usage?.input_tokens ?? null;
      this.metrics.lastCachedTokens = usage?.input_tokens_details?.cached_tokens ?? null;
      this.metrics.totalInputTokens += usage?.input_tokens ?? 0;
      this.metrics.totalCachedTokens += usage?.input_tokens_details?.cached_tokens ?? 0;
      this.metrics.totalOutputTokens += usage?.output_tokens ?? 0;
      const reasoningItems = result.output.filter(item => item.type === 'reasoning').length;
      for (const item of result.output) this.append(structuredClone(item), item.type === 'reasoning'
        ? Math.ceil((usage?.output_tokens_details?.reasoning_tokens ?? 0) / Math.max(1, reasoningItems)) + 12 : estimate(item));
      if (usage?.input_tokens !== undefined) {
        this.observedTokens = usage.input_tokens + (usage.output_tokens ?? 0); this.observedItems = this.entries.length;
      }
      this.refresh(); return result;
    } finally { this.running = false; }
  }
  release() { this.released = true; this.entries = []; this.observedItems = 0; this.observedTokens = 0; this.refresh(); }
}
