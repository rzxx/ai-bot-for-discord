import { test, expect } from 'bun:test';
import { defaults } from '../src/config';
import { RoomTools, parseActions, type ToolHost, type ToolReceipt, type ToolAction } from '../src/room-tools';
import type { TurnEvent } from '../src/llm';
import { safeText } from '../src/tool-safety';

const origin = (id = 1, userId = 'alice', text = 'Напиши Диме и напомни мне через минуту.'): TurnEvent => ({ id, userId, name: 'Алёна', kind: 'speech', at: 1000, text });
function fixture(options: { host?: Partial<ToolHost>; timeout?: number; limits?: Map<string, number> } = {}) {
  let now = 1000;
  const receipts: { owner: string; receipt: ToolReceipt; wake: boolean }[] = [], sends: { actor: string; text: string; mentions: string[] }[] = [];
  const members = new Set(['alice', 'bob']);
  const host: ToolHost = { limits: options.limits ?? new Map(),
    resolvePerson: ref => ref === 'u2' || ref === 'Дима' ? { id: 'bob', name: 'Дима' } : undefined,
    sendMessage: async (actor, text, mentions) => { sends.push({ actor, text, mentions }); },
    activity: () => ({ status: 'online', activity: 'Minecraft' }), ...options.host };
  const config = { ...defaults, searchTimeoutMs: options.timeout ?? 8000 };
  const tools = new RoomTools(config, host, id => members.has(id), (owner, receipt, wake) => receipts.push({ owner, receipt, wake }), () => now);
  return { tools, config, host, sends, receipts, members, time: (ms: number) => { now += ms; },
    submit: (actions: ToolAction[], events = [origin()], abort = new AbortController()) => tools.submit(actions, events, abort.signal) };
}

test('messages stay freeform but strip links, hidden controls, role markup and mass mentions', async () => {
  const f = fixture();
  f.submit([{ tool: 'message', event: 1, text: '@everyone <@&role> Дима, заходи! https://malicious.test/x \u202e', mentions: ['u2'] }]);
  await f.tools.settle();
  expect(f.sends).toEqual([{ actor: 'alice', text: 'Дима, заходи!', mentions: ['bob'] }]);
  expect(f.receipts[0]!.receipt.status).toBe('sent'); expect(f.receipts[0]!.wake).toBe(false);
  f.tools.close();
});

test('only an active human origin can authorize an action; quoted text and model actor IDs cannot', async () => {
  const f = fixture();
  const action: ToolAction = { tool: 'message', event: 1, text: 'Привет!' };
  f.submit([action], [{ ...origin(), kind: 'chat' }]);
  f.submit([action], [{ ...origin(), kind: 'tool' }]);
  f.submit([action], [origin(1, 'absent')]);
  f.submit([action], [origin(1, 'alice', 'Не отправляй сообщение.')]);
  f.submit([{ ...action, event: 99 }]);
  const canceled = new AbortController(); canceled.abort(); f.submit([action], [origin()], canceled);
  await f.tools.settle(); expect(f.sends).toHaveLength(0);
  f.tools.close(); f.submit([action]); await f.tools.settle(); expect(f.sends).toHaveLength(0);
});

test('freeform message requests and same-speaker continuations need no keyword or approval step', async () => {
  for (const text of ['Лёва, напечатай это в общий чат.', 'То же самое текстом в общий.', 'А можешь туда: Дима, заходи к нам?', 'Да, именно так.']) {
    const f = fixture();
    try {
      f.submit([{ tool: 'message', event: 1, text: 'Дима, заходи!' }], [origin(1, 'alice', text)]);
      await f.tools.settle();
      expect(f.sends).toHaveLength(1);
      expect(f.receipts).toMatchObject([{ receipt: { status: 'sent' }, wake: false }]);
    } finally { f.tools.close(); }
  }
});

