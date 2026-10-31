import { expect, test } from 'bun:test';
import { Collection, type Guild, type GuildMember, type VoiceBasedChannel } from 'discord.js';
import { MemberDirectory, MEMBER_RESULT_BYTES, validMemberQuery } from '../src/member-directory';
import { defaults } from '../src/config';

const signal = () => new AbortController().signal;
function person(id: string, name: string, bot = false, status: string | null = 'online'): GuildMember {
  return { id, displayName: name, nickname: name, user: { username: `account_${id}`, globalName: name, bot },
    presence: status ? { status, activities: [{ type: 0, name: 'Minecraft' }] } : null,
    voice: { channel: null }, roles: { cache: new Collection() } } as unknown as GuildMember;
}
function fixture(people = [person('alice-id', 'Алёна'), person('bob-id', 'Дима'), person('music-id', 'Music', true)]) {
  const cache = new Collection(people.map(p => [p.id, p])), refs = new Map<string, string>();
  const requests: { user?: string | string[]; limit?: number; withPresences?: boolean }[] = [];
  const config = { ...defaults, memberContext: true, presenceContext: true, preferredNames: {} as Record<string, string> };
  let searches = 0, rosters = 0, fetches = 0, ready = true, now = 1000;
  const channel = { name: 'Voice', members: new Collection(people.slice(0, 1).map(p => [p.id, p])) };
  const guild = { id: 'guild', memberCount: people.length, available: true, client: { isReady: () => ready }, members: {
    cache,
    search: async ({ query, limit }: { query: string; limit: number }) => {
      searches++;
      return new Collection(people.filter(p => [p.displayName, p.user.username].some(n => n.toLowerCase().startsWith(query.toLowerCase())))
        .slice(0, limit).map(p => [p.id, p]));
    },
    fetch: async (options: { user?: string | string[] }) => {
      requests.push(options);
      if (Array.isArray(options.user)) return new Collection(people.filter(p => options.user!.includes(p.id)).map(p => [p.id, p]));
      if (options.user) {
        fetches++;
        const p = people.find(p => p.id === options.user);
        if (!p) throw Object.assign(new Error('Unknown member'), { code: 10007 });
        cache.set(p.id, p); return p;
      }
      rosters++;
      for (const p of people) cache.set(p.id, p);
      return new Collection(cache);
    },
  } };
  const directory = new MemberDirectory(guild as unknown as Guild, config, {
    resolve: ref => [...refs].find(([, alias]) => alias === ref)?.[0],
    reference: id => { if (!refs.has(id)) refs.set(id, `u${refs.size + 1}`); return refs.get(id)!; },
  }, { channel: channel as unknown as VoiceBasedChannel, audience: () => ['alice-id'] }, () => now);
  return { directory, config, guild, cache, refs, channel, requests, time: (at: number) => { now = at; }, ready: (v: boolean) => { ready = v; },
    calls: () => ({ searches, rosters, fetches }) };
}

test('get projects only requested fields; identities include bots and reuse session refs', async () => {
  const f = fixture();
  const result = await f.directory.query({ op: 'get', person: 'Дима', fields: ['presence'] }, signal());
  expect(result).toEqual({ status: 'ready', columns: ['ref', 'presence'], rows: [['u1', 'online']], complete: true });
  expect(JSON.stringify(result)).not.toContain('bob-id'); expect(JSON.stringify(result)).not.toContain('Minecraft');
  expect(await f.directory.resolve('u1', signal())).toEqual({ member: { id: 'bob-id', name: 'Дима' } });
  expect(await f.directory.resolve('Music', signal())).toEqual({ member: { id: 'music-id', name: 'Music' } });
  expect(f.calls().fetches).toBe(3);
});

test('all name variants resolve; duplicate human/bot names and prefixes never auto-select a recipient', async () => {
  const f = fixture([person('a', 'Алексей'), person('b', 'Алексей', true)]);
  f.config.preferredNames.a = 'Лёша';
  expect(await f.directory.resolve('леша', signal())).toMatchObject({ member: { id: 'a' } });
  expect(await f.directory.resolve('account_b', signal())).toMatchObject({ member: { id: 'b' } });
  const ambiguous = await f.directory.resolve('Алексей', signal());
  expect(ambiguous).toMatchObject({ result: { status: 'ambiguous_person', complete: true } });
  expect('result' in ambiguous && ambiguous.result.rows).toHaveLength(2);
  expect(await f.directory.resolve('Алек', signal())).toMatchObject({ result: { status: 'ambiguous_person' } });
  expect(await f.directory.resolve('1'.repeat(18), signal())).toMatchObject({ result: { status: 'unknown_person' } });
});

