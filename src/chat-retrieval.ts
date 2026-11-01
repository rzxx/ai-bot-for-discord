import { ChannelType, PermissionFlagsBits, Routes, type APIMessage, type Guild, type GuildTextBasedChannel } from 'discord.js';
import type { Config } from './config';
import type { MemberResolution } from './member-directory';
import { safeName } from './tool-safety';
import { withAbort } from './abort';

export type ChatQuery =
  | { op: 'history'; channel?: string; limit?: number; before?: string; after?: string; around?: string }
  | { op: 'search'; channel?: string; query?: string; author?: string; after?: string; before?: string;
      has?: 'link' | 'file' | 'image'; sort?: 'newest' | 'relevance'; limit?: number }
  | { op: 'get'; message: string }
  | { op: 'continue'; token: string; next: 'more' | 'get' | 'around'; message?: string };
export interface ChatResult { status: string; [key: string]: unknown }
export interface ChatAccess {
  query(query: ChatQuery, owner: string, event: number, signal: AbortSignal): Promise<ChatResult>;
  continuationOwner(token: string, event: number): string | undefined;
  onSpeech(event: number): void;
  cancel(): void;
  canUseContext(): boolean;
}
const messageRef = (s: unknown): s is string => typeof s === 'string' && /^m[1-9]\d{0,8}$/.test(s);
const text = (s: unknown, max: number): s is string => typeof s === 'string' && !!s.trim() && s.length <= max;
const epoch = 1420070400000;
const timestamp = (s: unknown): s is string => {
  if (typeof s !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(s)) return false;
  const [year, month, day] = s.slice(0, 10).split('-').map(Number) as [number, number, number];
  return month >= 1 && month <= 12 && day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate()
    && Number(s.slice(11, 13)) < 24 && Number(s.slice(14, 16)) < 60 && Number(s.slice(17, 19)) < 60
    && Number.isFinite(Date.parse(s)) && Date.parse(s) >= epoch && Date.parse(s) <= Number(((1n << 64n) - 1n) >> 22n) + epoch;
};
function messageLink(value: string): { guild: string; channel: string; id: string } | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !['discord.com', 'canary.discord.com', 'ptb.discord.com', 'discordapp.com'].includes(url.hostname)
      || url.username || url.password || url.port || url.search || url.hash) return;
    const match = /^\/channels\/(\d{15,22})\/(\d{15,22})\/(\d{15,22})\/?$/.exec(url.pathname);
    if (match) return { guild: match[1]!, channel: match[2]!, id: match[3]! };
  } catch { /* Not a Discord message URL. */ }
}
export function validChatQuery(value: unknown): value is ChatQuery {
  if (!value || typeof value !== 'object') return false;
  const q = value as Record<string, unknown>;
  const fields = q.op === 'history' ? ['channel', 'limit', 'before', 'after', 'around']
    : q.op === 'search' ? ['channel', 'query', 'author', 'after', 'before', 'has', 'sort', 'limit']
    : q.op === 'get' ? ['message'] : q.op === 'continue' ? ['token', 'next', 'message'] : undefined;
  if (!fields || Object.keys(q).some(k => !['tool', 'event', 'op', ...fields].includes(k))) return false;
  if (q.channel !== undefined && !text(q.channel, 100) || q.limit !== undefined && (!Number.isInteger(q.limit) || Number(q.limit) < 1 || Number(q.limit) > 10)) return false;
  if (q.op === 'history') return ['before', 'after', 'around'].filter(k => q[k] !== undefined).length <= 1
    && ['before', 'after', 'around'].every(k => q[k] === undefined || messageRef(q[k]));
  if (q.op === 'get') return text(q.message, 200) && (messageRef(q.message) || !!messageLink(q.message));
  if (q.op === 'continue') return typeof q.token === 'string' && /^h[\da-f]{16}$/.test(q.token)
    && (q.next === 'more' && q.message === undefined || ['get', 'around'].includes(String(q.next)) && messageRef(q.message));
  return (q.query === undefined || text(q.query, 180)) && (q.author === undefined || text(q.author, 40))
    && (q.after === undefined || timestamp(q.after)) && (q.before === undefined || timestamp(q.before))
    && !(q.after && q.before && Date.parse(String(q.after)) >= Date.parse(String(q.before)))
    && (q.has === undefined || ['link', 'file', 'image'].includes(String(q.has)))
    && (q.sort === undefined || q.sort === 'newest' || q.sort === 'relevance' && q.query !== undefined)
    && ['query', 'author', 'after', 'before', 'has'].some(k => q[k] !== undefined);
}

