import { t } from './locale';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import ipaddr from 'ipaddr.js';
import { publicResultUrl } from './tool-safety';

interface Address { address: string; family: number }
interface PageResponse { status: number; location?: string; type: string; text: string }
export interface PublicPage { url: string; type: string; text: string }
interface PageIO {
  resolve(host: string): Promise<Address[]>;
  request(url: URL, address: Address, signal: AbortSignal): Promise<PageResponse>;
}
export function publicAddress(value: string) {
  try { return !value.includes('%') && ipaddr.parse(value).range() === 'unicast'; } catch { return false; }
}

const pageRequest: PageIO['request'] = (url, address, signal) => new Promise((resolve, reject) => {
  // Connect to the validated IP, retaining the original TLS identity and Host.
  // No second hostname lookup, proxy credentials, cookies or shared socket pool.
  const req = request({ hostname: address.address, servername: url.hostname, port: 443,
    path: url.pathname + url.search, method: 'GET', agent: false, signal, maxHeaderSize: 16384,
    headers: { Host: url.host, Accept: 'text/html, text/plain;q=0.9', 'Accept-Encoding': 'identity',
      'User-Agent': 'DiscordVoiceCompanion/0.1 (public text reader)' } }, res => {
    void (async () => {
      const status = res.statusCode ?? 0, type = String(res.headers['content-type'] ?? '');
      if ([301, 302, 303, 307, 308].includes(status)) {
        res.destroy(); resolve({ status, type, location: res.headers.location, text: '' }); return;
      }
      if (status !== 200 || !/^text\/(?:html|plain)\b/i.test(type)
        || res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity'
        || Number(res.headers['content-length'] ?? 0) > 800000) throw new Error(t("Unsupported public page"));
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of res) {
        signal.throwIfAborted(); bytes += chunk.length;
        if (bytes > 800000) throw new Error(t("Public page too large"));
        chunks.push(Buffer.from(chunk));
      }
      resolve({ status, type, text: Buffer.concat(chunks).toString('utf8') });
    })().catch(error => { res.destroy(); reject(error); });
  });
  req.on('error', reject); req.end();
});

/** Every redirect gets a fresh public-address check; connections are DNS pinned.
 * Only textual HTTPS pages, without scripts, subresources or authentication. */
export function createPageReader(io: PageIO = { resolve: host => lookup(host, { all: true }), request: pageRequest }) {
  return async (value: string, signal: AbortSignal): Promise<PublicPage> => {
    let target = value;
    for (let redirects = 0; redirects <= 2; redirects++) {
      signal.throwIfAborted();
      const safe = publicResultUrl(target); if (!safe) throw new Error(t("Non-public URL"));
      const url = new URL(safe), addresses = await io.resolve(url.hostname);
      signal.throwIfAborted();
      if (!addresses.length || addresses.some(a => !publicAddress(a.address))) throw new Error(t("Non-public address"));
      const pinned = addresses.find(a => a.family === 4) ?? addresses[0]!;
      const response = await io.request(url, pinned, signal);
      signal.throwIfAborted();
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (!response.location) throw new Error(t("Empty redirect"));
        target = new URL(response.location, url).toString(); continue;
      }
      if (response.status !== 200 || !/^text\/(?:html|plain)\b/i.test(response.type) || Buffer.byteLength(response.text) > 800000) throw new Error(t("Unsupported public page"));
      return { url: safe, type: response.type, text: response.text };
    }
    throw new Error(t("Too many redirects"));
  };
}
