import { expect, test } from 'bun:test';
import { Collection, type Guild } from 'discord.js';
import { ChatRetrieval, CHAT_RESULT_BYTES, retrievedText, validChatQuery, type ChatQuery } from '../src/chat-retrieval';
import { defaults } from '../src/config';
import { RoomTools, parseActions, type ToolReceipt, type ToolHost } from '../src/room-tools';
import type { TurnEvent } from '../src/llm';
import { ContextWire } from '../src/context-wire';

const guildId = '1'.repeat(18), channelId = '2'.repeat(18), otherId = '3'.repeat(18);
const mid = (n: number) => String(1400000000000000000n + BigInt(n));
const message = (n: number, content = `Message ${n}`, channel = channelId) => ({ id: mid(n), channel_id: channel, type: 0,
  author: { id: 'alex', username: 'Alex' }, content, timestamp: `2026-10-31T12:00:${String(n % 60).padStart(2, '0')}Z`,
  edited_timestamp: null, attachments: [] });
function fixture() {
  let now = Date.parse('2026-11-01T12:00:00Z'), audience = ['alice'], active = true;
  const denied = new Set<string>(), requests: { route: string; query: URLSearchParams; signal: AbortSignal }[] = [];
  const makeChannel = (id: string, name: string) => ({ id, name, type: 0, isTextBased: () => true,
    permissionsFor: (user: string) => ({ has: () => !denied.has(`${id}:${user}`) }) });
  const channels = new Collection([[channelId, makeChannel(channelId, 'bound')], [otherId, makeChannel(otherId, 'general')]]);
  const people = new Collection(['bot', 'alice', 'bob', 'alex'].map(id => [id, { id, displayName: id === 'alex' ? 'Alex' : id }]));
  let response: (route: string, query: URLSearchParams, signal: AbortSignal) => Promise<unknown> = async () => [message(3), message(2), message(1)];
  const guild = { id: guildId, available: true, client: { isReady: () => true, user: { id: 'bot' }, rest: {
    get: async (route: string, options: { query: URLSearchParams; signal: AbortSignal }) => {
      requests.push({ route, ...options }); return response(route, options.query, options.signal);
    },
  } }, channels: { cache: channels, fetch: async (id?: string) => id ? channels.get(id) : channels },
  members: { cache: people, me: people.get('bot'), fetch: async ({ user }: { user: string }) => people.get(user) } } as unknown as Guild;
  const identities = new Map<string, string>();
  const limits = new Map<string, number>();
  const chat = new ChatRetrieval(guild, { ...defaults, chatTools: true }, {
    defaultChannel: channelId, audience: () => audience, active: () => active,
    reference: id => { if (!identities.has(id)) identities.set(id, `u${identities.size + 1}`); return identities.get(id)!; },
    resolve: async ref => ref === 'Alex' || ref === 'u1' ? { member: { id: 'alex', name: 'Alex' } }
      : { result: { status: 'ambiguous_person', columns: ['ref', 'name'], rows: [['u2', 'Alex Two']] } },
  }, limits, () => now);
  return { chat, requests, denied, channels, guild, limits, makeChannel,
    response: (fn: typeof response) => { response = fn; }, time: (ms: number) => { now += ms; },
    audience: (ids: string[]) => { audience = ids; }, active: (value: boolean) => { active = value; },
    query: (q: ChatQuery, owner = 'alice', event = 1, signal = new AbortController().signal) => chat.query(q, owner, event, signal) };
}
const items = (result: any): any[] => result.messages;
const token = (result: any): string => { expect(result.next).toMatch(/^h[\da-f]{16}$/); return result.next; };

