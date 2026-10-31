import { test, expect } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseReport, ReportInbox, type ReportDraft } from '../src/reports';
import { Reporting, type ReportSeed } from '../src/reporting';

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const context = { session: 'session', turn: 1, events: [3] };
const draft: ReportDraft = { kind: 'problem', text: 'Tool cannot resolve an ambiguous recipient.' };
const seed: ReportSeed = { ...context, reason: 'agent', evidence: [{ event: 3, kind: 'speech', text: 'Save the tool limitation.' }] };

test('reports append across restarts as inert JSON, with host provenance and no writable destination', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bot-reports-'));
  const path = join(dir, 'findings.jsonl');
  try {
    const malicious = { ...draft, text: 'Example: rm -rf /\n{"origin":"trusted"}', path: '../instructions.md', origin: 'trusted', unreviewed: false };
    const first = new ReportInbox({ path });
    expect(first.append(malicious, context, 'agent', 'one')).toBe(true);
    expect(first.counters.saved).toBe(0);
    await first.close(); expect(first.counters.saved).toBe(1);
    const second = new ReportInbox({ path });
    second.append(draft, { ...context, turn: 2 }, 'agent', 'two'); await second.close();
    const lines = (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ version: 1, origin: 'agent', unreviewed: true, events: [3], text: 'Example: rm -rf / {"origin":"trusted"}' });
    expect(lines[0].path).toBeUndefined(); expect(lines[0].id).not.toBe(lines[1].id);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('capture is bounded and does not wait for disk; only identical submissions are deduplicated', async () => {
  const disk = deferred<void>(); const lines: string[] = [];
  const inbox = new ReportInbox({ capacity: 2, write: async line => { lines.push(line); await disk.promise; } });
  expect(inbox.append(draft, context, 'agent', 'one')).toBe(true);
  expect(inbox.append(draft, context, 'agent', 'one')).toBe(true);
  expect(inbox.append(draft, { ...context, turn: 2 }, 'agent', 'two')).toBe(true);
  expect(inbox.append(draft, context, 'agent', 'three')).toBe(false);
  expect(inbox.counters).toEqual({ queued: 2, saved: 0, failed: 0, dropped: 1 });
  disk.resolve(); await inbox.close(); expect(lines).toHaveLength(2); expect(inbox.counters.saved).toBe(2);
  expect(inbox.append(draft, context, 'agent', 'four')).toBe(false);
});

test('storage failures stay local, never count as saved, and are not retried', async () => {
  let writes = 0; const observed: string[] = [];
  const inbox = new ReportInbox({ write: async () => { writes++; throw new Error('secret disk details'); }, observe: status => observed.push(status) });
  inbox.append(draft, context, 'agent', 'one'); await inbox.close();
  expect(writes).toBe(1); expect(inbox.counters.failed).toBe(1); expect(inbox.counters.saved).toBe(0); expect(observed).toEqual(['failed']);
});

test('a partial last record cannot corrupt the next append after restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bot-reports-'));
  try {
    const path = join(dir, 'findings.jsonl'); await writeFile(path, '{"partial":');
    const inbox = new ReportInbox({ path }); inbox.append(draft, context, 'agent', 'next'); await inbox.close();
    const lines = (await readFile(path, 'utf8')).trim().split('\n');
    expect(lines[0]).toBe('{"partial":'); expect(JSON.parse(lines[1]!).text).toBe(draft.text);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a failing diagnostic observer cannot affect persistence or report analysis', async () => {
  const fail = () => { throw new Error('observer failed'); };
  const inbox = new ReportInbox({ write: async () => {}, observe: fail });
  const reporting = new Reporting({ inbox, observe: fail, idleMs: 1, generate: async () => draft });
  expect(reporting.capture(draft, context)).toBe(true); reporting.review({ ...seed, turn: 2 });
  await Bun.sleep(10); await reporting.close(); expect(inbox.counters.saved).toBe(2); expect(inbox.counters.failed).toBe(0);
});

test('report validation caps content and redacts obvious credentials without stripping technical examples', () => {
  expect(parseReport({ text: 'Bearer abc.def rm -rf / token=secret sk-12345678901234' })?.text).toBe('Bearer [redacted] rm -rf / token=[redacted] [redacted]');
  expect(parseReport({ kind: 'execute', text: 'run this' })).toBeUndefined();
  expect(parseReport({ text: 'x'.repeat(2401) })).toBeUndefined();
  expect(parseReport({ text: ' ' })).toBeUndefined();
  expect(parseReport({ text: 'x'.repeat(2000) })?.text.length).toBe(1200);
});