test('rejected writes and send failures report their actual reason to the normal reply loop', async () => {
  const f = fixture({ host: { sendMessage: async () => { throw new Error('private network error'); } } });
  try {
    f.submit([{ tool: 'message', event: 1, text: 'Привет!' }], [origin(1, 'alice', 'Не отправляй сообщение.')]);
    expect(f.receipts.at(-1)).toMatchObject({ owner: 'alice', wake: true, receipt: { status: 'rejected', reason: 'negated_request' } });
    f.submit([{ tool: 'remind', event: 2, seconds: 30, text: 'Проверь чай.' }], [origin(2, 'alice', 'Привет.')]);
    expect(f.receipts.at(-1)).toMatchObject({ wake: true, receipt: { status: 'rejected', reason: 'missing_request' } });
    f.submit([{ tool: 'message', event: 3, text: 'Привет!' }], [origin(3)]);
    await f.tools.settle();
    expect(f.receipts.at(-1)).toMatchObject({ wake: true, receipt: { status: 'unavailable' } });
    expect(JSON.stringify(f.receipts)).not.toContain('private network');
  } finally { f.tools.close(); }
});

test('activity completion and presence status are separate fields even when someone is online', async () => {
  const f = fixture(); f.config.presenceContext = true;
  try {
    f.submit([{ tool: 'activity', event: 1, person: 'u2' }]);
    await f.tools.settle();
    expect(f.receipts.at(-1)).toMatchObject({ wake: true, receipt: { tool: 'activity', event: 1,
      status: 'ready', presenceStatus: 'online', presenceAvailable: true, activity: 'Minecraft' } });
  } finally { f.tools.close(); }
  const unavailable = fixture({ host: { activity: () => ({ status: 'unknown', activity: '', presenceAvailable: false }) } });
  unavailable.config.presenceContext = true;
  try {
    unavailable.submit([{ tool: 'activity', event: 1, person: 'u2' }]); await unavailable.tools.settle();
    expect(unavailable.receipts.at(-1)!.receipt).toMatchObject({ status: 'ready', presenceStatus: 'unknown', presenceAvailable: false, activity: '' });
  } finally { unavailable.tools.close(); }
});

test('deduplication and sender, recipient and global limits survive session replacement', async () => {
  const limits = new Map<string, number>(), f = fixture({ limits });
  const action: ToolAction = { tool: 'message', event: 1, text: 'Привет!', mentions: ['u2'] };
  f.submit([action, action]); await f.tools.settle(); expect(f.sends).toHaveLength(1);
  f.time(11000); f.submit([{ ...action, event: 2, mentions: [] }], [origin(2)]); await f.tools.settle(); expect(f.sends).toHaveLength(1);
  f.time(180000); f.submit([{ ...action, event: 3 }], [origin(3)]); await f.tools.settle(); expect(f.receipts.at(-1)!.receipt.status).toBe('mention_cooldown');
  f.tools.close();
  const replacement = fixture({ limits }); replacement.submit([{ ...action, mentions: [] }]); await replacement.tools.settle();
  expect(replacement.sends).toHaveLength(0); replacement.tools.close();
});

test('an ambiguous send failure consumes the budget and is never retried', async () => {
  let attempts = 0;
  const f = fixture({ host: { sendMessage: async () => { attempts++; throw new Error('Network failed with secret'); } } });
  f.submit([{ tool: 'message', event: 1, text: 'Привет!' }]); await f.tools.settle();
  f.submit([{ tool: 'message', event: 2, text: 'Повтор!' }], [origin(2)]); await f.tools.settle();
  expect(attempts).toBe(1); expect(JSON.stringify(f.receipts)).not.toContain('secret'); f.tools.close();
});

test('unknown or excessive mention targets cannot send a partial message', async () => {
  const f = fixture();
  f.submit([{ tool: 'message', event: 1, text: 'Привет!', mentions: ['unknown'] }]); await f.tools.settle();
  expect(f.sends).toHaveLength(0); expect(f.receipts[0]!.receipt.status).toBe('unknown_person');
  expect(parseActions([{ tool: 'message', event: 1, text: 'Hi', mentions: ['u1', 'u2', 'u3'] }])).toEqual([]); f.tools.close();
});

