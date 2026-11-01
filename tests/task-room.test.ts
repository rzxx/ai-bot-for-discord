import { expect, test } from 'bun:test';
import { RoomController, type Playback } from '../src/room';
import { defaults } from '../src/config';
import { TaskQueue } from '../src/queue';
import { parseActions, type ToolHost } from '../src/room-tools';
import { PlusBrain, type Brain, type RoomSnapshot, type Reply } from '../src/llm';
import type { PlanAuth } from '../src/auth';

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const a = { id: 'alice', name: 'Alice' }, b = { id: 'bob', name: 'Bob' };
const due = (snapshot: RoomSnapshot) => snapshot.events.filter(e => snapshot.responsePolicy?.triggerEventIds.includes(e.id) && e.kind === 'tool')
  .flatMap(e => { const r = JSON.parse(e.text); return r.tool === 'tasks' && r.status === 'due' ? [{ ...r, event: e.id }] : []; });
async function settle() { for (let i = 0; i < 25; i++) await Promise.resolve(); }
function fixture(reply?: Brain['reply'], host: Partial<ToolHost> = {}, playback?: (signal: AbortSignal) => Promise<Playback>) {
  let now = 100000;
  const snapshots: RoomSnapshot[] = [], played: string[] = [], sends: string[] = [], signals: AbortSignal[] = [];
  const room = new RoomController({ ...defaults, botName: 'Companion', roomQuietMs: 100, prepareQuietMs: 50, replyStartQuietMs: 50,
    thinkingCues: false, streamReplies: false, presenceContext: true }, {
      reply: async (s, signal) => { snapshots.push(s); signals.push(signal); return reply ? reply(s, signal) : { speak: due(s).length > 0, text: due(s).length ? 'A contextual contribution.' : '',
        taskResults: due(s).map(r => ({ run: r.run, status: 'done' as const })) }; },
    }, { transcribe: async () => '' }, { synthesize: async text => { played.push(text); return Buffer.from(text); } }, {
      play: async (_audio, signal, hooks) => { await hooks?.beforeStart?.(); signal.throwIfAborted(); hooks?.onStart?.(now); return playback ? playback(signal) : { completed: true, playedMs: 500, startedAt: now, endedAt: now + 500 }; }, stop() {},
    }, new TaskQueue(2), () => {}, { autoTick: false, now: () => now, convertOutput: async b => b, trace() {},
      tools: { limits: new Map(), resolvePerson: ref => ['alice', 'u1', 'Alice'].includes(ref) ? a : ['bob', 'u2', 'Bob'].includes(ref) ? b : undefined,
        activity: () => ({ status: 'online', activity: 'Minecraft' }), sendMessage: async (_actor, text) => { sends.push(text); }, ...host } });
  room.setMember(a); room.setMember(b);
  return { room, snapshots, played, sends, signals, time: (ms = 200) => { now += ms; } };
}

test('natural-language task creation, correction and management use live speech and need no extra approval', async () => {
  let step = 0;
  const f = fixture(async s => ({ speak: false, text: '', actions: [{ tool: 'tasks', event: s.responsePolicy!.triggerEventIds[0]!,
    ...(step++ === 0 ? { op: 'create' as const, definition: { intent: 'Roast my music', trigger: { kind: 'change' as const, source: 'spotify', subject: 'u1' } } }
      : { op: 'update' as const, id: 't1', definition: { intent: 'Be kinder about my music', trigger: { kind: 'change' as const, source: 'spotify', subject: 'u1' } } }) }] }));
  try {
    f.room.transcript(a, 'Roast my tracks'); f.time(); await f.room.tick(); expect(f.room.tasks.list()[0]).toMatchObject({ id: 't1', owner: 'alice', trigger: { subject: 'alice' } });
    f.room.transcript(b, 'Be kinder about the music'); f.time(); await f.room.tick(); expect(f.room.tasks.list()).toHaveLength(1); expect(f.room.tasks.get('t1')!.revision).toBe(2);
    const chatId = 999;
    f.room.tools!.submit([{ tool: 'tasks', event: chatId, op: 'cancel', id: 't1' }], [{ id: chatId, kind: 'chat', userId: 'alice', text: 'cancel', at: 1 }], new AbortController().signal);
    expect(f.room.tasks.get('t1')).toBeDefined();
  } finally { f.room.close(); }
});