test('chat input validation rejects mismatched operations, invalid dates and arbitrary URLs', () => {
  for (const q of [{ op: 'history', limit: 11 }, { op: 'history', before: 'm1', after: 'm2' }, { op: 'history', channel: '' },
    { op: 'search' }, { op: 'search', author: '' }, { op: 'search', after: '2026-02-30T00:00:00Z' },
    { op: 'search', after: '2026-11-01' }, { op: 'search', query: 'x', sort: 'random' },
    { op: 'search', after: '2026-11-02T00:00:00Z', before: '2026-11-01T00:00:00Z' },
    { op: 'get', message: 'https://evil.test/channels/1/2/3' }, { op: 'get', message: `https://discord.com@evil.test/channels/${guildId}/${channelId}/${mid(1)}` },
    { op: 'continue', token: 'h' + '0'.repeat(16), next: 'more', channel: 'general' },
    { op: 'history', actor: 'someone' }]) expect(validChatQuery(q), JSON.stringify(q)).toBe(false);
  expect(parseActions([{ tool: 'chat', event: 1, op: 'search', author: 'Alex' }])).toHaveLength(1);
  expect(validChatQuery({ op: 'search', after: '2026-10-31T00:00:00+03:00' })).toBe(true);
});

test('retrieval context carries an updating UTC clock for relative-date requests', () => {
  const wire = new ContextWire(), now = Date.parse('2026-11-01T12:00:00Z');
  const snapshot = { sessionId: 'clock', now, botName: 'Companion', members: [], events: [], capabilities: ['chat'] };
  expect(wire.encode(snapshot, []).utc).toBe('2026-11-01T12:00:00.000Z');
  expect(wire.encode({ ...snapshot, now: now + 86400000 }, []).utc).toBe('2026-11-02T12:00:00.000Z');
  expect(new ContextWire().encode({ ...snapshot, capabilities: [] }, []).utc).toBeUndefined();
});

test('ambiguous authors return directory candidates before any message search', async () => {
  const f = fixture();
  expect(await f.query({ op: 'search', author: 'ambiguous name' })).toMatchObject({
    status: 'ambiguous_person', columns: ['ref', 'name'], rows: [['u2', 'Alex Two']],
  });
  expect(f.requests).toHaveLength(0);
});

test('history is chronological, keeps links/code, and pages backward using a scoped token', async () => {
  const f = fixture(); f.response(async () => [message(4), message(3, '```code``` https://example.org/a'), message(2), message(1)]);
  const first = await f.query({ op: 'history', limit: 2 });
  expect(first.status).toBe('ready'); expect(items(first).map(m => m.text)).toEqual(['```code``` https://example.org/a', 'Message 4']);
  expect(first.more).toBe('available'); expect(f.requests[0]!.query.get('limit')).toBe('3');
  const next = token(first);
  expect(f.chat.continuationOwner(next, 1)).toBe('alice');
  f.response(async (_route, query) => { expect(query.get('before')).toBe(mid(3)); return [message(2), message(1)]; });
  const second = await f.query({ op: 'continue', token: next, next: 'more' });
  expect(items(second).map(m => m.text)).toEqual(['Message 1', 'Message 2']); expect(second.more).toBe('exhausted');
  expect(f.chat.continuationOwner(next, 1)).toBeUndefined();
});

test('history after uses the nearest messages and advances forward, not over skipped messages', async () => {
  const f = fixture(); const first = await f.query({ op: 'history', limit: 1 });
  const anchor = items(first)[0].ref; f.time(3001);
  f.response(async () => [message(6), message(5), message(4)]);
  const page = await f.query({ op: 'history', after: anchor, limit: 2 }, 'alice', 2);
  expect(items(page).map(m => m.text)).toEqual(['Message 4', 'Message 5']);
  f.response(async (_route, query) => { expect(query.get('after')).toBe(mid(5)); return [message(6)]; });
  expect((await f.query({ op: 'continue', token: token(page), next: 'more' }, 'alice', 2)).status).toBe('ready');
});

