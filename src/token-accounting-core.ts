import { t } from './locale';
import { createHash } from 'node:crypto';
import { get_encoding } from 'tiktoken';

export interface TokenSource { source: string; bytes: number; tokens: number }
export interface TokenContributor {
  kind: 'speech' | 'chat' | 'assistant'; person?: string; events: number;
  wireBytes: number; wireTokens: number; textBytes: number; textTokens: number;
  contentWireBytes?: number; contentWireTokens?: number; toolCallWireBytes?: number; toolCallWireTokens?: number;
}
export interface TokenPayload { tool: string; kind: 'result' | 'call'; event?: number; status?: string; bytes: number; tokens: number; hash: string; fields: string; fieldSizes: string; results?: number }
export interface TokenMeasurement {
  encoding: string; textTokens: number; textBytes: number; opaqueBytes: number;
  sources: TokenSource[]; payloads: TokenPayload[]; contributors: TokenContributor[];
  appendedTextTokens: number; appendedTextBytes: number; appendedSources: TokenSource[];
  breakdown: TokenSource[]; appendedBreakdown: TokenSource[]; appendedContributors: TokenContributor[];
}
type Span = { start: number; end: number; source: string; contributor?: TokenContributor };
const tools = new Set(['message', 'remind', 'cancel_reminder', 'reminders', 'activity', 'members', 'search', 'chat']);
const toolName = (value: unknown) => typeof value === 'string' && tools.has(value) ? value : 'unknown';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

function endOfValue(text: string, start: number): number {
  if (text[start] === '"') {
    for (let at = start + 1; at < text.length; at++) {
      if (text[at] === '\\') at++;
      else if (text[at] === '"') return at + 1;
    }
  } else if (text[start] === '[' || text[start] === '{') {
    let depth = 1;
    for (let at = start + 1; at < text.length; at++) {
      if (text[at] === '"') at = endOfValue(text, at) - 1;
      else if (text[at] === '[' || text[at] === '{') depth++;
      else if ((text[at] === ']' || text[at] === '}') && !--depth) return at + 1;
    }
  } else {
    let at = start;
    while (at < text.length && !/[\s,\]}]/.test(text[at]!)) at++;
    return at;
  }
  throw new Error(t("Invalid accounting JSON"));
}
function ranges(text: string, start = 0, object = true) {
  const output: { key: string; start: number; end: number }[] = [];
  let at = start + 1;
  while (at < text.length) {
    while (/[\s,]/.test(text[at] ?? '')) at++;
    if (text[at] === (object ? '}' : ']')) break;
    let key = String(output.length);
    if (object) {
      const end = endOfValue(text, at); key = JSON.parse(text.slice(at, end)); at = end;
      while (/[\s:]/.test(text[at] ?? '')) at++;
    }
    const end = endOfValue(text, at); output.push({ key, start: at, end }); at = end;
  }
  return output;
}

/** Exact o200k BPE counts of visible text, not a reconstruction of the hidden
 * provider message template. Every token is assigned once by its starting byte;
 * this makes source totals additive even when tokens straddle JSON boundaries. */