test('unchanged activity checks cause neither inference nor prompt events; rapid tracks arrive together', async () => {
  const f = fixture();
  try {
    f.room.tasks.create(a.id, 1, { intent: 'Roast tracks', trigger: { kind: 'change', source: 'spotify', subject: a.id } });
    const presence = (title: string) => ({ activities: [{ type: 2, name: 'Spotify', details: title, state: 'Artist' }] });
    f.room.presence.update(a.id, presence('A'), 'listening A'); f.room.presence.update(a.id, presence('B'), 'listening B'); f.room.presence.update(a.id, presence('C'), 'listening C');
    await f.room.tick(); expect(f.snapshots).toHaveLength(1); expect(due(f.snapshots[0]!)[0]!.observations.map((o: any) => o.data.title)).toEqual(['A', 'B', 'C']);
    const count = f.room.events.length;
    for (let i = 0; i < 100; i++) { f.room.presence.update(a.id, presence('C'), 'listening C'); f.time(200); await f.room.tick(); }
    expect(f.snapshots).toHaveLength(1); expect(f.room.events).toHaveLength(count);
  } finally { f.room.close(); }
});

test('overlapping task occurrences and a human question share one model turn with separate outcomes', async () => {
  const f = fixture();
  try {
    for (const intent of ['Tell a joke', 'React to game']) f.room.tasks.create(a.id, 1, { intent, trigger: { kind: 'interval', seconds: 5 } });
    f.time(5000); f.room.transcript(b, 'Companion, what is happening?'); f.time(); await f.room.tick();
    expect(f.snapshots).toHaveLength(1); expect(due(f.snapshots[0]!)).toHaveLength(2); expect(f.room.tasks.metrics.delivered).toBe(2); expect(f.played).toHaveLength(1);
  } finally { f.room.close(); }
});

test('prepared recurring reminders bypass inference, batch, and disappear on session close', async () => {
  const f = fixture();
  for (const text of ['Drink water', 'Stretch']) f.room.tasks.create(a.id, 1, { intent: text, text, delivery: 'prepared', trigger: { kind: 'interval', seconds: 5 } });
  f.time(5000); await f.room.tick(); expect(f.snapshots).toHaveLength(0); expect(f.played).toHaveLength(1); expect(f.played[0]).toContain('Drink water'); expect(f.played[0]).toContain('Stretch');
  f.room.close(); f.time(5000); await f.room.tick(); expect(f.played).toHaveLength(1); expect(f.room.tasks.list()).toEqual([]);
  const next = fixture(); try { expect(next.room.tasks.list()).toEqual([]); } finally { next.room.close(); }
});

test('task research is silent, survives foreground conversation, then continues with intervening context', async () => {
  const search = deferred<any[]>(); let researchSignal!: AbortSignal;
  const f = fixture(async s => {
    const [task] = due(s);
    if (task && !task.receipts.length) return { speak: false, text: '', actions: [{ tool: 'search', event: task.event, run: task.run, query: 'Artist official biography' }] };
    return task ? { speak: true, text: 'Here is the researched roast.', taskResults: [{ run: task.run, status: 'done' }] } : { speak: true, text: 'Answer to the human.' };
  }, { search: async (_query, signal) => { researchSignal = signal; return search.promise; } });
  try {
    f.room.tasks.create(a.id, 1, { intent: 'Research and roast artist', trigger: { kind: 'once', seconds: 5 } });
    f.time(5000); await f.room.tick(); await settle(); expect(f.played).toHaveLength(0); expect(researchSignal.aborted).toBe(false);
    f.room.transcript(b, 'Companion, help with the game'); f.time(); await f.room.tick(); expect(researchSignal.aborted).toBe(false); expect(f.played).toEqual(['Answer to the human.']);
    search.resolve([{ title: 'Artist', url: 'https://example.org/artist', snippet: 'Supported biography.' }]); await f.room.tools!.settle();
    f.time(16000); await f.room.tick(); const snapshot = f.snapshots.at(-1)!;
    expect(snapshot.events.some(e => e.kind === 'speech' && e.text.includes('help with the game'))).toBe(true);
    expect(due(snapshot)[0]!.receipts[0]).toMatchObject({ tool: 'search', status: 'ready' }); expect(f.played.at(-1)).toBe('Here is the researched roast.');
    expect(f.room.tasks.metrics.delivered).toBe(1);
  } finally { f.room.close(); }
});