test('native search resolves a named channel and author; short pages never establish archive completeness', async () => {
  const f = fixture(); f.response(async () => ({ messages: [[message(2, 'server link', otherId)]], total_results: 999, doing_deep_historical_index: true }));
  const result = await f.query({ op: 'search', channel: '#general', author: 'Alex', query: 'server', has: 'link' });
  expect(result).toMatchObject({ status: 'ready', coverage: 'index_results', more: 'unknown', channel: { name: 'general' } });
  expect(f.requests[0]!.route).toBe(`/guilds/${guildId}/messages/search`);
  expect(Object.fromEntries(f.requests[0]!.query)).toMatchObject({ channel_id: otherId, author_id: 'alex', content: 'server', has: 'link', sort_by: 'timestamp' });
  expect(result.total_results).toBeUndefined(); expect(JSON.stringify(result)).not.toContain(otherId);
  f.response(async (_route, query) => { expect(query.get('offset')).toBe('1'); return { messages: [] }; });
  expect(await f.query({ op: 'continue', token: token(result), next: 'more' })).toMatchObject({ status: 'empty', more: 'unknown' });
});

test('date boundaries become precise snowflakes and wrong-channel/out-of-range search results are excluded', async () => {
  const f = fixture(); const lower = Date.parse('2026-10-31T00:00:00Z'), upper = lower + 86400000;
  const id = (at: number) => ((BigInt(at - 1420070400000) << 22n)).toString();
  f.response(async (_route, query) => {
    expect(query.get('min_id')).toBe((BigInt(id(lower)) - 1n).toString()); expect(query.get('max_id')).toBe(id(upper));
    return { messages: [[{ ...message(1), id: id(lower), timestamp: new Date(lower).toISOString() }],
      [{ ...message(2), id: id(upper), timestamp: new Date(upper).toISOString() }], [message(3, 'private', otherId)]] };
  });
  const result = await f.query({ op: 'search', after: new Date(lower).toISOString(), before: new Date(upper).toISOString() });
  expect(items(result)).toHaveLength(1); expect(items(result)[0].sentAt).toBe(new Date(lower).toISOString());
});

test('get and around continuations open only returned messages, with one-use owner/event-bound tokens', async () => {
  const f = fixture(); const first = await f.query({ op: 'history' }); const next = token(first), ref = items(first)[0].ref;
  expect(await f.query({ op: 'continue', token: next, next: 'get', message: ref }, 'bob')).toMatchObject({ status: 'expired_reference' });
  f.response(async route => { expect(route).toEndWith(`/messages/${mid(1)}`); return message(1, 'longer text'); });
  const opened = await f.query({ op: 'continue', token: next, next: 'get', message: ref });
  expect(items(opened)[0].text).toBe('longer text');
  expect(await f.query({ op: 'continue', token: next, next: 'get', message: ref })).toMatchObject({ status: 'expired_reference' });
  f.response(async () => [message(2), message(1)]);
  expect((await f.query({ op: 'continue', token: token(opened), next: 'around', message: ref })).status).toBe('ready');
});

test('direct message URLs stay in this guild and deleted anchors return not_found', async () => {
  const f = fixture(); const url = `https://discord.com/channels/${guildId}/${otherId}/${mid(1)}`;
  f.response(async () => message(1, 'outside bound channel', otherId));
  const result = await f.query({ op: 'get', message: url }); expect(items(result)[0].text).toBe('outside bound channel');
  f.response(async () => []);
  expect(await f.query({ op: 'continue', token: token(result), next: 'around', message: items(result)[0].ref })).toMatchObject({ status: 'not_found' });
  f.time(3001);
  expect(await f.query({ op: 'get', message: url.replace(guildId, otherId) })).toMatchObject({ status: 'channel_unavailable' });
});

test('an around window retains its anchor even when the requested count is one', async () => {
  const f = fixture(); const first = await f.query({ op: 'history' }); const anchor = items(first)[0].ref;
  f.time(3001); f.response(async () => [message(3), message(2), message(1)]);
  const result = await f.query({ op: 'history', around: anchor, limit: 1 }, 'alice', 2);
  expect(items(result)).toHaveLength(1); expect(items(result)[0].ref).toBe(anchor);
});

