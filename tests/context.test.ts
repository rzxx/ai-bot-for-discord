import { test, expect } from 'bun:test';
import { SessionContext, ContextLimitError, type ModelResult, type InputItem } from '../src/context';
import { PlusBrain, type RoomSnapshot, type HTTPTransport } from '../src/llm';
import { defaults } from '../src/config';
import type { PlanAuth } from '../src/auth';

const signal = () => new AbortController().signal;

test('query identities stay outside the voice roster and reuse the same alias on later join', async () => {
  const context = new SessionContext('Fixed instructions', defaults), calls: InputItem[][] = [];
  const request = async (input: InputItem[]) => { calls.push(structuredClone(input)); return result(); };
  await context.run(snapshot(1), request, signal());
  const ref = context.referenceUser('music-bot-id');
  expect(ref).toBe('u2'); expect(context.resolveUser(ref)).toBe('music-bot-id');
  const second = snapshot(2);
  second.events = [{ id: 2, at: 2000, kind: 'tool', userId: 'alice-discord-id', text: JSON.stringify({ tool: 'members', event: 1,
    status: 'ready', columns: ['ref', 'name', 'bot'], rows: [[ref, 'Music', 1]], complete: true }) }];
  await context.run(second, request, signal());
  expect(JSON.parse(calls[1]!.at(-1)!.content).p).toBeUndefined();
  const third = snapshot(3); third.members.push({ id: 'music-bot-id', name: 'Music' });
  await context.run(third, request, signal());
  expect(JSON.parse(calls[2]!.at(-1)!.content).p).toContainEqual([ref, 'Music', 1]);
  expect(JSON.stringify(calls)).not.toContain('music-bot-id');
  expect(calls[2]!.slice(0, calls[1]!.length)).toEqual(calls[1]!);
});
function snapshot(id: number, now = id * 1000): RoomSnapshot {
  return { sessionId: 'room-a', botName: 'Лёва', now, members: [{ id: 'alice-discord-id', name: 'Алёна' }],
    timeline: { sessionStartedAt: 0, quietForMs: 1200, sinceLastBotSpeechMs: null },
    events: [{ id, at: now - 1200, kind: 'speech', userId: 'alice-discord-id', name: 'Алёна', text: `Реплика ${id}` }] };
}
function result(text = '{"speak":false,"text":""}', id = 'out-1'): ModelResult {
  return { text, output: [
    { type: 'reasoning', id: `${id}-reasoning`, summary: [], encrypted_content: `opaque-${id}` },
    { type: 'message', id, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] },
  ], usage: { input_tokens: 1200, input_tokens_details: { cached_tokens: 1024 }, output_tokens: 30, output_tokens_details: { reasoning_tokens: 10 } } };
}

test('late speech, roster and state changes only append; unchanged state and long IDs are omitted', async () => {
  const context = new SessionContext('Fixed instructions', defaults), calls: InputItem[][] = [];
  const request = async (input: InputItem[]) => { calls.push(structuredClone(input)); return result(undefined, `out-${calls.length}`); };
  const first = snapshot(1); first.states = [{ userId: first.members[0]!.id, status: 'online', activity: 'Minecraft', muted: false, deafened: false }];
  await context.run(first, request, signal());
  const firstUpdate = JSON.parse(calls[0]!.at(-1)!.content);
  expect(firstUpdate.p).toEqual([['u1', 'Алёна', 1]]);
  expect(firstUpdate.s).toEqual([['u1', { s: 'online', a: 'Minecraft' }]]);
  const second = { ...snapshot(2, 3600000), states: first.states };
  await context.run(second, request, signal());
  const update = JSON.parse(calls[1]!.at(-1)!.content);
  expect(update.p).toBeUndefined(); expect(update.s).toBeUndefined(); expect(update.start).toBeUndefined(); expect(update.cap).toBeUndefined();
  expect(calls[1]!.slice(0, calls[0]!.length)).toEqual(calls[0]!);
  expect(calls[1]!.slice(calls[0]!.length, -1)).toEqual(result().output);
  expect(JSON.stringify(calls)).not.toContain('alice-discord-id');
  const late = snapshot(3, 3602000); late.events[0]!.at = -1000;
  late.members = [{ id: 'bob-discord-id', name: 'Лёша' }];
  await context.run(late, request, signal());
  expect(calls[2]!.slice(0, calls[1]!.length)).toEqual(calls[1]!);
  const tail = JSON.parse(calls[2]!.at(-1)!.content);
  expect(tail.e).toEqual([[3, 'speech', -1000, 'u1', 'Реплика 3']]);
  expect(tail.p).toContainEqual(['u1', 0]); expect(tail.p).toContainEqual(['u2', 'Лёша', 1]);
  expect(context.resolveUser('u1')).toBe('alice-discord-id');
  expect(calls[2]!.filter(i => i.type === 'reasoning').map(i => i.encrypted_content)).toEqual(['opaque-out-1', 'opaque-out-2']);
});

