import { withAbort } from './abort';
import { ReportInbox, parseReport, reportText, type ReportContext, type ReportDraft } from './reports';

export interface ReportSeed extends ReportContext {
  reason: 'agent' | 'tool_failure';
  evidence: { event: number; kind: 'speech' | 'tool' | 'assistant'; text: string }[];
}
export type ReportGenerator = (seed: ReportSeed, signal: AbortSignal) => Promise<ReportDraft | undefined>;
interface ReportingOptions {
  inbox?: ReportInbox;
  generate?: ReportGenerator;
  observe?: (status: string) => void;
  idleMs?: number; timeoutMs?: number; intervalMs?: number; hourlyLimit?: number; now?: () => number;
}
const failureStatuses = new Set(['disabled', 'unavailable', 'failed', 'error', 'timeout', 'narrow_query', 'rejected', 'private_query']);

/** Process-scoped reporting lane. Nothing is ever delivered back into a room. */
export class Reporting {
  readonly inbox: ReportInbox;
  private foreground = new Set<string>();
  private pending: { seed: ReportSeed; at: number; key: string }[] = [];
  private active?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private lastStart = -Infinity;
  private starts: number[] = [];
  private now: () => number;
  constructor(private options: ReportingOptions = {}) {
    this.inbox = options.inbox ?? new ReportInbox({ observe: status => this.observe(`write_${status}`) });
    this.now = options.now ?? Date.now;
  }
  private observe(status: string) { try { this.options.observe?.(status); } catch { /* Reporting never depends on diagnostics. */ } }
  setForeground(session: string, busy: boolean) {
    const wasBusy = this.foreground.has(session);
    if (busy) {
      this.foreground.add(session); clearTimeout(this.timer); this.timer = undefined;
      this.active?.abort();
    } else {
      this.foreground.delete(session);
      if (wasBusy) this.schedule();
    }
  }
  forget(session: string) { this.foreground.delete(session); this.schedule(); }
  capture(value: unknown, context: ReportContext) {
    const draft = parseReport(value);
    return !!draft && this.inbox.append(draft, context, 'agent', `${context.session}:${context.turn}:agent`);
  }
  failure(domain: 'speech_recognition' | 'model' | 'audio' | 'turn', code: string, context: ReportContext, key?: string) {
    this.inbox.append({ kind: 'problem', text: `Runtime ${domain} failure (${reportText(code, 100)}).` }, context, 'runtime',
      key ?? `${context.session}:${context.turn}:${domain}:${context.events.join(',')}`);
  }
  toolFailure(receipt: { tool: string; status: string; event: number; reason?: unknown }, context: ReportContext, evidence: ReportSeed['evidence']) {
    if (!failureStatuses.has(receipt.status)) return;
    const text = reportText(`Tool ${receipt.tool} returned ${receipt.status}${typeof receipt.reason === 'string' ? ` (${receipt.reason})` : ''}.`);
    const key = `${context.session}:tool:${receipt.event}:${receipt.tool}:${receipt.status}`;
    this.inbox.append({ kind: 'limitation', text }, context, 'runtime', key);
    this.review({ ...context, reason: 'tool_failure', evidence: [...evidence, { event: receipt.event, kind: 'tool', text }] }, key);
  }
  review(seed: ReportSeed, key = `${seed.session}:${seed.turn}:review`) {
    if (this.closed || !this.options.generate) return;
    if (this.pending.length >= 8) { this.observe('analysis_dropped'); return; }
    if (this.pending.some(job => job.key === key)) return;
    let remaining = 2400;
    const evidence = seed.evidence.slice(-6).reverse().map(item => {
      const text = reportText(item.text, Math.min(800, remaining)); remaining -= text.length;
      return { event: item.event, kind: item.kind, text };
    }).filter(item => item.text).reverse();
    this.pending.push({ seed: { session: seed.session, turn: seed.turn, events: [...seed.events].slice(0, 8), reason: seed.reason, evidence }, at: this.now(), key });
    this.schedule();
  }
  private schedule() {
    if (this.closed || this.timer || this.active || this.foreground.size || !this.pending.length) return;
    const delay = Math.max(this.options.idleMs ?? 2000, this.lastStart + (this.options.intervalMs ?? 60000) - this.now());
    this.timer = setTimeout(() => { this.timer = undefined; void this.run(); }, delay);
    this.timer.unref();
  }
  private async run() {
    if (this.closed || this.foreground.size) return;
    this.starts = this.starts.filter(at => this.now() - at < 3600000);
    const job = this.pending.shift();
    if (!job) return;
    if (this.now() - job.at > 120000 || this.starts.length >= (this.options.hourlyLimit ?? 12)) {
      this.observe('analysis_dropped'); this.schedule(); return;
    }
    const abort = new AbortController(); this.active = abort;
    const timeout = setTimeout(() => abort.abort(), this.options.timeoutMs ?? 8000);
    this.lastStart = this.now(); this.starts.push(this.lastStart);
    this.observe('analysis_started');
    const generation = Promise.resolve().then(() => { abort.signal.throwIfAborted(); return this.options.generate!(job.seed, abort.signal); });
    try {
      const draft = await withAbort(generation, abort.signal);
      if (!abort.signal.aborted && !this.closed && draft) this.inbox.append(draft, job.seed, 'background', `${job.key}:analysis`);
      this.observe('analysis_finished');
    } catch { this.observe(abort.signal.aborted ? 'analysis_canceled' : 'analysis_failed'); }
    finally {
      clearTimeout(timeout);
      // Keep the slot reserved until the actual provider settles, even if it
      // ignores abort. Foreground work and shutdown never wait for this slot.
      void generation.catch(() => {}).finally(() => { this.active = undefined; this.schedule(); });
    }
  }
  async close() {
    this.closed = true; clearTimeout(this.timer); this.timer = undefined;
    this.pending.length = 0; this.active?.abort();
    // A stuck filesystem must not hang process shutdown indefinitely.
    try { await withAbort(this.inbox.close(), AbortSignal.timeout(2000)); }
    catch { this.observe('flush_timeout'); }
  }
}
