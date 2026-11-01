import { expect, test } from 'bun:test';
import { TaskRuntime, taskLimits, nextDaily, validTaskDefinition, type TaskEnvironment, type TaskDefinition } from '../src/tasks';
import { TaskPresence } from '../src/task-presence';
import { TaskResearch } from '../src/task-research';
import { cleanReply } from '../src/llm';

function fixture(limits = {}) {
  let now = Date.parse('2026-01-01T12:00:00Z');
  const receipts: Record<string, unknown>[] = [];
  const runtime = new TaskRuntime({ ...taskLimits, ...limits }, () => now, (_owner, r) => receipts.push(r), () => 0);
  const env: TaskEnvironment = { members: new Set(['a', 'b']), listeners: new Set(['a', 'b']), lastHumanAt: now, humanSpeaking: false, lastBotAt: -Infinity };
  return { runtime, env, receipts, now: () => now, time: (ms: number) => { now += ms; },
    create: (definition: TaskDefinition) => runtime.create('a', 1, definition)!,
    tick: () => runtime.tick(env), claim: (foreground = false) => runtime.claim(env, foreground) };
}
const joke: TaskDefinition = { intent: 'Tell a contextual joke', trigger: { kind: 'interval', seconds: 10 } };
const music: TaskDefinition = { intent: 'Roast each song', trigger: { kind: 'change', source: 'spotify', subject: 'a' } };

test('anchored recurrence coalesces missed periods and negative jitter never creates a tick storm', () => {
  const f = fixture(); const task = f.create({ ...joke, trigger: { kind: 'interval', seconds: 10, jitterSeconds: 2 } });
  f.time(8000); f.tick(); expect(f.runtime.get(task.id)!.nextAt).toBe(f.now() + 10000);
  f.time(1); f.tick(); expect(f.runtime.metrics.queued).toBe(1);
  f.time(100000); f.tick(); expect(f.runtime.metrics.queued).toBe(1); expect(f.runtime.metrics.merged).toBe(1);
  expect(f.runtime.get(task.id)!.nextAt! - task.createdAt).toBe(118000);
  f.runtime.close();
});

test('changes preserve A/B/C/replay while unchanged observations never queue work', () => {
  const f = fixture(); f.create(music);
  for (const title of ['A', 'A', 'B', 'C', 'A']) f.runtime.observe({ source: 'spotify', subject: 'a', key: title, data: { title } });
  const [run] = f.claim(); expect(run!.observations.map(o => o.data.title)).toEqual(['A', 'B', 'C', 'A']);
  expect(f.runtime.metrics.unchanged).toBe(1); expect(f.runtime.metrics.queued).toBe(1);
  f.runtime.bind(run!, 10);
  f.runtime.observe({ source: 'spotify', subject: 'a', key: 'D', data: { title: 'D' } });
  expect(f.claim(true)).toEqual([]); // One active run per task.
  f.runtime.release([run!], [{ run: run!.id, status: 'done' }], 'complete', true);
  f.time(5000); expect(f.claim(true)[0]!.observations[0]!.data.title).toBe('D'); f.runtime.close();
});

test('observation overflow is bounded and reports the gap without flooding receipts', () => {
  const f = fixture({ maxObservations: 2 }); f.create(music);
  for (let i = 0; i < 100; i++) f.runtime.observe({ source: 'spotify', subject: 'a', key: String(i), data: { title: String(i) } });
  const [run] = f.claim(); expect(run!.observations).toHaveLength(2); expect(run!.dropped).toBe(98);
  expect(f.receipts).toHaveLength(1); expect(f.runtime.describe(run!).dropped).toBe(98); f.runtime.close();
});

test('latest policy coalesces opportunities and baseline observations are opt-in', () => {
  const f = fixture(); f.runtime.observe({ source: 'spotify', subject: 'a', key: 'A', data: { title: 'A' } });
  f.create({ ...music, pending: 'latest' }); expect(f.claim()).toEqual([]);
  for (const title of ['B', 'C']) f.runtime.observe({ source: 'spotify', subject: 'a', key: title, data: { title } });
  expect(f.claim()[0]!.observations.map(o => o.data.title)).toEqual(['C']);
  f.create({ ...music, trigger: { kind: 'change', source: 'spotify', subject: 'a', includeCurrent: true } });
  expect(f.claim(true)[0]!.observations[0]!.data.title).toBe('C'); f.runtime.close();
});

