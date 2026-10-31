import { runLocalSearch, type SearchOptions } from './web-search';

self.onmessage = async ({ data }: MessageEvent<{ query: string; options?: SearchOptions }>) => {
  try { self.postMessage({ results: await runLocalSearch(data.query, AbortSignal.timeout(7500), data.options) }); }
  catch { self.postMessage({ failed: true }); }
};
