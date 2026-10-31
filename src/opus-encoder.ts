import { t } from './locale';
import type { DiagnosticFields } from './telemetry';
interface Job { resolve: (packets: Buffer[]) => void; reject: (error: unknown) => void; cleanup: () => void; onDiagnostic?: (fields: DiagnosticFields) => void }
type EncodingWorker = Worker & { ref(): void; unref(): void };
let worker: EncodingWorker | undefined;
let sequence = 0;
const jobs = new Map<number, Job>();

/** One native encoder lives off Discord's 20ms timer thread. Canceled results
 * are ignored; queued PCM and outstanding jobs have a fixed upper bound. */
export function encodeOpus(pcm: Buffer, signal?: AbortSignal, onDiagnostic?: (fields: DiagnosticFields) => void): Promise<Buffer[]> {
  signal?.throwIfAborted();
  if (jobs.size >= 4) return Promise.reject(new Error(t("Opus encoder queue is full.")));
  if (!worker) {
    worker = new Worker(new URL('./opus-encoder-worker.ts', import.meta.url).href) as EncodingWorker;
    worker.onmessage = ({ data }: MessageEvent<{ id: number; packets?: Uint8Array[]; error?: string; diagnostic?: DiagnosticFields }>) => {
      const job = jobs.get(data.id);
      if (!job) return;
      jobs.delete(data.id); job.cleanup();
      if (data.diagnostic) { try { job.onDiagnostic?.(data.diagnostic); } catch { /* Observation cannot break audio. */ } }
      if (data.error) job.reject(new Error(data.error)); else job.resolve(data.packets!.map(p => Buffer.from(p.buffer, p.byteOffset, p.byteLength)));
      if (!jobs.size) worker?.unref();
    };
    worker.onerror = event => {
      const failed = worker; worker = undefined;
      for (const job of jobs.values()) { job.cleanup(); job.reject(new Error(event.message || 'Opus worker stopped')); }
      jobs.clear(); failed?.terminate();
    };
  }
  worker.ref();
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    // Keep canceled work counted until the worker acknowledges it: repeated
    // cancel/retry must not bypass the queue bound or grow worker memory.
    const cancel = () => { reject(signal!.reason); };
    jobs.set(id, { resolve, reject, cleanup: () => signal?.removeEventListener('abort', cancel), onDiagnostic: fields => { if (!signal?.aborted) onDiagnostic?.(fields); } });
    signal?.addEventListener('abort', cancel, { once: true });
    const owned = Uint8Array.from(pcm);
    worker!.postMessage({ id, pcm: owned, diagnostic: !!onDiagnostic }, [owned.buffer]);
    if (signal?.aborted) cancel();
  });
}