test('silence is one contribution per human episode, never rearmed by bot speech', () => {
  const f = fixture(); f.create({ intent: 'Fill silence', trigger: { kind: 'silence', seconds: 10 } });
  f.tick(); f.time(10000); f.tick(); const batch = f.claim(); expect(batch).toHaveLength(1);
  f.runtime.release(batch, f.runtime.directResults(batch), 'complete', true); f.env.lastBotAt = f.now();
  f.time(60000); f.tick(); expect(f.claim()).toEqual([]);
  f.env.lastHumanAt = f.now(); f.tick(); f.time(10000); f.tick(); expect(f.claim()).toHaveLength(1); f.runtime.close();
});

test('silence is canceled when humans return and unavailable/deafened/old audiences do not qualify', () => {
  const f = fixture(); f.create({ intent: 'Fill silence', trigger: { kind: 'silence', seconds: 10 } });
  f.time(10000); f.tick(); const [run] = f.claim(); f.runtime.bind(run!, 10);
  f.env.humanSpeaking = true; f.env.lastHumanAt = f.now(); f.tick(); expect(f.runtime.valid(run!, f.env)).toBe(false);
  f.env.humanSpeaking = false; f.env.listeners = new Set(); f.time(10000); f.tick(); expect(f.claim()).toEqual([]);
  f.env.listeners = f.env.members; f.time(1000000); f.tick(); expect(f.claim()).toEqual([]); f.runtime.close();
});

test('held conditions reset on a false edge even if the next tick sees true again', () => {
  const f = fixture(); f.create({ intent: 'React', trigger: { kind: 'condition', source: 'activity', subject: 'a', field: 'ready', equals: true, seconds: 5 } });
  const observe = (ready: boolean) => f.runtime.observe({ source: 'activity', subject: 'a', key: 'same', data: { ready } });
  observe(true); f.tick(); f.time(4000); observe(false); observe(true); f.tick(); f.time(1000); f.tick(); expect(f.claim()).toEqual([]);
  f.time(4000); f.tick(); expect(f.claim()).toHaveLength(1); f.runtime.close();
});

test('AND guards and audience are revalidated after inference, not only at trigger time', () => {
  const f = fixture(); f.create({ ...joke, conditions: [{ source: 'activity', subject: 'a', field: 'game', equals: 'Minecraft' }] });
  f.time(10000); f.tick(); expect(f.claim()).toEqual([]);
  f.runtime.observe({ source: 'activity', subject: 'a', key: 'm', data: { game: 'Minecraft' } });
  const [run] = f.claim(); expect(run).toBeDefined();
  f.runtime.observe({ source: 'activity', subject: 'a', key: 'v', data: { game: 'Valorant' } });
  expect(f.runtime.valid(run!, f.env)).toBe(false); f.runtime.close();
});

test('task grants cannot survive revision changes, expand capabilities, or overlap tools', () => {
  const f = fixture(); const task = f.create({ ...joke, tools: ['search'] }); f.time(10000); f.tick(); const [run] = f.claim(); f.runtime.bind(run!, 10);
  expect(f.runtime.grant(run!.id, 9, 'search', f.env)).toBeUndefined(); expect(f.runtime.grant(run!.id, 10, 'message', f.env)).toBeUndefined();
  const grant = f.runtime.grant(run!.id, 10, 'search', f.env)!; f.runtime.waiting(grant);
  expect(f.runtime.grant(run!.id, 10, 'search', f.env)).toBeUndefined();
  expect(f.runtime.manage(task.id, 'update', { ...joke, intent: 'New intent' })).toBe(true);
  expect(grant.signal.aborted).toBe(true); f.runtime.toolResult(grant, { status: 'ready', secret: 'stale' });
  expect(f.runtime.list()[0]!.pendingRuns).toBe(0); f.runtime.close();
});