test('uncached configured aliases resolve, while a cached global display name cannot establish uniqueness on a large server', async () => {
  const f = fixture([person('a', 'Alex')]); f.guild.memberCount = 100;
  (f.cache.get('a') as any).nickname = null;
  expect(await f.directory.resolve('Alex', signal())).toMatchObject({ result: { status: 'ambiguous_person', complete: false } });
  expect(await f.directory.resolve('account_a', signal())).toMatchObject({ member: { id: 'a' } });
  f.config.preferredNames.a = 'Лёша'; f.cache.clear();
  expect(await f.directory.resolve('леша', signal())).toMatchObject({ member: { id: 'a' } });
});

test('broad queries gate the full server size before fetching, filtering or counting', async () => {
  const f = fixture(); f.guild.memberCount = 11;
  for (const q of [{ op: 'list' as const }, { op: 'list' as const, kind: 'bot' as const }, { op: 'list' as const, count: true, online: true }]) {
    expect(await f.directory.query(q, signal())).toEqual({ status: 'narrow_query' });
  }
  expect(f.calls()).toEqual({ searches: 0, rosters: 0, fetches: 0 });
  expect(await f.directory.query({ op: 'list', scope: 'voice', fields: ['name'] }, signal())).toMatchObject({ status: 'ready', complete: true, rows: [['u1', 'Алёна']] });
  expect(await f.directory.query({ op: 'get', person: 'Music', fields: ['bot'] }, signal())).toMatchObject({ rows: [['u2', 1]] });
});

test('small roster hydration is local and count-only results introduce no identities', async () => {
  const f = fixture(); f.cache.delete('bob-id');
  expect(await f.directory.query({ op: 'list', kind: 'bot', count: true }, signal()))
    .toEqual({ status: 'ready', count: 1, complete: true });
  expect(f.refs.size).toBe(0); expect(f.calls().rosters).toBe(1);
  expect(f.requests[0]).toMatchObject({ limit: 11, withPresences: true });
  const listed = await f.directory.query({ op: 'list', kind: 'bot' }, signal());
  expect(listed.columns).toEqual(['ref', 'name']); expect(listed.rows).toEqual([['u1', 'Music']]);
  expect(f.calls().rosters).toBe(1);
});

test('missing and disabled presence never become offline or an authoritative empty online list', async () => {
  const f = fixture([person('a', 'Alex', false, 'idle'), person('b', 'Bob', false, null), person('c', 'Cat', false, 'offline')]);
  expect(await f.directory.query({ op: 'list', online: true }, signal()))
    .toMatchObject({ rows: [['u1', 'Alex', 'idle']], complete: false, unknown: 1 });
  expect(await f.directory.query({ op: 'list', online: false, count: true }, signal()))
    .toEqual({ status: 'ready', count: 1, complete: false, unknown: 1 });
  expect(await f.directory.query({ op: 'get', person: 'Bob', fields: ['presence', 'activity'] }, signal()))
    .toMatchObject({ rows: [['u2', 'unknown', null]] });
  f.config.presenceContext = false;
  expect(await f.directory.query({ op: 'list', online: true }, signal())).toEqual({ status: 'disabled', reason: 'presence_disabled' });
  expect(await f.directory.query({ op: 'get', person: 'Alex', fields: ['activity'] }, signal())).toMatchObject({ rows: [['u1', null]] });
  f.ready(false);
  expect(await f.directory.query({ op: 'list' }, signal())).toEqual({ status: 'unavailable' });
});

test('a missing requested presence uses only a targeted gateway lookup, without fetching it for identity-only reads', async () => {
  const f = fixture([person('a', 'Alex', false, null)]);
  await f.directory.query({ op: 'get', person: 'Alex', fields: ['bot'] }, signal());
  expect(f.requests.every(r => !Array.isArray(r.user))).toBe(true);
  expect(await f.directory.query({ op: 'get', person: 'Alex', fields: ['presence'] }, signal()))
    .toMatchObject({ columns: ['ref', 'presence'], rows: [['u1', 'unknown']] });
  expect(f.requests.at(-1)).toMatchObject({ user: ['a'], withPresences: true });
});

