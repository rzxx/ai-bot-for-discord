import { t } from './locale';
import { publicResultUrl, safeText } from './tool-safety';
import { createPageReader, type PublicPage } from './search-http';
import { compactResults, extractPage, rankResults } from './search-text';
import { get_encoding } from 'tiktoken';

export interface SearchResult { title: string; snippet: string; url: string; via?: 'page' | 'snippet'; published?: string }
export interface SearchOptions { excludeUrls?: string[]; previous?: SearchResult[] }
export type SearchProvider = (query: string, signal: AbortSignal, options?: SearchOptions) => Promise<SearchResult[]>;
type SearchHTTP = (url: URL, init: RequestInit) => Promise<Response>;
const endpoint = 'https://html.duckduckgo.com/html/';
function decode(value: string) {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (_, entity: string) => {
    if (entity[0] === '#') {
      const n = entity[1]?.toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
    }
    return ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' } as Record<string, string>)[entity.toLowerCase()] ?? '';
  });
}
export function parseSearch(html: string, limit = 3): SearchResult[] {
  const anchors = [...html.matchAll(/<a\b([^>]*\bclass\s*=\s*["'][^"']*\bresult__a\b[^"']*["'][^>]*)>([\s\S]*?)<\/a>/gi)];
  const results: SearchResult[] = [];
  for (const [index, match] of anchors.entries()) {
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(match[1]!)?.[1];
    if (!href) continue;
    let target: string;
    try {
      const link = new URL(decode(href), endpoint);
      target = link.hostname === 'duckduckgo.com' || link.hostname.endsWith('.duckduckgo.com') ? link.searchParams.get('uddg') ?? link.toString() : link.toString();
    } catch { continue; }
    const url = publicResultUrl(target);
    if (!url || results.some(r => r.url === url)) continue;
    const following = html.slice(match.index! + match[0].length, anchors[index + 1]?.index ?? html.length);
    const snippet = /<(?:a|div|span)\b[^>]*class\s*=\s*["'][^"']*\bresult__snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div|span)>/i.exec(following)?.[1] ?? '';
    const title = safeText(decode(match[2]!), 120), text = safeText(decode(snippet), 420);
    if (title && text) results.push({ title, snippet: text, url });
    if (results.length === limit) break;
  }
  return results;
}

export function publicQuery(query: string) {
  return query.length >= 3 && query.length <= 180 && !/(?:https?:|www\.|@|(?:\+?\d[\s()-]*){7,}|sk-|eyJ|[\r\n])/i.test(query);
}
let encoder: ReturnType<typeof get_encoding> | undefined;
export async function runLocalSearch(query: string, signal: AbortSignal, options: SearchOptions = {}, io: {
  http: SearchHTTP; readPage: (url: string, signal: AbortSignal) => Promise<PublicPage>;
} = { http: fetch, readPage: createPageReader() }): Promise<SearchResult[]> {
  if (!publicQuery(query)) throw new Error(t("Use a short public search query without personal data or links."));
  signal.throwIfAborted();
  const url = new URL(endpoint); url.searchParams.set('q', query); url.searchParams.set('kp', '1');
  const response = await io.http(url, { signal, redirect: 'error', credentials: 'omit', headers: { Accept: 'text/html', 'User-Agent': 'DiscordVoiceCompanion/0.1 (bounded search)' } });
  if (!response.ok) { await response.body?.cancel(); throw new Error(t("Search unavailable (HTTP {0}).", response.status)); }
  if (!response.headers.get('content-type')?.includes('text/html')) { await response.body?.cancel(); throw new Error(t("Search returned an unsupported format.")); }
  if (!response.body) throw new Error(t("Empty search result."));
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let html = '', bytes = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 300000) throw new Error(t("Search response is too large."));
      html += decoder.decode(value, { stream: true });
    }
    html += decoder.decode();
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const discovered = parseSearch(html, 10);
  if (!discovered.length) throw new Error(t("No excerpts available: search may require a CAPTCHA."));
  const results = rankResults(query, discovered, options.excludeUrls);
  if (!results.length) return [];
  // Two independent bounded reads in parallel, not a browser/research loop.
  // A failed, blocked, oversized or slow page simply keeps its search snippet.
  const reads = await Promise.allSettled(results.slice(0, 2).map(async result => {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(1400)]);
    const page = await abortable(io.readPage(result.url, deadline), deadline);
    const passage = extractPage(query, page.text, page.type.startsWith('text/plain'));
    if (passage.snippet) Object.assign(result, passage, { url: page.url, via: 'page' });
  }));
  // Inspect failures without surfacing network details or losing discovery.
  for (const read of reads) if (read.status === 'rejected') signal.throwIfAborted();
  signal.throwIfAborted();
  encoder ??= get_encoding('o200k_base');
  return compactResults(query, results, text => encoder!.encode(text, [], []).length, 360, options.previous);
}

export function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = () => reject(signal.reason);
    signal.addEventListener('abort', cancel, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
    if (signal.aborted) cancel();
  });
}

/** Retrieval and real-token budgeting run on this machine, off Discord's audio
 * thread. Each job has its own worker; cancellation releases parsing and I/O. */
export function createWebSearch(http?: SearchHTTP): SearchProvider {
  // Injectable discovery-only transport keeps existing offline fixtures useful.
  if (http) return (query, signal, options) => runLocalSearch(query, signal, options, { http,
    readPage: async () => { throw new Error(t("No injected page reader")); } });
  return (query, signal, options) => {
    if (!publicQuery(query)) return Promise.reject(new Error(t("A public search query is required.")));
    return new Promise((resolve, reject) => {
      signal.throwIfAborted();
      const worker = new Worker(new URL('./search-worker.ts', import.meta.url).href);
      const timeout = setTimeout(() => finish(new Error(t("Search deadline exceeded."))), 8000);
      const finish = (error?: Error, results?: SearchResult[]) => {
        clearTimeout(timeout); signal.removeEventListener('abort', cancel); worker.terminate();
        if (error) reject(error); else resolve(results ?? []);
      };
      const cancel = () => finish(new Error(t("Search canceled.")));
      signal.addEventListener('abort', cancel, { once: true });
      worker.onmessage = ({ data }: MessageEvent<{ results?: SearchResult[]; failed?: boolean }>) => finish(data.failed ? new Error(t("No search results available.")) : undefined, data.results);
      worker.onerror = () => finish(new Error(t("Search unavailable.")));
      worker.postMessage({ query, options });
    });
  };
}