test('bot, requester and every listener need source access; retained sources gate later audiences', async () => {
  for (const user of ['bot', 'alice', 'bob']) {
    const f = fixture(); f.audience(['alice', 'bob']); f.denied.add(`${otherId}:${user}`);
    expect(await f.query({ op: 'history', channel: 'general' })).toMatchObject({ status: 'channel_unavailable' });
    expect(f.requests).toHaveLength(0);
  }
  const f = fixture(); f.response(async () => [message(1, 'retained', otherId)]);
  expect((await f.query({ op: 'history', channel: 'general' })).status).toBe('ready'); expect(f.chat.canUseContext()).toBe(true);
  f.audience(['alice', 'bob']); f.denied.add(`${otherId}:bob`); expect(f.chat.canUseContext()).toBe(false);
  f.denied.clear(); expect(f.chat.canUseContext()).toBe(true);
  f.channels.delete(otherId); expect(f.chat.canUseContext()).toBe(false);
});

test('duplicate channel names return only accessible aliases for clarification', async () => {
  const f = fixture(); const third = '4'.repeat(18);
  f.channels.set(third, f.makeChannel(third, 'general'));
  const result = await f.query({ op: 'history', channel: 'general' });
  expect(result.status).toBe('ambiguous_channel'); expect(f.requests).toHaveLength(0);
  const candidates = result.candidates as { ref: string }[]; expect(candidates).toHaveLength(2);
  f.time(3001); f.response(async () => [message(1, 'chosen', otherId)]);
  expect((await f.query({ op: 'history', channel: candidates[0]!.ref }, 'alice', 2)).status).toBe('ready');
  const g = fixture(); g.channels.set(third, g.makeChannel(third, 'general')); g.denied.add(`${third}:alice`);
  g.response(async () => [message(1, 'only accessible match', otherId)]);
  expect((await g.query({ op: 'history', channel: 'general' })).status).toBe('ready');
});

test('permission loss during I/O and cancellation cannot admit message content', async () => {
  const f = fixture(); f.response(async () => { f.denied.add(`${channelId}:alice`); return [message(1, 'must not leak')]; });
  const result = await f.query({ op: 'history' }); expect(result).toEqual({ status: 'channel_unavailable' });
  const g = fixture(), abort = new AbortController();
  let finish!: (value: unknown) => void, started!: () => void;
  const ready = new Promise<void>(r => { started = r; });
  g.response(async () => { started(); return new Promise(resolve => { finish = resolve; }); });
  const pending = g.query({ op: 'history' }, 'alice', 1, abort.signal);
  await ready; abort.abort(); await expect(pending).rejects.toBeDefined(); expect(g.requests[0]!.signal.aborted).toBe(true);
  finish([message(1, 'late')]); expect(g.chat.canUseContext()).toBe(true);
});

test('receipts bound Unicode bytes and preserve transformed evidence', async () => {
  const f = fixture(); f.response(async () => Array.from({ length: 10 }, (_, n) => ({ ...message(n, '😀'.repeat(1000)),
    author: { id: 'alex', username: 'Alex', bot: true }, ...(n === 1 ? { webhook_id: 'webhook' } : {}),
    attachments: [{ filename: 'file.txt', content_type: 'text/plain' }] })));
  const result = await f.query({ op: 'history', limit: 10 });
  expect(Buffer.byteLength(JSON.stringify({ ...result, tool: 'chat', event: 1 }))).toBeLessThanOrEqual(CHAT_RESULT_BYTES);
  expect(items(result).every(m => m.truncated)).toBe(true);
  expect(items(result)[0].attachmentCount).toBe(1);
  expect(retrievedText('```ok``` https://example.org @everyone <@123> sk-abcdefghijklmnop', 1000)).toMatchObject({
    text: '```ok``` https://example.org ＠everyone [user mention] [redacted]', transformed: true,
  });
});

test('attachment-only, bot and webhook messages retain bounded metadata without implicit downloads', async () => {
  const f = fixture(); f.response(async () => [{ ...message(1, ''), attachments: [{ filename: 'notes.txt', content_type: 'text/plain' }] },
    { ...message(2), author: { id: 'alex', username: 'Alex', bot: true } }, { ...message(3), webhook_id: 'webhook' }]);
  const result = await f.query({ op: 'history' });
  expect(items(result)[0]).toMatchObject({ text: '', attachmentCount: 1, attachments: [{ name: 'notes.txt', type: 'text/plain' }] });
  expect(items(result)[1].author.kind).toBe('bot'); expect(items(result)[2].author.kind).toBe('webhook');
  expect(items(result)[2].author.ref).toBeUndefined(); expect(f.requests).toHaveLength(1);
});