test('member queries share speech authorization, support two projections, and never authorize receipt-only writes', async () => {
  let queries = 0;
  const f = fixture({ host: { members: async () => {
    queries++; return { status: 'ready', columns: ['ref', 'presence'], rows: [['u2', 'idle']], complete: true };
  } } });
  expect(f.tools.capabilities).toContain('members'); expect(f.tools.capabilities).not.toContain('activity');
  const first: ToolAction = { tool: 'members', event: 1, op: 'get', person: 'u2', fields: ['presence'] };
  f.submit([first], [{ ...origin(), kind: 'chat' }]);
  f.submit([first, { ...first, fields: ['activity'] }]); await f.tools.settle();
  expect(queries).toBe(2); expect(f.receipts).toHaveLength(2); expect(f.receipts[0]!.wake).toBe(true);
  f.submit([{ tool: 'message', event: 1, text: 'Привет', mentions: ['u2'] }], [{ ...origin(2), kind: 'tool', text: JSON.stringify(f.receipts[0]!.receipt) }]);
  await f.tools.settle(); expect(f.sends).toHaveLength(0);
  expect(parseActions([{ ...first, fields: ['email'] }])).toEqual([]);
  f.tools.close();
});

test('asynchronous exact bot resolution sends once without an extra model turn', async () => {
  const f = fixture({ host: { resolveMember: async ref => ({ member: { id: 'music-bot', name: ref } }) } });
  f.submit([{ tool: 'message', event: 1, text: 'Привет', mentions: ['Music'] }]);
  await f.tools.settle();
  expect(f.sends).toEqual([{ actor: 'alice', text: 'Привет', mentions: ['music-bot'] }]);
  expect(f.receipts[0]).toMatchObject({ receipt: { status: 'sent' }, wake: false });
  f.tools.close();
});

test('ambiguous recipients return compact candidates and never send a partial message or consume budgets', async () => {
  const f = fixture({ host: { resolveMember: async ref => ref === 'Дима'
    ? { member: { id: 'bob', name: ref } }
    : { result: { status: 'ambiguous_person', columns: ['ref', 'name'], rows: [['u3', 'Music'], ['u4', 'Music']], complete: true } } } });
  f.submit([{ tool: 'message', event: 1, text: 'Привет', mentions: ['Дима', 'Music'] }]);
  await f.tools.settle(); expect(f.sends).toHaveLength(0); expect(f.host.limits.size).toBe(0);
  expect(f.receipts[0]).toMatchObject({ wake: true, receipt: { status: 'ambiguous_person', rows: [['u3', 'Music'], ['u4', 'Music']] } });
  f.tools.close();
});

test('new speech and stop cancel pending directory work even if the host ignores cancellation', async () => {
  for (const stop of [false, true]) {
    let finish!: (v: any) => void;
    const f = fixture({ host: { members: () => new Promise(resolve => { finish = resolve; }) } });
    f.submit([{ tool: 'members', event: 1, op: 'list' }]);
    if (stop) f.tools.cancelBackground(); else f.tools.onSpeech(2);
    await f.tools.settle();
    finish({ status: 'ready', rows: [['u2', 'old data']] }); await Promise.resolve();
    expect(f.receipts).toHaveLength(0); f.tools.close();
  }
  let finish!: (v: any) => void;
  const f = fixture({ host: { resolveMember: () => new Promise(resolve => { finish = resolve; }) } });
  f.submit([{ tool: 'message', event: 1, text: 'Привет', mentions: ['Music'] }]);
  f.tools.onSpeech(2); await f.tools.settle(); finish({ member: { id: 'music-bot', name: 'Music' } }); await Promise.resolve();
  expect(f.sends).toHaveLength(0); expect(f.host.limits.size).toBe(0); f.tools.close();
});