export const CHAT_RESULT_BYTES = 8192;
export function retrievedText(value: string, limit: number) {
  const clean = value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, '')
    .replace(/<@!?\d+>/g, '[user mention]').replace(/<@&\d+>/g, '[role mention]').replace(/<#\d+>/g, '[channel mention]')
    .replace(/@/g, '＠').replace(/(?:sk-[a-zA-Z0-9_-]{12,}|eyJ[a-zA-Z0-9_.-]{30,})/g, '[redacted]');
  const chars = Array.from(clean);
  return { text: chars.slice(0, limit).join(''), truncated: chars.length > limit, ...(clean !== value ? { transformed: true } : {}) };
}
type Channel = GuildTextBasedChannel;
interface Source { channel: string; id: string }
interface RecordMessage { ref: string; author: { ref?: string; name: string; kind: string }; sentAt: string; editedAt: string | null;
  text: string; truncated: boolean; transformed?: boolean; attachments?: { name: string; type: string }[]; attachmentCount?: number; replyTo?: string }
type Resolved = { op: 'history' | 'search' | 'get'; channel: string; limit: number; params: Record<string, string>; message?: string; after?: number; before?: number };
interface Chain { owner: string; event: number; expires: number; rounds: number; calls: number; ioMs: number; channel: string;
  token?: string; page?: Resolved; allowed: Set<string>; seen: Set<string> }
class ChatError extends Error { constructor(readonly status: string, readonly data: Record<string, unknown> = {}) { super(status); } }

/** Fetches on demand. Only bounded receipts leave this adapter; SDK objects and
 * source IDs stay here. The retained-source gate lasts as long as model memory. */
export class ChatRetrieval implements ChatAccess {
  private sources = new Set<string>();
  private messages = new Map<string, Source>();
  private channelRefs = new Map<string, string>();
  private sequence = 0;
  private chain?: Chain;
  private busy = false;
  constructor(private guild: Guild, private config: Config, private room: {
    defaultChannel?: string; audience(): string[]; active(): boolean;
    reference(id: string): string; resolve(ref: string, signal: AbortSignal): Promise<MemberResolution>;
  }, private limits: Map<string, number>, private now = Date.now) {}