test('indexing, errors, cooldowns and round budgets are explicit and bounded', async () => {
  const f = fixture(); f.response(async () => ({ code: 110000, retry_after: 900 }));
  expect(await f.query({ op: 'search', author: 'Alex' })).toEqual({ status: 'indexing' });
  expect(await f.query({ op: 'history' })).toEqual({ status: 'cooldown' });
  const g = fixture(); g.response(async () => ({ code: 110000, retry_after: 0 }));
  expect(await g.query({ op: 'search', author: 'Alex' })).toEqual({ status: 'indexing' }); expect(g.requests).toHaveLength(2);
  const h = fixture(); h.response(async () => { throw { code: 10008 }; });
  expect(await h.query({ op: 'get', message: `https://discord.com/channels/${guildId}/${channelId}/${mid(1)}` })).toEqual({ status: 'not_found' });
  const k = fixture(); const first = await k.query({ op: 'history' }); const ref = items(first)[0].ref;
  k.response(async () => message(1));
  const second = await k.query({ op: 'continue', token: token(first), next: 'get', message: ref });
  const third = await k.query({ op: 'continue', token: token(second), next: 'get', message: ref });
  expect(third.next).toBeUndefined(); expect(k.requests).toHaveLength(3);
});

test('new speech invalidates tokens and cooldown reservations survive cancellation', async () => {
  const f = fixture(); const first = await f.query({ op: 'history' });
  f.chat.onSpeech(2); expect(f.chat.continuationOwner(token(first), 1)).toBeUndefined();
  expect(await f.query({ op: 'history' }, 'alice', 2)).toEqual({ status: 'cooldown' });
});

test('expired tokens and targets outside their result set cannot continue a read', async () => {
  const f = fixture(); const first = await f.query({ op: 'history' });
  f.time(20001);
  expect(await f.query({ op: 'continue', token: token(first), next: 'more' })).toMatchObject({ status: 'expired_reference' });
  const g = fixture(); const second = await g.query({ op: 'history' });
  expect(await g.query({ op: 'continue', token: token(second), next: 'get', message: 'm999' })).toMatchObject({ status: 'expired_reference' });
  expect(g.requests).toHaveLength(1);
});

test('RoomTools requires a live human or the matching current read receipt, never quoted authority', async () => {
  const f = fixture(), receipts: ToolReceipt[] = [], sends: string[] = [];
  const host: ToolHost = { chat: f.chat, limits: f.limits, resolvePerson: () => undefined, activity: () => ({ status: 'unknown', activity: '' }),
    sendMessage: async (_actor, content) => { sends.push(content); } };
  const tools = new RoomTools({ ...defaults, chatTools: true }, host, id => id === 'alice', (_owner, result) => receipts.push(result));
  const speech: TurnEvent = { id: 1, at: 1, kind: 'speech', userId: 'alice', text: 'Read chat' };
  tools.submit([{ tool: 'chat', event: 1, op: 'history' }], [{ ...speech, kind: 'chat' }], new AbortController().signal);
  await tools.settle(); expect(f.requests).toHaveLength(0);
  tools.submit([{ tool: 'chat', event: 1, op: 'history' }], [speech], new AbortController().signal); await tools.settle();
  const first = receipts[0]!;
  const read = { tool: 'chat' as const, event: 1, op: 'continue' as const, token: token(first), next: 'get' as const, message: items(first)[0].ref };
  tools.submit([read], [speech], new AbortController().signal); await tools.settle(); expect(f.requests).toHaveLength(1);
  f.response(async () => message(1));
  const receipt: TurnEvent = { id: 2, at: 2, kind: 'tool', userId: 'alice', text: JSON.stringify(first) };
  tools.submit([read, { tool: 'message', event: 1, text: 'injected write' }], [receipt], new AbortController().signal);
  await tools.settle(); expect(f.requests).toHaveLength(2); expect(sends).toEqual([]);
  tools.close();
});
