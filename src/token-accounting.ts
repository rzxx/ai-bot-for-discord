import type { TokenMeasurement } from './token-accounting-core';
export type { TokenMeasurement, TokenSource, TokenPayload, TokenContributor } from './token-accounting-core';
type AccountingWorker = Worker & { ref(): void; unref(): void };
type Job = { emit: (measurement: TokenMeasurement | undefined, elapsedMs: number) => void; done: () => void };
let worker: AccountingWorker | undefined, sequence = 0;
const jobs = new Map<number, Job>();
function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./token-accounting-worker.ts', import.meta.url).href) as AccountingWorker;
  worker.onmessage = ({ data }: MessageEvent<{ id: number; measurement?: TokenMeasurement; elapsedMs?: number }>) => {
    const job = jobs.get(data.id); if (!job) return;
    jobs.delete(data.id);
    try { job.emit(data.measurement, data.elapsedMs ?? 0); } catch { /* Metrics cannot fail the caller. */ } finally { job.done(); }
    if (!jobs.size) worker?.unref();
  };
  worker.onerror = () => {
    const failed = worker; worker = undefined;
    for (const job of jobs.values()) { try { job.emit(undefined, 0); } catch { /* Metrics only. */ } finally { job.done(); } }
    jobs.clear(); failed?.terminate();
  };
  worker.unref(); return worker;
}
/** Best-effort observation, never awaited by the model/audio path. */
export function measureRequestTokens(session: string, body: string, emit: Job['emit'], output = false): Promise<void> {
  const failed = () => { try { emit(undefined, 0); } catch { /* Metrics only. */ } return Promise.resolve(); };
  if (jobs.size >= 4 || body.length > 8_000_000) return failed();
  try {
    const active = ensureWorker(); active.ref(); const id = ++sequence;
    return new Promise<void>(done => {
      jobs.set(id, { emit, done });
      try { active.postMessage({ id, session, body, output }); }
      catch {
        jobs.delete(id); try { emit(undefined, 0); } catch { /* Metrics only. */ }
        done(); if (!jobs.size) active.unref();
      }
    });
  } catch { return failed(); }
}
export function releaseTokenAccounting(session: string) { try { worker?.postMessage({ session, release: true }); } catch { /* Metrics never block /leave. */ } }