  private supported(channel: Channel) { return [ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type); }
  private accessible(channel: Channel, owner?: string) {
    const bot = this.guild.members.me;
    const audience = this.room.audience();
    return this.room.active() && this.guild.available && this.guild.client.isReady() && !!bot && audience.length > 0
      && (!owner || audience.includes(owner)) && this.supported(channel)
      && [bot.id, ...audience].every(id => !!this.guild.members.cache.get(id)
        && channel.permissionsFor(id)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]));
  }
  canUseContext() {
    return [...this.sources].every(id => {
      const channel = this.guild.channels.cache.get(id);
      return !!channel?.isTextBased() && this.accessible(channel as Channel);
    });
  }
  onSpeech(event: number) { if (this.chain && event > this.chain.event) this.cancel(); }
  cancel() { this.chain = undefined; }
  continuationOwner(token: string, event: number) {
    const c = this.chain;
    return c?.token === token && c.event === event && c.expires > this.now() && c.rounds < 3 && c.calls < 3 && c.ioMs < 8000 ? c.owner : undefined;
  }
  private reference(source: Source) {
    for (const [ref, value] of this.messages) if (value.channel === source.channel && value.id === source.id) return ref;
    const ref = `m${++this.sequence}`; this.messages.set(ref, source);
    if (this.messages.size > 500) this.messages.delete(this.messages.keys().next().value!);
    return ref;
  }
  private source(ref: string): Source {
    const value = this.messages.get(ref);
    if (!value) throw new ChatError('expired_reference');
    return value;
  }
  private channelRef(id: string) {
    let ref = this.channelRefs.get(id);
    if (!ref) { ref = `c${this.channelRefs.size + 1}`; this.channelRefs.set(id, ref); }
    return ref;
  }
  private async channel(reference: string | undefined, owner: string, signal: AbortSignal): Promise<Channel> {
    const id = reference === undefined ? this.room.defaultChannel : [...this.channelRefs].find(([, ref]) => ref === reference)?.[0];
    if (reference && /^c\d+$/.test(reference) && !id) throw new ChatError('expired_reference');
    let channel;
    if (id) channel = await withAbort(this.guild.channels.fetch(id, { force: true }), signal);
    else if (reference) {
      const name = reference.replace(/^#/, '').normalize('NFKC').toLowerCase();
      const channels = await withAbort(this.guild.channels.fetch(), signal);
      const matches = [...channels.values()].filter(c => c?.isTextBased() && this.accessible(c as Channel, owner)
        && c.name.normalize('NFKC').toLowerCase() === name);
      if (matches.length > 1) throw new ChatError('ambiguous_channel', { candidates: matches.slice(0, 3).map(c => ({
        ref: this.channelRef(c!.id), name: safeName(c!.name), ...('parent' in c! && c.parent ? { category: safeName(c.parent.name) } : {}),
      })), complete: matches.length <= 3 });
      channel = matches[0];
    }
    signal.throwIfAborted();
    if (!channel?.isTextBased() || !this.accessible(channel as Channel, owner)) throw new ChatError('channel_unavailable');
    return channel as Channel;
  }
  private async resolve(q: Exclude<ChatQuery, { op: 'continue' }>, owner: string, signal: AbortSignal): Promise<Resolved> {
    if (q.op === 'get') {
      const link = messageLink(q.message);
      if (link && link.guild !== this.guild.id) throw new ChatError('channel_unavailable');
      const source = link ?? this.source(q.message);
      // Register a local channel alias so the normal resolver can fetch by ID.
      const channel = await this.channel(this.channelRef(source.channel), owner, signal);
      return { op: 'get', channel: channel.id, limit: 1, params: {}, message: source.id };
    }
    const channel = await this.channel(q.channel, owner, signal);
    const params: Record<string, string> = {};
    if (q.op === 'history') {
      for (const key of ['before', 'after', 'around'] as const) if (q[key]) {
        const source = this.source(q[key]!);
        if (source.channel !== channel.id) throw new ChatError('channel_unavailable');
        params[key] = source.id;
      }
    } else {
      params.channel_id = channel.id; params.sort_by = q.sort === 'relevance' ? 'relevance' : 'timestamp'; params.sort_order = 'desc';
      if (q.query) params.content = q.query.trim();
      if (q.has) params.has = q.has;
      if (q.author) {
        const person = await withAbort(this.room.resolve(q.author, signal), signal);
        if ('result' in person) { const { status, ...data } = person.result; throw new ChatError(status, data); }
        params.author_id = person.member.id;
      }
      if (q.after) params.min_id = (Date.parse(q.after) === epoch ? 0n : (BigInt(Date.parse(q.after) - epoch) << 22n) - 1n).toString();
      if (q.before) params.max_id = (BigInt(Date.parse(q.before) - epoch) << 22n).toString();
    }
    return { op: q.op, channel: channel.id, limit: q.limit ?? 5, params,
      ...(q.op === 'search' ? { after: q.after ? Date.parse(q.after) : undefined, before: q.before ? Date.parse(q.before) : undefined } : {}) };
  }
  private async rest(route: string, params: Record<string, string>, c: Chain, signal: AbortSignal): Promise<unknown> {
    if (c.calls >= 3) throw new ChatError('limit');
    c.calls++;
    return withAbort(this.guild.client.rest.get(route as `/${string}`, { query: new URLSearchParams(params), signal }), signal);
  }
  private record(message: APIMessage, limit: number): RecordMessage {
    const attachments = message.attachments ?? [];
    const result: RecordMessage = { ref: this.reference({ channel: message.channel_id, id: message.id }),
      author: { ...(message.webhook_id ? {} : { ref: this.room.reference(message.author.id) }), name: safeName(this.config.preferredNames[message.author.id]
        ?? this.guild.members.cache.get(message.author.id)?.displayName ?? message.author.global_name ?? message.author.username),
        kind: message.webhook_id ? 'webhook' : message.author.bot ? 'bot' : 'human' },
      sentAt: message.timestamp, editedAt: message.edited_timestamp, ...retrievedText(message.content ?? '', limit) };
    if (attachments.length) {
      result.attachmentCount = attachments.length;
      result.attachments = attachments.slice(0, 3).map(a => ({ name: retrievedText(a.filename, 80).text, type: retrievedText(a.content_type ?? 'file', 60).text }));
    }
    const reply = message.message_reference;
    if (reply?.message_id && reply.channel_id === message.channel_id && (!reply.guild_id || reply.guild_id === this.guild.id)) {
      result.replyTo = this.reference({ channel: message.channel_id, id: reply.message_id });
    }
    return result;
  }
  async query(q: ChatQuery, owner: string, event: number, parentSignal: AbortSignal): Promise<ChatResult> {
    if (!validChatQuery(q)) return { status: 'rejected' };
    if (!this.config.chatTools) return { status: 'disabled' };
    if (this.busy) return { status: 'cooldown' };
    let c: Chain;
    if (q.op === 'continue') {
      if (this.continuationOwner(q.token, event) !== owner) return { status: 'expired_reference' };
      c = this.chain!; c.token = undefined; // One-use, consumed before I/O.
      if (q.next !== 'more' && !c.allowed.has(q.message!)) return { status: 'expired_reference' };
      if (q.next === 'more' && !c.page) return { status: 'limit' };
    } else {
      if (['chat:room', `chat:${owner}`].some(k => this.now() - (this.limits.get(k) ?? -Infinity) < 3000)) return { status: 'cooldown' };
      this.limits.set('chat:room', this.now()); this.limits.set(`chat:${owner}`, this.now());
      c = { owner, event, expires: this.now() + 20000, rounds: 0, calls: 0, ioMs: 0, channel: '', allowed: new Set(), seen: new Set() };
      this.chain = c;
    }
    this.busy = true; c.rounds++;
    const began = this.now();
    const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(Math.max(1, Math.min(8000 - c.ioMs, c.expires - began)))]);
    try {
      signal.throwIfAborted();
      let request: Resolved;
      if (q.op !== 'continue') request = await this.resolve(q, owner, signal);
      else if (q.next === 'more') request = c.page!;
      else {
        const source = this.source(q.message!);
        request = { op: q.next === 'get' ? 'get' : 'history', channel: source.channel, limit: 5,
          params: q.next === 'around' ? { around: source.id } : {}, message: source.id };
      }
      c.channel = request.channel;
      // Refresh the channel and the small receiving roster before reading.
      const channel = await this.channel(this.channelRef(request.channel), owner, signal);
      if (request.op === 'search' && 'nsfw' in channel && channel.nsfw) request.params.include_nsfw = 'true';
      await withAbort(Promise.all([...new Set([this.guild.client.user!.id, ...this.room.audience()])]
        .map(user => this.guild.members.fetch({ user, force: true }))), signal);
      if (!this.accessible(channel, owner) || !this.canUseContext()) throw new ChatError('channel_unavailable');
      const limit = request.limit;
      let raw: APIMessage[];
      let page: unknown;
      if (request.op === 'search') {
        const params = { ...request.params, limit: String(limit) };
        page = await this.rest(Routes.guildMessagesSearch(this.guild.id), params, c, signal);
        const index = (value: unknown): value is { code: number; retry_after: number } => !!value && typeof value === 'object' && (value as { code?: number }).code === 110000;
        if (index(page)) {
          const delay = Math.max(100, Math.min(8000, Number(page.retry_after) * 1000));
          if (!Number.isFinite(delay) || c.calls >= 3 || this.now() + delay + 100 >= Math.min(c.expires, began + 8000 - c.ioMs)) return { status: 'indexing' };
          await new Promise<void>((resolve, reject) => {
            const canceled = () => { clearTimeout(timer); reject(signal.reason); };
            const timer = setTimeout(() => { signal.removeEventListener('abort', canceled); resolve(); }, delay);
            signal.addEventListener('abort', canceled, { once: true });
            if (signal.aborted) canceled();
          });
          page = await this.rest(Routes.guildMessagesSearch(this.guild.id), params, c, signal);
          if (index(page)) return { status: 'indexing' };
        }
        if (!page || typeof page !== 'object' || !Array.isArray((page as { messages?: unknown }).messages)) throw new ChatError('unavailable');
        raw = (page as { messages: APIMessage[][] }).messages.flatMap(group => Array.isArray(group) ? group : []);
      } else if (request.op === 'get') {
        raw = [await this.rest(Routes.channelMessage(channel.id, request.message!), {}, c, signal) as APIMessage];
      } else raw = await this.rest(Routes.channelMessages(channel.id), { ...request.params, limit: String(limit + 1) }, c, signal) as APIMessage[];
      signal.throwIfAborted();
      if (this.chain !== c || !this.accessible(channel, owner) || !this.canUseContext()) throw new ChatError('channel_unavailable');
      if (!Array.isArray(raw)) throw new ChatError('unavailable');
      if (request.op === 'history') {
        raw.sort((a, b) => BigInt(a.id) < BigInt(b.id) ? (request.params.after ? -1 : 1) : BigInt(a.id) > BigInt(b.id) ? (request.params.after ? 1 : -1) : 0);
        if (request.params.around) {
          const anchor = raw.findIndex(m => m.id === request.params.around);
          if (anchor < 0) throw new ChatError('not_found');
          const start = Math.max(0, Math.min(raw.length - limit, anchor - Math.floor(limit / 2)));
          const window = raw.slice(start, start + limit);
          // Project the requested message first so count/byte limits cannot
          // discard it; the final receipt restores chronological ordering.
          raw = [raw[anchor]!, ...window.filter(m => m.id !== request.params.around)];
        }
      }
      const messages: RecordMessage[] = [];
      let consumed = 0, cut = false;
      const dedupe = new Set<string>();
      const result: ChatResult = { status: 'ready', op: request.op, source: request.op === 'search' ? 'discord_search' : 'discord_history',
        channel: { ref: this.channelRef(channel.id), name: safeName(channel.name) }, fetchedAt: new Date(this.now()).toISOString(),
        messages, coverage: request.op === 'search' ? 'index_results' : 'window', more: 'unknown' };
      for (const message of raw.slice(0, limit)) {
        if (!message || message.channel_id !== channel.id || !/^\d{15,22}$/.test(message.id) || !message.author || !Number.isFinite(Date.parse(message.timestamp))) { consumed++; continue; }
        if (request.after !== undefined && Date.parse(message.timestamp) < request.after
          || request.before !== undefined && Date.parse(message.timestamp) >= request.before) { consumed++; continue; }
        if (request.op === 'search' && (request.params.min_id && BigInt(message.id) <= BigInt(request.params.min_id)
          || request.params.max_id && BigInt(message.id) >= BigInt(request.params.max_id))) { consumed++; continue; }
        if (![0, 19, 20, 23].includes(message.type) || dedupe.has(message.id) || q.op === 'continue' && q.next === 'more' && c.seen.has(message.id)) { consumed++; continue; }
        const record = this.record(message, request.op === 'get' ? 2000 : 500);
        messages.push(record);
        // Reserve the room envelope, continuation and output flags too.
        while (Buffer.byteLength(JSON.stringify(result)) > CHAT_RESULT_BYTES - 512 && Array.from(record.text).length) {
          record.text = Array.from(record.text).slice(0, Math.max(0, Array.from(record.text).length - 100)).join(''); record.truncated = true;
        }
        if (Buffer.byteLength(JSON.stringify(result)) > CHAT_RESULT_BYTES - 512) { messages.pop(); cut = true; break; }
        consumed++; dedupe.add(message.id); c.allowed.add(record.ref); c.seen.add(message.id);
      }
      if (request.op === 'history') messages.sort((a, b) => Date.parse(a.sentAt) - Date.parse(b.sentAt)
        || (BigInt(this.source(a.ref).id) < BigInt(this.source(b.ref).id) ? -1 : 1));
      if (!messages.length) result.status = 'empty';
      if (cut) result.truncated = true;
      c.page = undefined;
      if (request.op === 'search') {
        if (consumed) c.page = { ...request, params: { ...request.params, offset: String(Number(request.params.offset ?? 0) + consumed) } };
      } else if (request.op === 'history' && !request.params.around) {
        result.more = raw.length > consumed ? 'available' : 'exhausted';
        if (raw.length > consumed && consumed) c.page = { ...request, params: request.params.after
          ? { after: raw[consumed - 1]!.id } : { before: raw[consumed - 1]!.id } };
      }
      if (c.page && Number(c.page.params.offset ?? 0) > 9975) c.page = undefined;
      if ((c.page || messages.length) && c.rounds < 3 && c.calls < 3 && c.ioMs + this.now() - began < 8000 && this.now() < c.expires) {
        c.token = 'h' + crypto.randomUUID().replaceAll('-', '').slice(0, 16); result.next = c.token;
      }
      // No await between the last audience check, source registration and return.
      if (messages.length) this.sources.add(channel.id);
      return result;
    } catch (error) {
      if (parentSignal.aborted) throw parentSignal.reason;
      if (error instanceof ChatError) return { ...error.data, status: error.status };
      const code = (error as { code?: number }).code;
      return { status: code === 10008 ? 'not_found'
        : [10003, 50001, 50013].includes(code ?? 0) ? 'channel_unavailable' : 'unavailable' };
    } finally { c.ioMs += Math.max(0, this.now() - began); this.busy = false; }
  }
}
