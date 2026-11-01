import { withAbort } from './abort';
import { safeText, publicResultUrl } from './tool-safety';
import { canonicalUrl } from './search-text';
import type { SearchProvider, SearchResult } from './web-search';

export function boundedSearchResults(results: SearchResult[], previous: SearchResult[] = []): SearchResult[] {
  return results.slice(0, 6).flatMap<SearchResult>(result => {
    const safe = publicResultUrl(result.url), url = safe && canonicalUrl(safe);
    const title = safeText(result.title, 80), snippet = safeText(result.snippet, 650);
    return url && url.length <= 350 && title && snippet && !previous.some(r => r.url === url && r.snippet === snippet)
      ? [{ title, url, snippet, via: result.via === 'page' ? 'page' : 'snippet',
        ...(result.published && /^\d{4}-\d{2}-\d{2}$/.test(result.published) ? { published: result.published } : {}) }] : [];
  }).slice(0, 3);
}

/** Bounded session-local research cache. Concurrent consumers share network work;
 * canceling one consumer cannot cancel the others. Nothing enters model history
 * until the room admits a run carrying the result. */
export class TaskResearch {
  private cache = new Map<string, { at: number; results: SearchResult[] }>();
  private pending = new Map<string, { abort: AbortController; users: number; promise: Promise<SearchResult[]> }>();
  private lifetime = new AbortController();
  constructor(private provider: SearchProvider, private timeoutMs: number, private now: () => number = Date.now) {}
  private key(query: string) { return query.toLowerCase().trim().replace(/\s+/g, ' '); }
  remember(query: string, results: SearchResult[]) {
    if (this.lifetime.signal.aborted || !results.length) return;
    const key = this.key(query); this.cache.delete(key);
    this.cache.set(key, { at: this.now(), results: structuredClone(results) });
    if (this.cache.size > 32) this.cache.delete(this.cache.keys().next().value!);
  }
  async search(query: string, signal: AbortSignal, admit: () => boolean): Promise<{ status: string; results?: SearchResult[] }> {
    signal.throwIfAborted(); this.lifetime.signal.throwIfAborted();
    const key = this.key(query), cached = this.cache.get(key);
    if (cached && this.now() - cached.at < 300000) return { status: 'ready', results: structuredClone(cached.results) };
    let job = this.pending.get(key);
    if (!job) {
      if (this.pending.size >= 2 || !admit()) return { status: 'cooldown' };
      const abort = new AbortController();
      const bounded = AbortSignal.any([this.lifetime.signal, abort.signal, AbortSignal.timeout(this.timeoutMs)]);
      const created = { abort, users: 0, promise: Promise.resolve([] as SearchResult[]) };
      // Keep the pending slot until the underlying provider settles. A timeout
      // releases consumers, not an ignoring provider's network-concurrency slot.
      const actual = Promise.resolve().then(() => { bounded.throwIfAborted(); return this.provider(query, bounded); });
      created.promise = withAbort(actual, bounded).then(results => {
        const excerpts = boundedSearchResults(results); this.remember(query, excerpts); return excerpts;
      });
      void created.promise.catch(() => {});
      void actual.catch(() => {}).finally(() => { if (this.pending.get(key) === created) this.pending.delete(key); });
      this.pending.set(key, created); job = created;
    }
    job.users++;
    try {
      const results = await withAbort(job.promise, signal);
      return { status: results.length ? 'ready' : 'unavailable', ...(results.length ? { results: structuredClone(results) } : {}) };
    } finally { if (--job.users === 0) job.abort.abort(); }
  }
  close() { this.lifetime.abort(); for (const job of this.pending.values()) job.abort.abort(); this.cache.clear(); }
}