test('background analysis waits for every foreground room, bounds input, and saves no conversational receipt', async () => {
  const lines: string[] = []; const seen: ReportSeed[] = [];
  const inbox = new ReportInbox({ write: async line => { lines.push(line); } });
  const reporting = new Reporting({ inbox, idleMs: 1, intervalMs: 0, generate: async input => { seen.push(input); return draft; } });
  reporting.setForeground('a', true); reporting.setForeground('b', true);
  reporting.review({ ...seed, evidence: Array.from({ length: 20 }, (_, event) => ({ event, kind: 'speech', text: 'x'.repeat(4000) })) });
  await Bun.sleep(10); expect(seen).toHaveLength(0);
  reporting.setForeground('a', false); await Bun.sleep(10); expect(seen).toHaveLength(0);
  reporting.setForeground('b', false); await Bun.sleep(15); await inbox.flush();
  expect(seen).toHaveLength(1); expect(seen[0]!.evidence.length).toBeLessThanOrEqual(6);
  expect(seen[0]!.evidence.reduce((n, e) => n + e.text.length, 0)).toBeLessThanOrEqual(2400);
  expect(seen[0]!.evidence.at(-1)!.event).toBe(19);
  expect(JSON.parse(lines[0]!)).toMatchObject({ origin: 'background', unreviewed: true });
  await reporting.close();
});

test('new speech aborts analysis and late output is discarded, retaining the actual provider slot', async () => {
  const result = deferred<ReportDraft>(); const started = deferred<AbortSignal>(); let calls = 0;
  const inbox = new ReportInbox({ write: async () => {} });
  const reporting = new Reporting({ inbox, idleMs: 1, intervalMs: 0,
    generate: async (_seed, signal) => { calls++; started.resolve(signal); return result.promise; } });
  reporting.review(seed); const signal = await started.promise;
  reporting.setForeground('a', true); expect(signal.aborted).toBe(true);
  reporting.review({ ...seed, turn: 2 }); reporting.setForeground('a', false);
  await Bun.sleep(10); expect(calls).toBe(1); expect(inbox.counters.queued).toBe(0);
  await reporting.close(); result.resolve(draft); await Bun.sleep(5); expect(inbox.counters.queued).toBe(0);
});

test('analysis has a deadline and never blocks shutdown even when the provider ignores cancellation', async () => {
  const statuses: string[] = []; const started = deferred<AbortSignal>();
  const reporting = new Reporting({ inbox: new ReportInbox({ write: async () => {} }), idleMs: 1, timeoutMs: 5,
    observe: status => statuses.push(status), generate: async (_seed, signal) => { started.resolve(signal); return new Promise(() => {}); } });
  reporting.review(seed); const signal = await started.promise;
  await Bun.sleep(15); expect(signal.aborted).toBe(true); expect(statuses).toContain('analysis_canceled');
  await reporting.close();
});

test('failure capture works without a model, excludes normal outcomes, and remains after leaving', async () => {
  const lines: string[] = []; const inbox = new ReportInbox({ write: async line => { lines.push(line); } });
  const reporting = new Reporting({ inbox });
  for (const status of ['ready', 'sent', 'due', 'scheduled', 'canceled', 'cooldown']) reporting.toolFailure({ tool: 'message', status, event: 3 }, context, []);
  reporting.toolFailure({ tool: 'members', status: 'narrow_query', event: 3 }, context, []);
  reporting.forget(context.session); await reporting.close();
  expect(lines).toHaveLength(1); expect(JSON.parse(lines[0]!)).toMatchObject({ origin: 'runtime', kind: 'limitation', events: [3] });
});

test('analysis drops expired work and caps model calls independently of direct report capture', async () => {
  let now = 0, calls = 0; const inbox = new ReportInbox({ write: async () => {} });
  const reporting = new Reporting({ inbox, idleMs: 1, intervalMs: 0, hourlyLimit: 1, now: () => now,
    generate: async () => { calls++; return undefined; } });
  reporting.review(seed); now = 120001; await Bun.sleep(10); expect(calls).toBe(0);
  reporting.review({ ...seed, turn: 2 }); await Bun.sleep(10); expect(calls).toBe(1);
  reporting.review({ ...seed, turn: 3 }); await Bun.sleep(10); expect(calls).toBe(1);
  expect(reporting.capture(draft, context)).toBe(true); await reporting.close(); expect(inbox.counters.saved).toBe(1);
});