test('relative intervals preserve overlapping speech and delivery references avoid repeating spoken text', async () => {
  const context = new SessionContext('Fixed instructions', defaults), calls: InputItem[][] = [];
  const request = async (input: InputItem[]) => { calls.push(structuredClone(input)); return result(); };
  const first = snapshot(1, 100000); first.timeline!.sessionStartedAt = 90000;
  await context.run(first, request, signal());
  const second = snapshot(2, 108000);
  second.events = [
    { id: 2, at: 103500, end: 103900, kind: 'speech', userId: 'alice-discord-id', name: 'Алёна', text: 'А дальше?' },
    { id: 3, at: 106500, end: 106800, kind: 'speech', userId: 'alice-discord-id', name: 'Алёна', text: 'Спасибо.' },
    { id: 4, at: 102000, end: 106000, playedMs: 4000, kind: 'assistant', text: 'Already generated long answer', replyTo: 1 },
  ];
  await context.run(second, request, signal());
  const update = JSON.parse(calls[1]!.at(-1)!.content);
  expect(update.e).toEqual([[4, 'assistant', 12000, '', '', 4000, 4000, 1], [2, 'speech', 13500, 'u1', 'А дальше?', 400], [3, 'speech', 16500, 'u1', 'Спасибо.', 300]]);
  expect(calls[1]!.at(-1)!.content).not.toContain('Already generated long answer');
});

test('mute-only updates do not repeat names, status or game, and receipts avoid nested JSON strings', async () => {
  const context = new SessionContext('Fixed', defaults), calls: InputItem[][] = [];
  const request = async (input: InputItem[]) => { calls.push(structuredClone(input)); return result(); };
  const first = snapshot(1); first.states = [{ userId: first.members[0]!.id, status: 'online', activity: 'Minecraft', muted: false, deafened: false }];
  await context.run(first, request, signal());
  const receipt = { tool: 'search', event: 1, status: 'ready', results: [{ title: 'News', snippet: 'Short excerpt', url: 'https://www.minecraft.net/' }] };
  const second = { ...snapshot(2), states: [{ ...first.states[0]!, muted: true }], events: [{ id: 2, at: 2000, kind: 'tool' as const, userId: first.members[0]!.id, text: JSON.stringify(receipt) }] };
  await context.run(second, request, signal());
  const update = JSON.parse(calls[1]!.at(-1)!.content);
  expect(update.s).toEqual([['u1', { m: 1 }]]); expect(update.p).toBeUndefined(); expect(update.e[0][4]).toEqual(receipt);
  expect(calls[1]!.at(-1)!.content).not.toContain('\\"');
  expect(calls[1]!.slice(0, calls[0]!.length)).toEqual(calls[0]!);
});