test('updating an include-current task retains its ID and creates no orphan occurrences', () => {
  const f = fixture(); const task = f.create(music);
  f.runtime.observe({ source: 'spotify', subject: 'a', key: 'A', data: { title: 'A' } });
  f.runtime.manage(task.id, 'update', { ...music, trigger: { ...music.trigger, kind: 'change', source: 'spotify', subject: 'a', includeCurrent: true } });
  const batch = f.claim(); expect(batch).toHaveLength(1); expect(batch[0]!.task).toBe(task.id);
  expect(f.runtime.list()).toHaveLength(1); expect(f.runtime.list()[0]!.pendingRuns).toBe(1); f.runtime.close();
});

test('a completed research run and newer recurrence cannot claim two active slots for one task', () => {
  const f = fixture(); f.create(joke); f.time(10000); f.tick(); const [run] = f.claim(); f.runtime.bind(run!, 10);
  const grant = f.runtime.grant(run!.id, 10, 'search', f.env)!; f.runtime.waiting(grant);
  f.time(10000); f.tick(); f.runtime.toolResult(grant, { status: 'ready' });
  expect(f.runtime.list()[0]!.pendingRuns).toBe(2); expect(f.claim()).toHaveLength(1); f.runtime.close();
});

test('search receipts survive ordinary conversation but require a new admission before use', () => {
  const f = fixture(); f.create(joke); f.time(10000); f.tick(); const [run] = f.claim(); f.runtime.bind(run!, 10);
  const grant = f.runtime.grant(run!.id, 10, 'search', f.env)!; f.runtime.waiting(grant);
  f.env.lastHumanAt = f.now(); f.runtime.toolResult(grant, { tool: 'search', status: 'ready', results: ['evidence'] });
  f.runtime.release([run!], [{ run: run!.id, status: 'done' }], 'complete', true); // Old turn cannot consume newly arrived evidence.
  expect(f.claim()).toEqual([]); f.time(10000); const next = f.claim(); expect(next[0]!.receipts[0]!.results).toEqual(['evidence']);
  f.runtime.bind(next[0]!, 20); expect(f.runtime.grant(run!.id, 10, 'activity', f.env)).toBeUndefined(); f.runtime.close();
});

test('continuations append observation and receipt deltas without repeating prior task evidence', () => {
  const f = fixture(); f.create(music);
  f.runtime.observe({ source: 'spotify', subject: 'a', key: 'A', data: { title: 'A' } });
  const [run] = f.claim(); const initial = f.runtime.describe(run!); f.runtime.bind(run!, 10);
  expect(initial.intent).toBe('Roast each song'); expect(initial.observations).toHaveLength(1);
  const grant = f.runtime.grant(run!.id, 10, 'search', f.env)!; f.runtime.waiting(grant);
  f.runtime.toolResult(grant, { status: 'ready', results: ['unique evidence'] });
  f.time(10000); const [next] = f.claim(); const continuation = f.runtime.describe(next!);
  expect(continuation.intent).toBeUndefined(); expect(continuation.observations).toEqual([]); expect(continuation.receipts).toHaveLength(1);
  f.runtime.release([next!], [{ run: next!.id, status: 'defer', seconds: 5 }], 'none', false);
  f.time(10000); const [third] = f.claim(); expect(f.runtime.describe(third!).receipts).toEqual([]); f.runtime.close();
});

test('model and speech budgets defer optional work, while prepared reminders need no inference budget', () => {
  const f = fixture({ hourlyModelLimit: 1 }); f.create(joke); f.time(10000); f.tick(); const batch = f.claim();
  f.runtime.release(batch, f.runtime.directResults(batch), 'complete', true);
  f.time(10000); f.tick(); expect(f.claim()).toEqual([]);
  f.create({ intent: 'Water', trigger: { kind: 'once', seconds: 5 }, delivery: 'prepared', text: 'Drink water' });
  f.time(5000); f.tick(); expect(f.claim()).toHaveLength(1); expect(f.runtime.metrics.modelBatches).toBe(1); f.runtime.close();
});