test('concurrent resolutions recheck send budgets after I/O and absent requesters cannot send', async () => {
  const f = fixture({ host: { resolveMember: async () => ({ member: { id: 'music-bot', name: 'Music' } }) } });
  f.submit([{ tool: 'message', event: 1, text: 'Первое', mentions: ['Music'] }]);
  f.submit([{ tool: 'message', event: 2, text: 'Второе', mentions: ['Music'] }], [origin(2, 'bob')]);
  await f.tools.settle(); expect(f.sends).toHaveLength(1);
  expect(f.receipts.some(r => ['cooldown', 'mention_cooldown'].includes(r.receipt.status))).toBe(true); f.tools.close();
  const left = fixture({ host: { resolveMember: async () => {
    left.members.delete('alice'); return { member: { id: 'music-bot', name: 'Music' } };
  } } });
  left.submit([{ tool: 'message', event: 1, text: 'Привет', mentions: ['Music'] }]);
  await left.tools.settle(); expect(left.sends).toHaveLength(0); left.tools.close();
});

test('reminders are owner-scoped, bounded, one-shot, and disappear on session close', async () => {
  const f = fixture();
  f.submit([{ tool: 'remind', event: 1, seconds: 30, text: 'Алёна, пора проверить духовку!' }]); await f.tools.settle();
  expect(f.receipts.at(-1)!.receipt.status).toBe('scheduled');
  f.submit([{ tool: 'cancel_reminder', event: 2, id: 'r1' }], [origin(2, 'bob', 'Отмени напоминание')]); await f.tools.settle();
  expect(f.receipts.at(-1)!.receipt.status).toBe('not_owned');
  f.time(29999); f.tools.tick(); expect(f.receipts.some(r => r.receipt.status === 'due')).toBe(false);
  f.time(1); f.tools.tick(); f.tools.tick();
  expect(f.receipts.filter(r => r.receipt.status === 'due')).toHaveLength(1);
  expect(f.receipts.at(-1)).toMatchObject({ owner: 'alice', wake: true, receipt: { text: 'Алёна, пора проверить духовку!' } });
  f.submit([{ tool: 'remind', event: 3, seconds: 5, text: 'Ещё одно' }], [origin(3)]); await f.tools.settle();
  f.tools.close(); f.time(6000); f.tools.tick(); expect(f.receipts.filter(r => r.receipt.status === 'due')).toHaveLength(1);
  const fresh = fixture(); fresh.submit([{ tool: 'reminders', event: 1 }]); await fresh.tools.settle();
  expect(fresh.receipts[0]!.receipt.items).toEqual([]); fresh.tools.close();
});

test('missed reminders and absent owners do not produce a burst of stale speech', async () => {
  const f = fixture(); f.submit([{ tool: 'remind', event: 1, seconds: 5, text: 'Перерыв' }]); await f.tools.settle();
  f.time(70000); f.tools.tick(); expect(f.receipts.at(-1)).toMatchObject({ wake: false, receipt: { status: 'expired' } });
  f.submit([{ tool: 'remind', event: 2, seconds: 5, text: 'Перерыв' }], [origin(2)]); await f.tools.settle();
  f.members.delete('alice'); f.time(5000); f.tools.tick(); expect(f.receipts.at(-1)!.wake).toBe(false); f.tools.close();
});

test('new speech cancels a search and ignores a provider that returns after cancellation', async () => {
  let finish!: (value: any[]) => void, signal!: AbortSignal;
  const f = fixture({ host: { search: (_query, s) => { signal = s; return new Promise(resolve => { finish = resolve; }); } } });
  f.submit([{ tool: 'search', event: 1, query: 'Minecraft latest release' }]);
  expect(signal.aborted).toBe(false); f.tools.onSpeech(2); expect(signal.aborted).toBe(true);
  await f.tools.settle(); finish([{ title: 'Late', snippet: 'Old topic', url: 'https://example.org/' }]); await Promise.resolve();
  expect(f.receipts.at(-1)!.receipt.status).toBe('canceled');
  expect(f.receipts.some(r => r.wake)).toBe(false); expect(f.receipts.some(r => r.receipt.status === 'ready')).toBe(false); f.tools.close();
});

test('search has a hard deadline even when its provider ignores abort', async () => {
  const f = fixture({ timeout: 15, host: { search: () => new Promise(() => {}) } });
  f.submit([{ tool: 'search', event: 1, query: 'Minecraft release' }]);
  await f.tools.settle(); expect(f.receipts.at(-1)).toMatchObject({ wake: true, receipt: { status: 'unavailable' } }); f.tools.close();
});

