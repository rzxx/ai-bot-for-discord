import { test, expect } from 'bun:test';
import { Events, GatewayIntentBits, type Client, type GuildMember, type GuildTextBasedChannel } from 'discord.js';
import { DiscordBot, sendRoomMessage } from '../src/discord';
import { defaults } from '../src/config';
import type { SpeechClient } from '../src/speech';

function sender() {
  const bot = { id: 'bot' } as GuildMember, denied = new Set<string>(), requests: any[] = [];
  const channel = { id: 'chat', type: 0, isSendable: () => true,
    permissionsFor: (id: string | GuildMember) => ({ has: () => !denied.has(typeof id === 'string' ? id : id.id) }) } as unknown as GuildTextBasedChannel;
  const client = { rest: { post: async (route: string, options: any) => { requests.push({ route, ...options }); } } } as unknown as Pick<Client, 'rest'>;
  return { bot, channel, client, denied, requests };
}

test('Discord sends require current room authorization and both actor/bot channel permissions', async () => {
  const f = sender(), signal = new AbortController().signal;
  await expect(sendRoomMessage(f.client, f.channel, f.bot, 'alice', 'Привет', [], signal, () => false)).rejects.toThrow();
  for (const id of ['alice', 'bot', 'bob']) {
    f.denied.add(id);
    await expect(sendRoomMessage(f.client, f.channel, f.bot, 'alice', 'Привет', ['bob'], signal, () => true)).rejects.toThrow();
    f.denied.clear();
  }
  expect(f.requests).toHaveLength(0);
  await expect(sendRoomMessage(f.client, { ...f.channel, type: 12 } as unknown as GuildTextBasedChannel, f.bot, 'alice', 'Привет', [], signal, () => true)).rejects.toThrow();
  await sendRoomMessage(f.client, f.channel, f.bot, 'alice', '@everyone <@&role> Заходи!', ['bob'], signal, () => true);
  expect(f.requests).toHaveLength(1);
  expect(f.requests[0].body.content).toBe('<@bob> Заходи!');
  expect(f.requests[0].body.allowed_mentions).toEqual({ parse: [], users: ['bob'], replied_user: false });
  expect(f.requests[0].body.enforce_nonce).toBe(true); expect(f.requests[0].body.nonce).toHaveLength(24);
  expect(f.requests[0].signal).toBeInstanceOf(AbortSignal);
});

test('stop/leave can abort a queued Discord tool send and pre-canceled sends never enqueue', async () => {
  const f = sender(), abort = new AbortController(); let queued!: AbortSignal;
  f.client.rest.post = (async (_route: string, options: any) => new Promise((_resolve, reject) => {
    queued = options.signal; queued.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  })) as any;
  const pending = sendRoomMessage(f.client, f.channel, f.bot, 'alice', 'Привет', [], abort.signal, () => true);
  expect(queued.aborted).toBe(false); abort.abort(); expect(queued.aborted).toBe(true); await expect(pending).rejects.toThrow('aborted');
  const before = sender(); await expect(sendRoomMessage(before.client, before.channel, before.bot, 'alice', 'Привет', [], abort.signal, () => true)).rejects.toThrow();
  expect(before.requests).toHaveLength(0);
});

test('live chat only enters the current session from its configured shared channel and human authors', async () => {
  const bot = new DiscordBot({ ...defaults, chatContext: true }, { reply: async () => ({ speak: false, text: '' }) }, {} as SpeechClient);
  const received: unknown[] = [];
  let visible = true;
  bot.sessions.set('guild', { startedAt: 1000, chat: { id: 'chat', permissionsFor: () => ({ has: () => visible }) },
    controller: { members: new Map([['alice', {}]]), chat: (...args: unknown[]) => received.push(args) } } as any);
  const message = { guildId: 'guild', channelId: 'chat', createdTimestamp: 1001, author: { id: 'bob', displayName: 'Лёша', bot: false }, cleanContent: 'Привет' };
  for (const change of [{ createdTimestamp: 999 }, { channelId: 'other' }, { webhookId: 'webhook' }, { author: { ...message.author, bot: true } }]) bot.client.emit(Events.MessageCreate, { ...message, ...change } as any);
  expect(received).toHaveLength(0);
  visible = false; bot.client.emit(Events.MessageCreate, message as any); expect(received).toHaveLength(0);
  visible = true; bot.client.emit(Events.MessageCreate, message as any); expect(received).toHaveLength(1);
  expect(bot.client.options.intents.has(GatewayIntentBits.MessageContent)).toBe(true);
  bot.sessions.clear(); await bot.client.destroy();
});