test('partial playback is consumed once, unstarted delivery retries with backoff, and skip is per occurrence', () => {
  const f = fixture(); const task = f.create(joke); f.time(10000); f.tick(); let batch = f.claim();
  f.runtime.release(batch, f.runtime.directResults(batch), 'none', true); expect(f.claim(true)).toEqual([]);
  f.time(5000); batch = f.claim(true); f.runtime.release(batch, [], 'interrupted', true);
  expect(f.runtime.metrics.interrupted).toBe(1); expect(f.runtime.get(task.id)).toBeDefined();
  f.time(5000); f.tick(); batch = f.claim(true); f.runtime.release(batch, [{ run: batch[0]!.id, status: 'skip' }], 'none', false);
  expect(f.runtime.get(task.id)).toBeDefined(); f.runtime.close();
});

test('missing model outcome metadata never causes a spoken contribution to replay', () => {
  const f = fixture(); f.create(joke); f.time(10000); f.tick(); const batch = f.claim();
  f.runtime.release(batch, [], 'complete', true); f.time(5000); expect(f.claim(true)).toEqual([]);
  expect(f.receipts.at(-1)!.status).toBe('unconfirmed'); f.runtime.close();
});

test('task output parsing retains only bounded valid outcomes and scoped tool actions', () => {
  const reply = cleanReply({ speak: false, text: '', actions: [{ tool: 'search', event: 10, run: 'o1', query: 'Artist facts' }],
    taskResults: [{ run: 'o1', status: 'defer', seconds: 15 }, { run: 'unknown', status: 'done' }, { run: 'o2', status: 'defer', seconds: -1 }] }, 240);
  expect(reply.taskResults).toEqual([{ run: 'o1', status: 'defer', seconds: 15 }]); expect(reply.actions![0]).toMatchObject({ run: 'o1' });
});

test('pause/update/cancel work for one-shots too, and session close destroys every definition and grant', () => {
  const f = fixture(); const task = f.create({ intent: 'Water', trigger: { kind: 'once', seconds: 5 } }); f.time(5000); f.tick();
  expect(f.runtime.manage(task.id, 'pause')).toBe(true); expect(f.runtime.get(task.id)!.paused).toBe(true);
  expect(f.runtime.manage(task.id, 'resume')).toBe(true); f.time(5000); f.tick(); const [run] = f.claim(); f.runtime.bind(run!, 10);
  const grant = f.runtime.grant(run!.id, 10, 'search', f.env)!;
  f.runtime.close(); expect(grant.signal.aborted).toBe(true); expect(f.runtime.list()).toEqual([]); expect(f.claim()).toEqual([]);
});

test('step limits and expiration prevent an unattended model retry loop', () => {
  const f = fixture({ maxSteps: 2 }); f.create(joke); f.time(10000); f.tick(); let batch = f.claim(); f.runtime.release(batch, [], 'none', false);
  f.time(10000); batch = f.claim(); f.runtime.release(batch, [], 'none', false); expect(f.receipts.at(-1)!.status).toBe('step_limit');
  f.tick(); f.time(120001); f.tick(); expect(f.receipts.some(r => r.status === 'expired')).toBe(true); f.runtime.close();
});

test('daily schedules respect timezones, weekdays, spring gaps and autumn repeated hours', () => {
  const daily = { kind: 'daily' as const, time: '09:00', timezone: 'Europe/Moscow' };
  expect(new Date(nextDaily(daily, Date.parse('2026-01-01T05:59:00Z'))).toISOString()).toBe('2026-01-01T06:00:00.000Z');
  expect(new Date(nextDaily({ ...daily, weekdays: [1] }, Date.parse('2026-01-02T10:00:00Z'))).toISOString()).toBe('2026-01-05T06:00:00.000Z');
  expect(new Date(nextDaily({ kind: 'daily', time: '02:30', timezone: 'America/New_York' }, Date.parse('2026-03-08T05:00:00Z'))).toISOString()).toBe('2026-03-09T06:30:00.000Z');
  expect(new Date(nextDaily({ kind: 'daily', time: '01:30', timezone: 'America/New_York' }, Date.parse('2026-11-01T05:30:00Z'))).toISOString()).toBe('2026-11-02T06:30:00.000Z');
});