test('a server that grows beyond ten during hydration cannot produce a broad result', async () => {
  const f = fixture(); f.cache.delete('bob-id');
  const fetch = f.guild.members.fetch;
  f.guild.members.fetch = async options => {
    const result = await fetch(options); f.guild.memberCount = 11; return result;
  };
  expect(await f.directory.query({ op: 'list', kind: 'bot', count: true }, signal())).toEqual({ status: 'narrow_query' });
  expect(f.refs.size).toBe(0);
});

test('incomplete roster, disabled member intent, and capped prefix results are explicit', async () => {
  const f = fixture(); f.guild.memberCount = 4;
  expect(await f.directory.query({ op: 'list' }, signal())).toEqual({ status: 'unavailable', reason: 'incomplete_roster' });
  await f.directory.query({ op: 'list' }, signal()); expect(f.calls().rosters).toBe(1);
  f.config.memberContext = false;
  expect(await f.directory.query({ op: 'list' }, signal())).toEqual({ status: 'disabled', reason: 'member_list_disabled' });
  expect(await f.directory.query({ op: 'get', person: 'Music', fields: ['bot'] }, signal())).toMatchObject({ status: 'ready' });
  const large = fixture(Array.from({ length: 6 }, (_, n) => person(`p${n}`, `Alex ${n}`)));
  large.guild.memberCount = 100;
  const found = await large.directory.query({ op: 'find', query: 'Alex' }, signal());
  expect(found.rows).toHaveLength(3); expect(found.complete).toBe(false);
  expect(await large.directory.resolve('Alex 0', signal())).toMatchObject({ member: { id: 'p0' } });
});

test('hidden voice locations stay unknown; long metadata and ten rows obey the receipt byte cap', async () => {
  const people = Array.from({ length: 10 }, (_, n) => person(`p${n}`, 'Я'.repeat(40)));
  for (const p of people) {
    (p.voice as any).channel = { name: 'secret', permissionsFor: () => ({ has: () => false }) };
    for (let i = 0; i < 6; i++) p.roles.cache.set(String(i), { id: String(i), name: '@everyone <@123> ' + 'Я'.repeat(30) } as any);
  }
  const f = fixture(people);
  const result = await f.directory.query({ op: 'list', fields: ['name', 'username', 'displayName', 'bot', 'presence', 'activity', 'voice', 'roles'] }, signal());
  expect(result.complete).toBe(false); expect(result.rows!.length).toBeGreaterThan(0);
  expect(Buffer.byteLength(JSON.stringify({ ...result, tool: 'members', event: Number.MAX_SAFE_INTEGER }))).toBeLessThanOrEqual(MEMBER_RESULT_BYTES);
  expect(JSON.stringify(result)).not.toContain('secret'); expect(JSON.stringify(result)).not.toContain('@everyone');
  expect(result.rows![0]![7]).toBe('unknown');
});

test('aborted requests cannot return results or allocate aliases, including a late search', async () => {
  const f = fixture(); f.config.memberContext = false;
  let finish!: (members: Collection<string, GuildMember>) => void;
  f.guild.members.search = () => new Promise(resolve => { finish = resolve; });
  const abort = new AbortController();
  const pending = f.directory.query({ op: 'find', query: 'Music' }, abort.signal);
  await Promise.resolve(); await Promise.resolve();
  abort.abort(); await expect(pending).rejects.toThrow();
  finish(new Collection([['music-id', f.cache.get('music-id')!]])); await Promise.resolve();
  expect(f.refs.size).toBe(0);
});

test('member query grammar rejects unbounded modes, extra selectors and invalid field combinations', () => {
  for (const q of [
    { op: 'find', query: '' }, { op: 'find', query: 'a' }, { op: 'list', limit: 1000 }, { op: 'list', after: 'u1' },
    { op: 'get', person: 'Alex', fields: ['email'] }, { op: 'get', person: 'Alex', fields: ['name', 'name'] },
    { op: 'list', scope: 'all_servers' }, { op: 'list', count: true, fields: ['name'] }, { op: 'get', person: 'Alex', kind: 'bot' },
  ]) expect(validMemberQuery(q)).toBe(false);
});