test('every tool outcome and richer activity updates append without rewriting prior requests', async () => {
  const context = new SessionContext('Fixed', defaults), calls: InputItem[][] = [];
  const request = async (input: InputItem[]) => { calls.push(structuredClone(input)); return result(undefined, `result-${calls.length}`); };
  await context.run(snapshot(1), request, signal());
  const receipts = [
    { tool: 'message', event: 1, status: 'sent' },
    { tool: 'message', event: 1, status: 'rejected', reason: 'negated_request' },
    { tool: 'remind', event: 1, status: 'scheduled', id: 'r1', seconds: 30, text: 'Проверь чай.' },
    { tool: 'cancel_reminder', event: 1, status: 'canceled', id: 'r1' },
    { tool: 'reminders', event: 1, status: 'ready', items: [] },
    { tool: 'activity', event: 1, status: 'ready', presenceStatus: 'online', presenceAvailable: true, activity: 'Minecraft — Ranked match' },
    { tool: 'search', event: 1, status: 'ready', results: [{ title: 'News', snippet: 'Update', url: 'https://www.minecraft.net/' }] },
  ];
  for (const [index, receipt] of receipts.entries()) {
    const next = snapshot(index + 2);
    next.events = [{ id: index + 2, at: next.now, kind: 'tool', userId: next.members[0]!.id, text: JSON.stringify(receipt) }];
    next.states = [{ userId: next.members[0]!.id, status: 'online', activity: 'Minecraft — Ranked match', muted: false, deafened: false }];
    await context.run(next, request, signal());
    const previous = calls.at(-2)!, current = calls.at(-1)!;
    expect(current.slice(0, previous.length)).toEqual(previous);
    const tail = JSON.parse(current.at(-1)!.content);
    expect(tail.e[0][4]).toEqual(receipt);
    if (index) expect(tail.s).toBeUndefined();
  }
});

test('token ceiling never summarizes, rewrites history, calls another model or rotates cache identity', async () => {
  const options = { contextMaxTokens: 10000 }, context = new SessionContext('Fixed instructions', options), calls: InputItem[][] = [];
  const request = async (input: InputItem[]) => { calls.push(structuredClone(input)); return result(); };
  await context.run(snapshot(1), request, signal()); options.contextMaxTokens = 1;
  await expect(context.run(snapshot(2), request, signal())).rejects.toBeInstanceOf(ContextLimitError);
  expect(calls).toHaveLength(1); options.contextMaxTokens = 10000;
  const resumed = snapshot(3); resumed.events.unshift(snapshot(2).events[0]!);
  await context.run(resumed, request, signal());
  expect(calls[1]!.slice(0, calls[0]!.length)).toEqual(calls[0]!);
  expect(JSON.parse(calls[1]!.at(-1)!.content).e.map((e: any[]) => e[0])).toEqual([2, 3]);
  expect(calls[1]!.filter(i => i.role === 'developer')).toHaveLength(1);
});

test('an unchanged eight-person room appends a small delta rather than another full snapshot', async () => {
  const context = new SessionContext('Fixed instructions', defaults), calls: InputItem[][] = [];
  const request = async (input: InputItem[]) => { calls.push(structuredClone(input)); return result(); };
  const first = snapshot(1);
  first.members = Array.from({ length: 8 }, (_, n) => ({ id: `synthetic-discord-person-${n}`, name: `Participant ${n}` }));
  first.events[0]!.userId = first.members[0]!.id;
  await context.run(first, request, signal());
  const second = { ...first, now: 2000, events: [{ ...first.events[0]!, id: 2, text: 'А какая карта?' }] };
  await context.run(second, request, signal());
  const tail = calls[1]!.at(-1)!.content;
  expect(tail.length).toBeLessThan(120);
  expect(tail.length).toBeLessThan(JSON.stringify(second).length / 4);
  expect(tail).not.toContain('Participant');
});

test('a fresh join has no identities, chat, tool results or reasoning from the prior session', async () => {
  const old = new SessionContext('Fixed', defaults);
  await old.run({ ...snapshot(1), events: [{ id: 1, at: 1, kind: 'chat', userId: 'old', name: 'Old', text: 'Private old chat' }] }, async () => result(), signal());
  old.release();
  const fresh = new SessionContext('Fixed', defaults);
  await fresh.run(snapshot(2), async input => {
    expect(input).toHaveLength(2); expect(JSON.stringify(input)).not.toContain('Private old chat'); expect(JSON.stringify(input)).not.toContain('opaque');
    return result();
  }, signal());
});