test('task search grants reject forged runs, unauthorized writes, duplicate tools and private queries', async () => {
  let searches = 0;
  const f = fixture(async s => {
    const [task] = due(s); if (!task) return { speak: false, text: '' };
    return { speak: false, text: '', actions: [{ tool: 'message', event: task.event, run: task.run, text: 'unauthorized' },
      { tool: 'search', event: task.event, run: 'o99999', query: 'artist biography' }], taskResults: [{ run: task.run, status: 'skip' }] };
  }, { search: async () => { searches++; return []; } });
  try {
    f.room.tasks.create(a.id, 1, { intent: 'Roast', trigger: { kind: 'once', seconds: 5 }, tools: ['search'] }); f.time(5000); await f.room.tick(); await f.room.tools!.settle();
    expect(f.sends).toEqual([]); expect(searches).toBe(0);
    expect(parseActions([{ tool: 'tasks', event: 1, run: 'o1', op: 'create', definition: { intent: 'x', trigger: { kind: 'once', seconds: 5 } } }])).toEqual([]);
  } finally { f.room.close(); }
});

test('two task searches share network work and bounded evidence without crossing occurrence ownership', async () => {
  let searches = 0; const search = deferred<any[]>();
  const f = fixture(async s => {
    const tasks = due(s);
    return tasks.some(t => !t.receipts.length) ? { speak: false, text: '', actions: tasks.map(task => ({ tool: 'search' as const, event: task.event, run: task.run, query: 'artist public biography' })) }
      : { speak: true, text: 'One combined contribution.', taskResults: tasks.map(task => ({ run: task.run, status: 'done' as const })) };
  }, { search: async () => { searches++; return search.promise; } });
  try {
    for (const owner of [a, b]) f.room.tasks.create(owner.id, 1, { intent: 'Research artist', trigger: { kind: 'once', seconds: 5 } });
    f.time(5000); await f.room.tick(); await settle(); expect(searches).toBe(1);
    search.resolve([{ title: 'Evidence', url: 'https://example.org/artist', snippet: 'Artist evidence.' }]); await f.room.tools!.settle();
    f.time(10000); await f.room.tick(); expect(f.room.tasks.metrics.delivered).toBe(2); expect(f.played).toHaveLength(1);
  } finally { f.room.close(); }
});

test('uncertain task messages are never retried, even after the send cooldown passes', async () => {
  let attempts = 0;
  const f = fixture(async s => { const [task] = due(s); return { speak: false, text: '', actions: task ? [{ tool: 'message', event: task.event, run: task.run, text: 'Requested recurring notification' }] : [] }; },
    { sendMessage: async () => { attempts++; throw new Error('Unknown remote send outcome'); } });
  try {
    f.room.config.messageCooldownSeconds = 30;
    f.room.tasks.create(a.id, 1, { intent: 'Post one notification', trigger: { kind: 'once', seconds: 5 }, tools: ['message'] });
    f.time(5000); await f.room.tick(); await f.room.tools!.settle(); expect(attempts).toBe(1);
    f.time(31000); await f.room.tick(); expect(attempts).toBe(1); expect(f.room.tasks.list()).toEqual([]);
    expect(f.room.events.some(e => e.text.includes('delivery_unknown'))).toBe(true);
  } finally { f.room.close(); }
});

test('private participant queries are rejected before task search network access', async () => {
  let attempts = 0;
  const f = fixture(async s => { const [task] = due(s); return { speak: false, text: '', actions: task ? [{ tool: 'search', event: task.event, run: task.run, query: 'Alice Discord biography' }] : [] }; },
    { privateTerms: () => ['Alice'], search: async () => { attempts++; return []; } });
  try {
    f.room.tasks.create(a.id, 1, { intent: 'Research', trigger: { kind: 'once', seconds: 5 } }); f.time(5000); await f.room.tick(); await f.room.tools!.settle();
    f.time(10000); await f.room.tick(); expect(attempts).toBe(0); expect(due(f.snapshots.at(-1)!)[0]!.receipts[0].status).toBe('private_query');
  } finally { f.room.close(); }
});

test('slash-style task controls revoke an in-flight contribution before audio without inference', async () => {
  const pending = deferred<Reply>(); const f = fixture(async () => pending.promise);
  try {
    const task = f.room.tasks.create(a.id, 1, { intent: 'Joke', trigger: { kind: 'once', seconds: 5 } })!;
    f.time(5000); const turn = f.room.tick(); await settle();
    expect(f.room.manageTask(b.id, task.id, 'cancel')).toBe(true); expect(f.signals[0]!.aborted).toBe(true);
    pending.resolve({ speak: true, text: 'Canceled joke' }); await turn; expect(f.played).toEqual([]); expect(f.room.tasks.list()).toEqual([]);
  } finally { f.room.close(); }
});