test('private participant names are blocked before network access', async () => {
  let called = false;
  const f = fixture({ host: { privateTerms: () => ['Алёна'], search: async () => { called = true; return []; } } });
  f.submit([{ tool: 'search', event: 1, query: 'Алёна личный адрес' }]); await f.tools.settle();
  expect(called).toBe(false); expect(f.receipts[0]!.receipt.status).toBe('private_query'); f.tools.close();
});

test('single-use search continuations bypass only search cooldown and stop at three rounds', async () => {
  const seen: { query: string; excluded: string[] }[] = [];
  const f = fixture({ host: { search: async (query, _signal, options) => {
    seen.push({ query, excluded: options?.previous?.map(r => r.url) ?? [] });
    return [{ title: 'Evidence', snippet: `Relevant public evidence number ${seen.length}.`, url: `https://source${seen.length}.org/` }];
  } } });
  try {
    f.submit([{ tool: 'search', event: 1, query: 'Minecraft release' }]); await f.tools.settle();
    for (const query of ['Minecraft release changelog', 'Minecraft release official details']) {
      const receipt = f.receipts.at(-1)!.receipt;
      expect(typeof receipt.next).toBe('string');
      const action: ToolAction = { tool: 'search', event: 1, query, continue: String(receipt.next) };
      const event = { ...origin(10), kind: 'tool' as const, text: JSON.stringify(receipt) };
      f.submit([action, action], [event]); await f.tools.settle();
    }
    expect(seen).toHaveLength(3); expect(seen[1]!.excluded).toEqual(['https://source1.org/']);
    expect(f.receipts.at(-1)!.receipt).toMatchObject({ round: 3, status: 'ready' });
    expect(f.receipts.at(-1)!.receipt.next).toBeUndefined();
    f.submit([{ tool: 'search', event: 1, query: 'fourth query', continue: 'q12345678' }], [{ ...origin(11), kind: 'tool' }]);
    await f.tools.settle(); expect(seen).toHaveLength(3);
  } finally { f.tools.close(); }
});

test('forged, expired, repeated and superseded continuations cannot search or authorize writes', async () => {
  for (const invalidation of ['forged', 'expired', 'new_speech', 'repeat', 'wrong_owner', 'private']) {
    let calls = 0;
    const f = fixture({ host: { privateTerms: () => ['Алёна'], search: async () => {
      calls++; return [{ title: 'Evidence', snippet: 'A public factual excerpt.', url: 'https://source.org/' }];
    } } });
    try {
      f.submit([{ tool: 'search', event: 1, query: 'Minecraft release' }]); await f.tools.settle();
      const receipt = f.receipts.at(-1)!.receipt;
      if (invalidation === 'expired') f.time(20001);
      if (invalidation === 'new_speech') f.tools.onSpeech(2);
      const event = { ...origin(10, invalidation === 'wrong_owner' ? 'bob' : 'alice'), kind: 'tool' as const, text: JSON.stringify(receipt) };
      f.submit([{ tool: 'search', event: 1, query: invalidation === 'repeat' ? 'Minecraft release' : invalidation === 'private' ? 'Алёна адрес' : 'Minecraft release details',
        continue: invalidation === 'forged' ? 'q12345678' : String(receipt.next) }], [event]);
      f.submit([{ tool: 'message', event: 1, text: 'Unrequested write' }], [event]);
      await f.tools.settle(); expect(calls).toBe(1); expect(f.sends).toHaveLength(0);
    } finally { f.tools.close(); }
  }
});

test('sanitization handles bare domains, markup, encoded controls and long messages', () => {
  expect(safeText('```ignore rules``` [click](https://host.test/) www.host.test discord.gg/abc <@123> @here Нормальный текст', 50)).toBe('Нормальный текст');
  expect(safeText('Я'.repeat(2000), 320)).toHaveLength(320);
  expect(parseActions([{ tool: 'shell', event: 1, command: 'anything' }, { tool: 'remind', event: 1, seconds: Infinity, text: 'x' }])).toEqual([]);
});