test('poll sources are shared, non-overlapping, unchanged checks stay silent, and failures back off', async () => {
  const f = fixture(); let calls = 0; let resolve!: (v: any[]) => void;
  f.runtime.registerSource({ name: 'example', intervalMs: 1000, poll: async () => { calls++; return calls > 2 ? [] : new Promise(r => { resolve = r; }); } });
  f.create({ intent: 'React', trigger: { kind: 'change', source: 'example' } });
  f.tick(); await Promise.resolve(); f.tick(); expect(calls).toBe(1);
  resolve([{ source: 'example', key: 'same', data: { value: 1 } }]); await f.runtime.settleSources();
  f.time(1000); f.tick(); await Promise.resolve(); resolve([{ source: 'example', key: 'same', data: { value: 1 } }]); await f.runtime.settleSources();
  expect(f.runtime.metrics.queued).toBe(1); expect(f.receipts).toEqual([]);
  f.runtime.registerSource({ name: 'broken', intervalMs: 1000, poll: async () => { throw new Error('private'); } });
  f.tick(); await f.runtime.settleSources(); const failures = f.runtime.metrics.sourceFailures;
  f.time(1000); f.tick(); await f.runtime.settleSources(); expect(f.runtime.metrics.sourceFailures).toBe(failures); f.runtime.close();
});

test('validation rejects unsupported/invalid schedules and disabled sources without changing tasks', () => {
  const f = fixture();
  expect(validTaskDefinition({ ...joke, trigger: { kind: 'interval', seconds: 1 } })).toBe(false);
  expect(validTaskDefinition({ ...joke, trigger: { kind: 'daily', time: '25:00', timezone: 'bad' } })).toBe(false);
  expect(f.runtime.create('a', 1, { intent: 'x', trigger: { kind: 'change', source: 'unknown' } })).toBeUndefined();
  expect(validTaskDefinition({ ...joke, tools: ['exec'] })).toBe(false); expect(f.runtime.list()).toEqual([]); f.runtime.close();
});

test('Spotify deduplicates updates and seeks, preserves fast changes and later replays, and tolerates missing IDs', () => {
  const observations: any[] = []; const source = new TaskPresence(o => { if (o.source === 'spotify' && o.available !== false) observations.push(o); }, () => 1000);
  const song = (title: string, start: number, end: number) => ({ activities: [{ type: 2, name: 'Spotify', details: title, state: 'Artist', timestamps: { start: new Date(start), end: new Date(end) } }] });
  source.update('a', song('A', 0, 10000), ''); source.update('a', song('A', 1000, 11000), '');
  expect(observations[0].key).toBe(observations[1].key);
  source.update('a', song('B', 2000, 12000), ''); source.update('a', song('C', 3000, 13000), '');
  expect(new Set(observations.map(o => o.key)).size).toBe(3);
  source.update('a', song('C', 13000, 23000), ''); expect(observations.at(-1).key).not.toBe(observations.at(-2).key);
  const before = observations.at(-1).key; source.update('a', null, ''); source.update('a', song('C', 13000, 23000), ''); expect(observations.at(-1).key).toBe(before);
  source.update('a', { activities: [] }, ''); source.update('a', song('C', 13000, 23000), ''); expect(observations.at(-1).key).toBe(before);
  source.close();
});

test('research shares requests, isolates cancellation, reuses evidence and never caches late canceled output', async () => {
  let calls = 0; let resolve!: (v: any[]) => void;
  const research = new TaskResearch(async () => { calls++; return new Promise(r => { resolve = r; }); }, 1000);
  const a = new AbortController(), b = new AbortController();
  const first = research.search('artist facts', a.signal, () => true); const second = research.search('artist facts', b.signal, () => false);
  await Promise.resolve(); a.abort(); await expect(first).rejects.toThrow();
  resolve([{ title: 'Facts', url: 'https://example.org/artist', snippet: 'A supported fact.' }]); expect((await second).status).toBe('ready'); expect(calls).toBe(1);
  expect((await research.search('artist facts', b.signal, () => false)).status).toBe('ready'); expect(calls).toBe(1); research.close();
});