export class TokenCounter {
  private encoder = get_encoding('o200k_base');
  private lengths = new Uint16Array(200100);
  private cache = new Map<string, TokenMeasurement>();
  private cachedBytes = 0;
  count(text: string) { return this.encoder.encode(text, [], []).length; }
  private payload(text: string, value: any, kind: TokenPayload['kind']): TokenPayload {
    const permitted = new Set(['tool', 'event', 'status', 'reason', 'name', 'presenceStatus', 'presenceAvailable', 'activity', 'text', 'mentions', 'query', 'seconds', 'id', 'items', 'results', 'continue', 'next', 'round', 'op', 'person', 'fields', 'kind', 'scope', 'online', 'count', 'columns', 'rows', 'complete', 'unknown']);
    const sizes = new Map<string, { field: string; bytes: number; tokens: number }>();
    const add = (field: string, content: unknown) => {
      const serialized = JSON.stringify(content); if (serialized === undefined) return;
      const row = sizes.get(field) ?? { field, bytes: 0, tokens: 0 };
      row.bytes += Buffer.byteLength(serialized); row.tokens += this.count(serialized); sizes.set(field, row);
    };
    for (const field of Object.keys(value ?? {}).filter(key => permitted.has(key))) {
      if (field === 'results' && Array.isArray(value.results)) for (const result of value.results.slice(0, 3)) {
        for (const leaf of ['title', 'snippet', 'url', 'via', 'published']) if (typeof result?.[leaf] === 'string') add(`results.${leaf}`, result[leaf]);
      } else add(field, value[field]);
    }
    return { tool: toolName(value?.tool), kind, event: Number.isSafeInteger(value?.event) ? value.event : undefined,
      status: typeof value?.status === 'string' && /^[\w-]{1,40}$/.test(value.status) ? value.status : undefined,
      bytes: Buffer.byteLength(text), tokens: this.count(text), hash: hash(text),
      fields: Object.keys(value ?? {}).filter(key => permitted.has(key)).sort().join(','),
      fieldSizes: JSON.stringify([...sizes.values()]),
      results: Array.isArray(value?.results) ? value.results.length : undefined };
  }
  private text(text: string, role: string): TokenMeasurement {
    const key = hash(role + '\0' + text), cached = this.cache.get(key);
    if (cached) return cached;
    const spans: Span[] = [], leaves: Span[] = [], payloads: TokenPayload[] = [], contributors: TokenContributor[] = [];
    let replyText = '';
    const fallback = role === 'developer' || role === 'system' ? 'instructions' : role === 'assistant' ? 'assistant' : 'metadata';
    let detailFallback = fallback === 'instructions' ? 'instructions' : `unclassified_${role === 'assistant' ? 'assistant' : 'user'}_text`;
    const assistant: TokenContributor | undefined = role === 'assistant' ? { kind: 'assistant', events: 1,
      wireBytes: Buffer.byteLength(text), wireTokens: 0, textBytes: 0, textTokens: 0,
      contentWireBytes: 0, contentWireTokens: 0, toolCallWireBytes: 0, toolCallWireTokens: 0 } : undefined;
    const contentSpan = (span: { start: number; end: number }, source: string, contributor?: TokenContributor) => {
      leaves.push({ ...span, source, contributor });
      if (contributor) contributor.contentWireBytes = Buffer.byteLength(text.slice(span.start, span.end));
    };
    if (role === 'user' || role === 'assistant') {
      try {
        const value = JSON.parse(role === 'assistant' ? text.replace(/^```(?:json)?\s*|\s*```$/g, '') : text);
        if (value && typeof value === 'object' && !Array.isArray(value)) detailFallback = role === 'assistant' ? 'assistant_metadata' : 'request_metadata';
        if (value && typeof value === 'object' && !Array.isArray(value)) for (const field of ranges(text, text.indexOf('{'))) {
          if (role === 'user' && ['p', 's', 'cap'].includes(field.key)) spans.push({ ...field, source: field.key === 's' ? 'presence' : field.key === 'p' ? 'roster' : 'capabilities' });
          if (role === 'user' && field.key === 'e' && Array.isArray(value.e)) for (const event of ranges(text, field.start, false)) {
            const data = JSON.parse(text.slice(event.start, event.end));
            const kind = data?.[1], tool = kind === 'tool' ? toolName(data?.[4]?.tool) : '';
            const fields = ranges(text, event.start, false), body = fields[4];
            let contributor: TokenContributor | undefined;
            if ((kind === 'speech' || kind === 'chat') && typeof data?.[4] === 'string') {
              contributor = { kind, person: /^u[1-9]\d{0,5}$/.test(String(data[3])) ? data[3] : undefined,
                events: 1, wireBytes: Buffer.byteLength(text.slice(event.start, event.end)), wireTokens: 0,
                textBytes: Buffer.byteLength(data[4]), textTokens: this.count(data[4]), contentWireBytes: 0, contentWireTokens: 0 };
              contributors.push(contributor);
              if (body && data[4]) contentSpan(body, `${kind}_text`, contributor);
            }
            spans.push({ ...event, contributor, source: tool ? `tool_result:${tool}` : kind === 'speech' ? 'speech' : kind === 'chat' ? 'chat' : 'playback' });
            if (body && tool) contentSpan(body, `tool_result:${tool}`);
            else if (body && !contributor && typeof data?.[4] === 'string' && data[4]) contentSpan(body, 'playback_text');
            if (tool && data[4] && typeof data[4] === 'object') {
              const receipt = body!;
              payloads.push(this.payload(text.slice(receipt.start, receipt.end), data[4], 'result'));
            }
          }
          if (role === 'assistant' && field.key === 'text' && typeof value.text === 'string') {
            replyText = value.text;
            if (replyText) contentSpan(field, 'assistant_text', assistant);
          }
          if (role === 'assistant' && field.key === 'actions' && Array.isArray(value.actions)) for (const action of ranges(text, field.start, false)) {
            const data = JSON.parse(text.slice(action.start, action.end));
            spans.push({ ...action, source: `tool_call:${toolName(data?.tool)}` });
            if (assistant) assistant.toolCallWireBytes! += Buffer.byteLength(text.slice(action.start, action.end));
            payloads.push(this.payload(text.slice(action.start, action.end), data, 'call'));
          }
        }
      } catch {
        spans.length = 0; leaves.length = 0; payloads.length = 0; contributors.length = 0; replyText = '';
        detailFallback = `unclassified_${role === 'assistant' ? 'assistant' : 'user'}_text`;
        if (assistant) { assistant.contentWireBytes = 0; assistant.toolCallWireBytes = 0; }
      }
    }
    const byteSpans = spans.sort((a, b) => a.start - b.start).map(s => ({
      start: Buffer.byteLength(text.slice(0, s.start)), end: Buffer.byteLength(text.slice(0, s.end)), source: s.source, contributor: s.contributor,
    }));
    const byteLeaves = leaves.sort((a, b) => a.start - b.start).map(s => ({ ...s,
      start: Buffer.byteLength(text.slice(0, s.start)), end: Buffer.byteLength(text.slice(0, s.end)) }));
    const detailSource = (source: string) => source === 'speech' ? 'speech_metadata' : source === 'chat' ? 'chat_metadata'
      : source === 'playback' ? 'playback_metadata' : source.startsWith('tool_result:') ? 'tool_event_metadata' : source;
    const sources = new Map<string, TokenSource>();
    const breakdown = new Map<string, TokenSource>();
    const source = (name: string) => { let row = sources.get(name); if (!row) { row = { source: name, bytes: 0, tokens: 0 }; sources.set(name, row); } return row; };
    const part = (name: string) => { let row = breakdown.get(name); if (!row) { row = { source: name, bytes: 0, tokens: 0 }; breakdown.set(name, row); } return row; };
    source(fallback).bytes = Buffer.byteLength(text);
    part(detailFallback).bytes = Buffer.byteLength(text);
    for (const span of byteSpans) { const bytes = span.end - span.start; source(span.source).bytes += bytes; source(fallback).bytes -= bytes; }
    for (const span of byteSpans) { const bytes = span.end - span.start; part(detailSource(span.source)).bytes += bytes; part(detailFallback).bytes -= bytes; }
    let parentIndex = 0;
    for (const leaf of byteLeaves) {
      while (parentIndex < byteSpans.length && byteSpans[parentIndex]!.end <= leaf.start) parentIndex++;
      const parent = byteSpans[parentIndex], bytes = leaf.end - leaf.start;
      part(parent && parent.start <= leaf.start && parent.end >= leaf.end ? detailSource(parent.source) : detailFallback).bytes -= bytes;
      part(leaf.source).bytes += bytes;
    }
    const ids = this.encoder.encode(text, [], []);
    let offset = 0, spanIndex = 0, leafIndex = 0;
    for (const id of ids) {
      while (spanIndex < byteSpans.length && offset >= byteSpans[spanIndex]!.end) spanIndex++;
      const span = byteSpans[spanIndex];
      const matched = span && offset >= span.start && offset < span.end ? span : undefined;
      source(matched?.source ?? fallback).tokens++;
      if (matched?.contributor) matched.contributor.wireTokens++;
      if (assistant && matched?.source.startsWith('tool_call:')) assistant.toolCallWireTokens!++;
      while (leafIndex < byteLeaves.length && offset >= byteLeaves[leafIndex]!.end) leafIndex++;
      const leaf = byteLeaves[leafIndex], content = leaf && offset >= leaf.start && offset < leaf.end ? leaf : undefined;
      part(content?.source ?? (matched ? detailSource(matched.source) : detailFallback)).tokens++;
      if (content?.contributor) content.contributor.contentWireTokens!++;
      let length = this.lengths[id];
      if (!length) { length = this.encoder.decode(Uint32Array.of(id)).length + 1; if (id < this.lengths.length) this.lengths[id] = length; }
      offset += length - 1;
    }
    if (assistant) {
      assistant.wireTokens = ids.length; assistant.textBytes = Buffer.byteLength(replyText); assistant.textTokens = this.count(replyText);
      contributors.push(assistant);
    }
    const measurement: TokenMeasurement = { encoding: 'o200k_base', textTokens: ids.length, textBytes: Buffer.byteLength(text), opaqueBytes: 0,
      sources: [...sources.values()].filter(s => s.bytes || s.tokens), payloads, contributors,
      appendedTextTokens: 0, appendedTextBytes: 0, appendedSources: [],
      breakdown: [...breakdown.values()].filter(s => s.bytes || s.tokens), appendedBreakdown: [], appendedContributors: [] };
    this.cache.set(key, measurement); this.cachedBytes += measurement.textBytes;
    while (this.cache.size > 512 || this.cachedBytes > 4_000_000) {
      const first = this.cache.keys().next().value!; this.cachedBytes -= this.cache.get(first)!.textBytes; this.cache.delete(first);
    }
    return measurement;
  }
  measure(input: Record<string, any>[], fromItem = 0): TokenMeasurement {
    const total: TokenMeasurement = { encoding: 'o200k_base', textTokens: 0, textBytes: 0, opaqueBytes: 0, sources: [], payloads: [], contributors: [],
      appendedTextTokens: 0, appendedTextBytes: 0, appendedSources: [], breakdown: [], appendedBreakdown: [], appendedContributors: [] };
    const sources = new Map<string, TokenSource>(), appended = new Map<string, TokenSource>();
    const contributors = new Map<string, TokenContributor>();
    const breakdown = new Map<string, TokenSource>(), appendedBreakdown = new Map<string, TokenSource>();
    const appendedContributors = new Map<string, TokenContributor>();
    const addContributors = (target: Map<string, TokenContributor>, rows: TokenContributor[]) => {
      for (const row of rows) {
        const key = `${row.kind}:${row.person ?? ''}`, previous = target.get(key) ?? { ...row, events: 0, wireTokens: 0, wireBytes: 0, textTokens: 0, textBytes: 0,
          contentWireTokens: 0, contentWireBytes: 0, toolCallWireTokens: 0, toolCallWireBytes: 0 };
        for (const field of ['events', 'wireTokens', 'wireBytes', 'textTokens', 'textBytes', 'contentWireTokens', 'contentWireBytes', 'toolCallWireTokens', 'toolCallWireBytes'] as const) previous[field] = (previous[field] ?? 0) + (row[field] ?? 0);
        target.set(key, previous);
      }
    };
    const addSources = (target: Map<string, TokenSource>, rows: TokenSource[]) => {
      for (const row of rows) {
        const previous = target.get(row.source) ?? { source: row.source, bytes: 0, tokens: 0 };
        previous.bytes += row.bytes; previous.tokens += row.tokens; target.set(row.source, previous);
      }
    };
    for (const [index, item] of input.entries()) {
      total.opaqueBytes += typeof item.encrypted_content === 'string' ? Buffer.byteLength(item.encrypted_content) : 0;
      const texts = typeof item.content === 'string' ? [item.content] : Array.isArray(item.content)
        ? item.content.flatMap((part: any) => typeof part.text === 'string' ? [part.text] : []) : [];
      for (const text of texts) {
        const result = this.text(text, item.role ?? 'assistant');
        total.textTokens += result.textTokens; total.textBytes += result.textBytes;
        if (index >= fromItem) {
          total.payloads.push(...result.payloads); total.appendedTextTokens += result.textTokens; total.appendedTextBytes += result.textBytes;
          addSources(appended, result.sources);
          addSources(appendedBreakdown, result.breakdown); addContributors(appendedContributors, result.contributors);
        }
        addSources(sources, result.sources);
        addSources(breakdown, result.breakdown); addContributors(contributors, result.contributors);
      }
    }
    total.sources = [...sources.values()]; total.appendedSources = [...appended.values()]; total.contributors = [...contributors.values()];
    total.breakdown = [...breakdown.values()]; total.appendedBreakdown = [...appendedBreakdown.values()]; total.appendedContributors = [...appendedContributors.values()]; return total;
  }
  close() { this.encoder.free(); this.cache.clear(); }
}