test('new human speech preempts proactive inference without losing the occurrence or overlapping model writers', async () => {
  const pending = deferred<Reply>(); let active = 0, maxActive = 0;
  const f = fixture(async s => {
    active++; maxActive = Math.max(maxActive, active);
    try { return due(s).length ? await pending.promise : { speak: false, text: '' }; } finally { active--; }
  });
  try {
    f.room.tasks.create(a.id, 1, { intent: 'Tell a joke', trigger: { kind: 'interval', seconds: 5 } }); f.time(5000);
    const proactive = f.room.tick(); await settle(); f.room.activity(b.id, true); expect(f.signals[0]!.aborted).toBe(true);
    f.room.transcript(b, 'Companion, help'); f.room.activity(b.id, false); f.time(); await f.room.tick(); expect(f.snapshots).toHaveLength(1);
    pending.resolve({ speak: true, text: 'Obsolete joke' }); await proactive; expect(f.played).toEqual([]);
    f.time(); await f.room.tick(); expect(maxActive).toBe(1); expect(f.snapshots).toHaveLength(2); expect(f.room.tasks.list()[0]!.pendingRuns).toBeGreaterThan(0);
  } finally { f.room.close(); }
});

test('silence output is withdrawn if activity resumes during synthesis', async () => {
  const audio = deferred<Buffer>(); let called = 0;
  const f = fixture();
  try {
    f.room.speaker.synthesize = async () => { called++; return audio.promise; };
    f.room.transcript(a, 'thanks'); f.time(); await f.room.tick();
    f.room.tasks.create(a.id, 1, { intent: 'Fill silence', trigger: { kind: 'silence', seconds: 5 } });
    f.time(5000); const task = f.room.tick(); await settle(); expect(called).toBe(1);
    f.room.activity(b.id, true); audio.resolve(Buffer.from('stale')); await task;
    expect(f.room.tasks.metrics.delivered).toBe(0); expect(f.room.tasks.metrics.skipped).toBeGreaterThan(0);
  } finally { f.room.close(); }
});

test('cancel during task research discards even an ignoring provider result and cannot revive a task', async () => {
  const search = deferred<any[]>(); let signal!: AbortSignal;
  const f = fixture(async s => { const [task] = due(s); return { speak: false, text: '', actions: task ? [{ tool: 'search', event: task.event, run: task.run, query: 'artist facts' }] : [] }; },
    { search: async (_query, s) => { signal = s; return search.promise; } });
  try {
    const task = f.room.tasks.create(a.id, 1, { intent: 'Research', trigger: { kind: 'once', seconds: 5 } })!;
    f.time(5000); await f.room.tick(); await settle(); f.room.tasks.manage(task.id, 'cancel'); await f.room.tools!.settle();
    expect(signal.aborted).toBe(true); search.resolve([{ title: 'late', url: 'https://example.org', snippet: 'late private receipt' }]); await settle();
    f.time(30000); await f.room.tick(); expect(f.snapshots).toHaveLength(1); expect(JSON.stringify(f.room.events)).not.toContain('late private receipt');
  } finally { f.room.close(); }
});

test('task lifecycle and continuations append to the exact same provider prefix and cache identity', async () => {
  const requests: any[] = [];
  const brain = new PlusBrain({ token: async () => 'fixture' } as unknown as PlanAuth, { ...defaults, model: 'fixture' }, async (_url, init) => {
    requests.push(JSON.parse(String(init.body)));
    return new Response('data: {"type":"response.output_text.delta","delta":"{\\"speak\\":false,\\"text\\":\\"\\"}"}\n\ndata: {"type":"response.completed"}\n\n');
  });
  const base: RoomSnapshot = { sessionId: 'shared-task-test', botName: 'Companion', now: 1000, members: [a], events: [], capabilities: ['tasks'] };
  const signal = new AbortController().signal;
  try {
    await brain.reply(base, signal);
    await brain.reply({ ...base, now: 2000, events: [{ id: 1, at: 2000, kind: 'tool', userId: a.id, text: JSON.stringify({ tool: 'tasks', status: 'scheduled', id: 't1' }) }] }, signal);
    await brain.reply({ ...base, now: 3000, events: [{ id: 2, at: 3000, kind: 'tool', userId: a.id, text: JSON.stringify({ tool: 'tasks', status: 'due', id: 't1', run: 'o1', receipts: [{ tool: 'search', status: 'ready' }] }) }] }, signal);
    for (let i = 1; i < requests.length; i++) {
      expect(requests[i].input.slice(0, requests[i - 1].input.length)).toEqual(requests[i - 1].input);
      expect(requests[i].prompt_cache_key).toBe('shared-task-test'); expect(requests[i].model).toBe('fixture');
    }
  } finally { brain.release(base.sessionId); }
});