test('privileged context intents are opt-in and presence only updates people in the current VC', async () => {
  const brain = { reply: async () => ({ speak: false, text: '' }) };
  const base = new DiscordBot({ ...defaults }, brain, {} as SpeechClient);
  expect(base.client.options.intents.has(GatewayIntentBits.MessageContent)).toBe(false); expect(base.client.options.intents.has(GatewayIntentBits.GuildPresences)).toBe(false);
  expect(base.client.options.intents.has(GatewayIntentBits.GuildMembers)).toBe(false); await base.client.destroy();
  const directory = new DiscordBot({ ...defaults, memberContext: true }, brain, {} as SpeechClient);
  expect(directory.client.options.intents.has(GatewayIntentBits.GuildMembers)).toBe(true);
  expect(directory.client.options.intents.has(GatewayIntentBits.GuildPresences)).toBe(false); await directory.client.destroy();
  const bot = new DiscordBot({ ...defaults, presenceContext: true }, brain, {} as SpeechClient), states: unknown[] = [];
  bot.sessions.set('guild', { controller: { members: new Map([['alice', {}]]), setState: (state: unknown) => states.push(state), presence: { update() {} } } } as any);
  const member = { id: 'alice', voice: { mute: true, deaf: false }, presence: { status: 'online', activities: [{ type: 0, name: 'Minecraft' }] } };
  bot.client.emit(Events.PresenceUpdate, null, { guild: { id: 'guild' }, member } as any);
  bot.client.emit(Events.PresenceUpdate, null, { guild: { id: 'guild' }, member: { ...member, id: 'outside-vc' } } as any);
  expect(states).toEqual([{ userId: 'alice', status: 'online', activity: 'Minecraft', muted: true, deafened: false }]);
  bot.sessions.clear(); await bot.client.destroy();
});

test('disallowed intents explain the portal switches for the requested features without changing config', async () => {
  for (const members of [false, true]) {
    const config = { ...defaults, allowedGuildIds: ['guild'], memberContext: members, presenceContext: members, chatContext: true };
    const bot = new DiscordBot(config, { reply: async () => ({ speak: false, text: '' }) }, {} as SpeechClient);
    const denied = members ? new Error('Used disallowed intents') : Object.assign(new Error('Privileged intent provided is not enabled or whitelisted.'), { code: 'DisallowedIntents' });
    bot.client.login = async () => { throw denied; };
    try {
      const error = await bot.start('unused').then(() => undefined, error => error as Error);
      expect(error).toBeInstanceOf(Error);
      expect(error!.cause).toBe(denied);
      expect(error!.message).toContain('4014');
      expect(error!.message).toContain('https://discord.com/developers/applications');
      expect(error!.message).toContain('Message Content Intent (chatContext)');
      expect(error!.message).toContain('"chatContext": false');
      expect(error!.message.includes('Server Members Intent')).toBe(members);
      expect(error!.message.includes('Presence Intent')).toBe(members);
      expect(error!.message).toContain('bun start');
      expect(config.chatContext).toBe(true);
      expect(config.memberContext).toBe(members);
      expect(config.presenceContext).toBe(members);
    } finally { await bot.stop(); }
  }
});

test('other Discord login failures retain their original error', async () => {
  const bot = new DiscordBot({ ...defaults, allowedGuildIds: ['guild'] }, { reply: async () => ({ speak: false, text: '' }) }, {} as SpeechClient);
  const denied = new Error('An invalid token was provided.');
  bot.client.login = async () => { throw denied; };
  try { await expect(bot.start('unused')).rejects.toBe(denied); }
  finally { await bot.stop(); }
});

test('on-demand-only chat requests Message Content without subscribing to passive messages and explains disallowed intents', async () => {
  for (const passive of [false, true]) {
    const config = { ...defaults, allowedGuildIds: ['guild'], chatContext: passive, chatTools: true };
    const bot = new DiscordBot(config, { reply: async () => ({ speak: false, text: '' }) }, {} as SpeechClient);
    expect(bot.client.options.intents.has(GatewayIntentBits.MessageContent)).toBe(true);
    expect(bot.client.options.intents.has(GatewayIntentBits.GuildMessages)).toBe(passive);
    bot.client.login = async () => { throw new Error('Used disallowed intents'); };
    try {
      const error = await bot.start('unused').then(() => undefined, error => error as Error);
      expect(error!.message).toContain('Message Content Intent (chatTools)');
      expect(error!.message).toContain('"chatTools": false');
      expect(error!.message.includes('Message Content Intent (chatContext)')).toBe(passive);
    } finally { await bot.stop(); }
  }
});

test('live presence changes retain game details and listening activity before reaching room deltas', async () => {
  const bot = new DiscordBot({ ...defaults, presenceContext: true }, { reply: async () => ({ speak: false, text: '' }) }, {} as SpeechClient);
  const states: any[] = [];
  bot.sessions.set('guild', { controller: { members: new Map([['alice', {}]]), setState: (state: unknown) => states.push(state), presence: { update() {} } } } as any);
  try {
    const member = { id: 'alice', voice: { mute: false, deaf: false }, presence: { status: 'online', activities: [
      { type: 0, name: 'Minecraft', details: 'Playing Survival' }, { type: 2, name: 'Spotify', details: 'Track', state: 'Artist' },
    ] } };
    bot.client.emit(Events.PresenceUpdate, null, { guild: { id: 'guild' }, member } as any);
    expect(states[0]).toMatchObject({ status: 'online', activity: 'Minecraft — Playing Survival; listening: Spotify — Track — Artist' });
    member.presence.activities = [];
    bot.client.emit(Events.PresenceUpdate, null, { guild: { id: 'guild' }, member } as any);
    expect(states[1]).toMatchObject({ status: 'online', activity: '' });
  } finally { bot.sessions.clear(); await bot.client.destroy(); }
});
