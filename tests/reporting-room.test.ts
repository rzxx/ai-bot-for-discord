import { test, expect } from 'bun:test';
import { defaults } from '../src/config';
import type { Reply, Brain } from '../src/llm';
import { RoomController } from '../src/room';
import { TaskQueue } from '../src/queue';
import { Reporting } from '../src/reporting';
import { ReportInbox, type ReportDraft } from '../src/reports';

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const person = { id: 'person', name: 'Человек' };
const draft: ReportDraft = { kind: 'idea', text: 'Add a way to resolve similarly named members.' };
function roomFixture(reply: Brain['reply'], reporting: Reporting, options: { play?: () => Promise<{ completed: boolean; playedMs: number }>; enabled?: boolean; tools?: boolean } = {}) {
  let now = 100000, calls = 0; const notices: string[] = [];
  const room = new RoomController({ ...defaults, thinkingCues: false, reportTools: options.enabled ?? true },
    { reply: (...args) => { calls++; return reply(...args); } }, { transcribe: async () => '' }, { synthesize: async () => Buffer.from('audio') },
    { play: options.play ?? (async () => ({ completed: true, playedMs: 100 })), stop() {} }, new TaskQueue(1), text => notices.push(text),
    { reporting, autoTick: false, modelOnly: true, now: () => now, trace() {}, convertOutput: async data => data,
      tools: options.tools ? { limits: new Map(), resolvePerson: () => undefined, activity: () => ({ status: 'unknown', activity: '' }), sendMessage: async () => { throw new Error('offline'); } } : undefined });
  room.setMember(person);
  return { room, notices, calls: () => calls, speak: (text = 'Лёва, сохрани эту идею.') => { const event = room.transcript(person, text); now += 2000; return event!; } };
}

test('a report is silent, survives leave, and cannot make playback wait for disk', async () => {
  const disk = deferred<void>(); const lines: string[] = [];
  const inbox = new ReportInbox({ write: async line => { lines.push(line); await disk.promise; } });
  const reporting = new Reporting({ inbox });
  const f = roomFixture(async () => ({ speak: true, text: 'Продолжим разговор.', report: draft }), reporting);
  f.speak(); await f.room.tick();
  expect(f.room.phase).toBe('idle'); expect(inbox.counters.saved).toBe(0); expect(inbox.counters.queued).toBe(1);
  expect(f.notices).toEqual([]); expect(f.calls()).toBe(1);
  expect(f.room.events.filter(e => e.kind === 'tool')).toEqual([]);
  expect(f.room.snapshot().events.some(e => e.text.includes(draft.text))).toBe(false);
  f.room.close(); disk.resolve(); await reporting.close(); expect(lines).toHaveLength(1); expect(inbox.counters.saved).toBe(1);
});

test('post-turn analysis starts after playback and its output cannot wake the conversation', async () => {
  const playback = deferred<{ completed: boolean; playedMs: number }>(); const playing = deferred<void>();
  const generated = deferred<void>(); let analyses = 0;
  const inbox = new ReportInbox({ write: async () => {} });
  const reporting = new Reporting({ inbox, idleMs: 1, generate: async () => { analyses++; generated.resolve(); return draft; } });
  const f = roomFixture(async () => ({ speak: true, text: 'Отвечаю на вопрос.', report: true }), reporting,
    { play: async () => { playing.resolve(); return playback.promise; } });
  f.speak(); const turn = f.room.tick(); await playing.promise;
  await Bun.sleep(10); expect(analyses).toBe(0);
  playback.resolve({ completed: true, playedMs: 100 }); await turn; await generated.promise; await Bun.sleep(5); await inbox.flush();
  expect(inbox.counters.saved).toBe(1); await f.room.tick(); expect(f.calls()).toBe(1);
  expect(f.room.events.some(e => e.kind === 'tool' || e.text.includes(draft.text))).toBe(false);
  f.room.close(); await reporting.close();
});

test('room speech preempts a background provider without waiting for it to finish', async () => {
  const started = deferred<AbortSignal>(); const result = deferred<ReportDraft>();
  const reporting = new Reporting({ inbox: new ReportInbox({ write: async () => {} }), idleMs: 1,
    generate: async (_seed, signal) => { started.resolve(signal); return result.promise; } });
  const f = roomFixture(async () => ({ speak: false, text: '', report: true }), reporting);
  f.speak(); await f.room.tick(); const signal = await started.promise;
  f.room.activity(person.id, true); expect(signal.aborted).toBe(true);
  f.room.activity(person.id, false); f.speak('Лёва, другой вопрос.'); await f.room.tick(); expect(f.calls()).toBe(2);
  f.room.close(); await reporting.close(); result.resolve(draft);
});

test('disabled reporting exposes no capability and ignores attempted submissions', async () => {
  const inbox = new ReportInbox({ write: async () => {} }); const reporting = new Reporting({ inbox });
  const f = roomFixture(async () => ({ speak: false, text: '', report: draft }), reporting, { enabled: false });
  expect(f.room.snapshot().capabilities).not.toContain('report');
  f.speak(); await f.room.tick(); expect(inbox.counters.queued).toBe(0); f.room.close(); await reporting.close();
});

test('automatic report review omits raw retrieved chat payloads', async () => {
  const seed = deferred<import('../src/reporting').ReportSeed>();
  const reporting = new Reporting({ inbox: new ReportInbox({ write: async () => {} }), idleMs: 0, intervalMs: 0,
    generate: async value => { seed.resolve(value); return undefined; } });
  const f = roomFixture(async () => ({ speak: false, text: '', report: true }), reporting);
  (f.room as any).toolReceipt(person.id, { tool: 'chat', event: 0, status: 'ready', messages: [{ text: 'RAW_PRIVATE_CHAT_FIXTURE' }] }, false);
  try {
    f.speak('Лёва, запиши, что поиск работает.'); await f.room.tick();
    const value = await seed.promise;
    expect(JSON.stringify(value)).not.toContain('RAW_PRIVATE_CHAT_FIXTURE');
    expect(value.evidence.some(e => e.kind === 'speech')).toBe(true);
  } finally { f.room.close(); await reporting.close(); }
});

test('a canceled reply cannot submit a report or execute a write', async () => {
  const pending = deferred<Reply>(); const started = deferred<void>();
  const inbox = new ReportInbox({ write: async () => {} }); const reporting = new Reporting({ inbox });
  const f = roomFixture(async () => { started.resolve(); return pending.promise; }, reporting, { tools: true });
  const event = f.speak(); const turn = f.room.tick(); await started.promise; f.room.stop();
  pending.resolve({ speak: false, text: '', report: draft, actions: [{ tool: 'message', event, text: 'should not send' }] });
  await turn; await f.room.tools!.settle(); expect(inbox.counters.queued).toBe(0); expect(f.notices).toEqual([]);
  f.room.close(); await reporting.close();
});

test('actual tool failure produces a compact runtime report independently of model analysis', async () => {
  const lines: string[] = []; const inbox = new ReportInbox({ write: async line => { lines.push(line); } }); const reporting = new Reporting({ inbox });
  const f = roomFixture(async s => ({ speak: false, text: '', actions: [{ tool: 'message', event: s.responsePolicy!.triggerEventIds[0]!, text: 'Привет.' }] }), reporting, { tools: true });
  f.speak('Лёва, напиши привет в чат.'); await f.room.tick(); await f.room.tools!.settle(); await inbox.flush();
  expect(JSON.parse(lines[0]!)).toMatchObject({ origin: 'runtime', text: 'Tool message returned unavailable.' });
  expect(f.calls()).toBe(1); f.room.close(); await reporting.close();
});
