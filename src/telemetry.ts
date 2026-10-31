import { t } from './locale';
import { mkdirSync, createWriteStream, type WriteStream } from 'node:fs';
import { resolve } from 'node:path';
import { LOCAL, log } from './config';
export type DiagnosticFields = Record<string, string | number | boolean | null | undefined>;

export interface LatencyRecord {
  session: string; turn?: number; utterance?: number; stage: string;
  [key: string]: string | number | boolean | null | undefined;
}
let file: WriteStream | undefined;
let diagnosticMode = false;
let writtenBytes = 0;
let droppedRecords = 0;
export function diagnosticsEnabled() { return diagnosticMode; }
export function diagnosticFileStatus() { return { diagnosticMode, writtenBytes, droppedRecords }; }
export function enableLatencyFile(options: { diagnostic?: boolean } = {}) {
  diagnosticMode = options.diagnostic ?? false;
  writtenBytes = 0; droppedRecords = 0;
  mkdirSync(LOCAL, { recursive: true });
  const path = resolve(LOCAL, `latency-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}.jsonl`);
  file = createWriteStream(path, { flags: 'a' });
  file.on('error', () => { log(t("Cannot write latency file; metrics remain in the console.")); file = undefined; });
  log(t("Latency diagnostics: {0}", path));
  latency({ session: 'runtime', stage: 'diagnostics_started', diagnosticMode, pid: process.pid, maxFileBytes: 50_000_000 });
}
export function latency(record: LatencyRecord) {
  const json = JSON.stringify({ at: new Date().toISOString(), ...record });
  log(t("[latency] {0}", json));
  // Disk trouble must never create an unbounded queue or block Discord's timer.
  const bytes = Buffer.byteLength(json + '\n');
  if (file && file.writableLength < 1_000_000 && writtenBytes + bytes <= 50_000_000) {
    writtenBytes += bytes; file.write(json + '\n');
  } else if (file) {
    if (!droppedRecords++) log(t("Diagnostic file size/queue limit reached; new records remain in the console."));
  }
}
export async function closeLatencyFile() {
  const output = file; file = undefined;
  if (output && !output.destroyed) await new Promise<void>(resolveDone => output.end(resolveDone));
}
