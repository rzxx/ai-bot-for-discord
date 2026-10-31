import { mkdir, open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { LOCAL } from './config';

export const REPORT_KINDS = ['problem', 'limitation', 'idea', 'feedback'] as const;
export interface ReportDraft { kind: typeof REPORT_KINDS[number]; text: string }
export interface ReportContext { session: string; turn?: number; events: number[] }
export interface ReportRecord extends ReportContext, ReportDraft {
  version: 1; id: string; at: string; origin: 'agent' | 'runtime' | 'background'; unreviewed: true;
}

/** Defense in depth, not a guarantee that arbitrary private text can be detected. */
export function reportText(text: string, limit = 1200): string {
  return text.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk-[\w-]{12,}|eyJ[\w.-]{30,}|[\w-]{20,30}\.[\w-]{6}\.[\w-]{25,})/g, '[redacted]')
    .replace(/\b((?:api[_-]?key|password|secret|token)\s*[:=]\s*)\S+/gi, '$1[redacted]')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, ' ')
    .trim().slice(0, limit);
}
export function parseReport(value: unknown): ReportDraft | undefined {
  if (!value || typeof value !== 'object') return;
  const { text, kind = 'problem' } = value as Record<string, unknown>;
  if (typeof text !== 'string' || text.length > 2400 || !REPORT_KINDS.includes(kind as ReportDraft['kind'])) return;
  const clean = reportText(text);
  return clean ? { kind: kind as ReportDraft['kind'], text: clean } : undefined;
}

interface InboxOptions {
  // Trusted application/test options only; never supplied by the model.
  path?: string;
  capacity?: number;
  write?: (line: string) => Promise<void>;
  observe?: (status: 'saved' | 'failed' | 'dropped') => void;
}

/** One bounded writer. Enqueue acknowledges RAM only; saved counts completed fsyncs. */
export class ReportInbox {
  private pending: ReportRecord[] = [];
  private recent = new Set<string>();
  private writing?: Promise<void>;
  private closed = false;
  private readonly write: (line: string) => Promise<void>;
  readonly counters = { queued: 0, saved: 0, failed: 0, dropped: 0 };
  constructor(private options: InboxOptions = {}) {
    const path = options.path ?? resolve(LOCAL, 'reports', 'findings.jsonl');
    this.write = options.write ?? (async line => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const file = await open(path, 'a+', 0o600);
      try {
        // Repair only the record boundary after an interrupted append. Never
        // read previous report contents or rewrite a potentially partial record.
        const { size } = await file.stat();
        if (size) {
          const tail = Buffer.alloc(1); await file.read(tail, 0, 1, size - 1);
          if (tail[0] !== 10) await file.appendFile('\n');
        }
        await file.appendFile(line, 'utf8'); await file.sync();
      }
      finally { await file.close(); }
    });
  }
  private observe(status: 'saved' | 'failed' | 'dropped') {
    try { this.options.observe?.(status); } catch { /* Diagnostics cannot affect capture or persistence. */ }
  }
  append(draft: ReportDraft, context: ReportContext, origin: ReportRecord['origin'], key: string): boolean {
    const parsed = parseReport(draft);
    if (!parsed || this.closed || this.counters.queued - this.counters.saved - this.counters.failed >= (this.options.capacity ?? 64)) {
      this.counters.dropped++; this.observe('dropped'); return false;
    }
    if (this.recent.has(key)) return true;
    this.recent.add(key);
    if (this.recent.size > 2048) this.recent.delete(this.recent.values().next().value!);
    // Project each field: unknown model fields can never set a path or provenance.
    const record: ReportRecord = { version: 1, id: crypto.randomUUID(), at: new Date().toISOString(),
      session: context.session, turn: context.turn,
      events: [...new Set(context.events.filter(n => Number.isSafeInteger(n) && n > 0))].slice(0, 8),
      origin, unreviewed: true, ...parsed };
    this.pending.push(record); this.counters.queued++;
    this.writing ??= Promise.resolve().then(() => this.drain());
    return true;
  }
  private async drain() {
    try {
      for (let job; (job = this.pending.shift());) {
        try { await this.write(JSON.stringify(job) + '\n'); this.counters.saved++; this.observe('saved'); }
        catch { this.counters.failed++; this.observe('failed'); }
        // Ambiguous partial writes are not retried. No report bodies in diagnostics.
      }
    } finally { this.writing = undefined; }
  }
  async flush() { await this.writing; }
  async close() { this.closed = true; await this.flush(); }
}