test('closing during generation cannot resurrect completed output', async () => {
  const context = new SessionContext('Fixed', defaults); let finish!: (value: ModelResult) => void;
  const pending = context.run(snapshot(1), () => new Promise(resolve => { finish = resolve; }), signal());
  context.release(); finish(result());
  await expect(pending).rejects.toThrow('closed'); expect(context.metrics.retainedItems).toBe(0); expect(context.metrics.estimatedTokens).toBe(0);
});

test('concurrent calls cannot interleave the session prefix', async () => {
  const context = new SessionContext('Fixed', defaults), calls: InputItem[][] = []; let finish!: (value: ModelResult) => void;
  const first = context.run(snapshot(1), input => { calls.push(structuredClone(input)); return new Promise(resolve => { finish = resolve; }); }, signal());
  await expect(context.run(snapshot(2), async () => result(), signal())).rejects.toThrow('Concurrent');
  finish(result()); await first;
  await context.run(snapshot(2), async input => { calls.push(structuredClone(input)); return result(); }, signal());
  expect(calls[1]!.slice(0, calls[0]!.length)).toEqual(calls[0]!);
});

test('superseded requests keep their submitted tail without committing canceled model output', async () => {
  const context = new SessionContext('Fixed', defaults), abort = new AbortController(), calls: InputItem[][] = [];
  const first = snapshot(1); first.responsePolicy = { triggerEventIds: [1], maxChars: 240, preparingEarly: true };
  await expect(context.run(first, async input => { calls.push(structuredClone(input)); abort.abort(); return result('Unspoken'); }, abort.signal)).rejects.toThrow();
  const second = snapshot(2); second.events.unshift(first.events[0]!); second.responsePolicy = { triggerEventIds: [1, 2], maxChars: 240, preparingEarly: true };
  await context.run(second, async input => { calls.push(structuredClone(input)); return result(); }, signal());
  expect(calls[1]!.slice(0, calls[0]!.length)).toEqual(calls[0]!);
  expect(calls[1]!.some(i => i.role === 'assistant')).toBe(false);
  const tail = JSON.parse(calls[1]!.at(-1)!.content);
  expect(tail.e.map((e: any[]) => e[0])).toEqual([2]); expect(tail.r).toEqual([1, 2]); expect(tail.limit).toBeUndefined();
});

test('PlusBrain preserves exact provider items, stable settings, cache keys and isolated rooms', async () => {
  const calls: { body: any; headers: Headers }[] = [];
  const transport: HTTPTransport = async (_url, init) => {
    calls.push({ body: JSON.parse(init.body as string), headers: new Headers(init.headers) });
    const r = result(undefined, `out-${calls.length}`);
    const events = [...r.output.map((item, output_index) => ({ type: 'response.output_item.done', item, output_index })), { type: 'response.completed', response: { output: [], usage: r.usage } }];
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
  };
  const config = { ...defaults, model: 'gpt-6.1-sol' };
  const brain = new PlusBrain({ token: async () => 'test' } as unknown as PlanAuth, config, transport);
  await brain.reply(snapshot(1), signal()); config.reasoningEffort = 'high';
  await brain.reply(snapshot(2), signal()); const other = snapshot(3); other.sessionId = 'room-b'; await brain.reply(other, signal());
  expect(calls[1]!.body.input.slice(0, calls[0]!.body.input.length)).toEqual(calls[0]!.body.input);
  expect(calls[1]!.body.reasoning).toEqual(calls[0]!.body.reasoning);
  expect(calls[1]!.body.input.find((i: any) => i.type === 'reasoning').encrypted_content).toBe('opaque-out-1');
  expect(calls[2]!.body.input).toHaveLength(2);
  expect(calls[1]!.body.prompt_cache_key).toBe('room-a'); expect(calls[1]!.headers.get('session-id')).toBe('room-a');
  expect(brain.resolveUser('room-a', 'u1')).toBe('alice-discord-id');
  brain.release('room-a'); expect(brain.contextMetrics('room-a')).toBeUndefined(); expect(brain.contextMetrics('room-b')?.calls).toBe(1);
});
