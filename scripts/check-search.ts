import { createWebSearch } from '../src/web-search';
import { get_encoding } from 'tiktoken';

// Opt-in live public lookup. No model call, API key, room context or bot restart.
const query = process.argv.slice(2).join(' ') || 'Minecraft Java Edition 1.21.5 release date';
const began = performance.now();
const results = await createWebSearch()(query, AbortSignal.timeout(8000));
const elapsedMs = Math.round(performance.now() - began), encoder = get_encoding('o200k_base');
try {
  console.log(JSON.stringify({ query, elapsedMs, encoding: 'o200k_base', resultTokens: encoder.encode(JSON.stringify(results), [], []).length, results }, null, 2));
} finally { encoder.free(); }
