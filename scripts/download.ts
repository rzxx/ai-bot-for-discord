import { t } from '../src/locale';
import { mkdir, rename, stat, open, readdir, readFile, rm, rmdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { log } from '../src/config';

export async function sha256(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function cleanupChunks(path: string) {
  const directory = `${path}.chunks`;
  // Only exact chunk names owned by this downloader; retain unfamiliar files.
  try {
    for (const entry of await readdir(directory)) if (/^\d+(?:\.tmp)?$/.test(entry)) await rm(`${directory}/${entry}`, { force: true });
    await rmdir(directory);
  } catch (error) { if (!['ENOENT', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
}

/** Resumable bounded range downloads; failures retain completed pieces. */
export async function download(url: string, path: string, hash?: string, connections = 8) {
  await mkdir(dirname(path), { recursive: true });
  if (await Bun.file(path).exists()) {
    if ((await stat(path)).size > 0 && (!hash || await sha256(path) === hash)) {
      await cleanupChunks(path);
      log(t("Already downloaded: {0}", path.split(/[\\/]/).at(-1))); return;
    }
  }
  const name = path.split(/[\\/]/).at(-1)!;
  log(t("Downloading {0}…", name));
  const probe = await fetch(url, { headers: { Range: 'bytes=0-0' }, signal: AbortSignal.timeout(60000) });
  const range = probe.headers.get('Content-Range')?.match(/^bytes 0-0\/(\d+)$/);
  const size = range ? Number(range[1]) : Number(probe.headers.get('content-length'));
  if (!probe.ok || !probe.body) throw new Error(t("{0}: HTTP {1}", name, probe.status));
  if (!range || !size || size < 3_000_000) {
    if (probe.status === 206) {
      await probe.body.cancel();
      const r = await fetch(url, { signal: AbortSignal.timeout(20 * 60000) });
      if (!r.ok) throw new Error(t("{0}: HTTP {1}", name, r.status));
      await Bun.write(`${path}.part`, r);
    } else await Bun.write(`${path}.part`, probe);
  } else {
    await probe.body.cancel();
    const chunkSize = 2 * 1024 * 1024;
    const chunks = Math.ceil(size / chunkSize);
    const directory = `${path}.chunks`;
    await mkdir(directory, { recursive: true });
    let next = 0, completed = 0, previousPercent = -1;
    const worker = async () => {
      for (;;) {
        const index = next++;
        if (index >= chunks) return;
        const start = index * chunkSize, end = Math.min(size - 1, start + chunkSize - 1);
        const part = `${directory}/${index}`;
        if (await Bun.file(part).exists() && (await stat(part)).size === end - start + 1) { completed++; continue; }
        let succeeded = false;
        for (let attempt = 0; attempt < 4; attempt++) {
          try {
            const r = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, signal: AbortSignal.timeout(180000) });
            if (r.status !== 206 || r.headers.get('Content-Range') !== `bytes ${start}-${end}/${size}`) {
              await r.body?.cancel(); throw new Error(t("Invalid byte range: HTTP {0}", r.status));
            }
            const bytes = await r.arrayBuffer();
            if (bytes.byteLength !== end - start + 1) throw new Error(t("Truncated download"));
            await Bun.write(`${part}.tmp`, bytes); await rename(`${part}.tmp`, part);
            succeeded = true; break;
          } catch (error) {
            if (attempt === 3) throw new Error(t("{0}: chunk {1} failed; rerun setup to resume.", name, index));
            await Bun.sleep(1000 * (attempt + 1));
          }
        }
        if (!succeeded) throw new Error(t("{0}: incomplete chunk", name));
        completed++;
        const percent = Math.floor(completed / chunks * 10) * 10;
        if (percent > previousPercent) { previousPercent = percent; log(`${name}: ${percent}%`); }
      }
    };
    const results = await Promise.allSettled(Array.from({ length: Math.min(connections, chunks) }, worker));
    const error = results.find(r => r.status === 'rejected');
    if (error?.status === 'rejected') throw error.reason;
    const file = await open(`${path}.part`, 'w');
    try { for (let i = 0; i < chunks; i++) await file.write(await readFile(`${directory}/${i}`)); }
    finally { await file.close(); }
  }
  if (hash && await sha256(`${path}.part`) !== hash) throw new Error(t("{0}: SHA-256 mismatch", name));
  if ((await stat(`${path}.part`)).size < 1) throw new Error(t("{0}: empty file", name));
  await rename(`${path}.part`, path);
  // Remove only our known chunk files after the complete file passes verification.
  await cleanupChunks(path);
  log(t("Done: {0}", name));
}
