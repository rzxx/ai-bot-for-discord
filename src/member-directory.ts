import { PermissionFlagsBits, type Guild, type GuildMember, type VoiceBasedChannel } from 'discord.js';
import type { Config } from './config';
import { withAbort } from './abort';
import { visiblePresence } from './presence';
import { safeName, safeText } from './tool-safety';

export const MEMBER_FIELDS = ['name', 'username', 'displayName', 'bot', 'presence', 'activity', 'voice', 'roles'] as const;
export type MemberField = typeof MEMBER_FIELDS[number];
type Kind = 'human' | 'bot';
export type MemberQuery =
  | { op: 'get'; person: string; fields?: MemberField[] }
  | { op: 'find'; query: string; kind?: Kind; fields?: MemberField[] }
  | { op: 'list'; scope?: 'server' | 'voice'; kind?: Kind; online?: boolean; count?: boolean; fields?: MemberField[] };
export interface MemberResult {
  status: string;
  columns?: string[];
  rows?: unknown[][];
  complete?: boolean;
  count?: number;
  unknown?: number;
  reason?: string;
}
export type MemberResolution = { member: { id: string; name: string } } | { result: MemberResult };
const normalized = (s: string) => s.normalize('NFKC').toLowerCase().replaceAll('ё', 'е').replaceAll('+', '').trim();
const isOnline = (s: string) => ['online', 'idle', 'dnd'].includes(s);
export const MEMBER_RESULT_BYTES = 3000;

export function validMemberQuery(value: unknown): value is MemberQuery {
  if (!value || typeof value !== 'object') return false;
  const q = value as Record<string, unknown>;
  const text = (v: unknown) => typeof v === 'string' && v.trim().length > 0 && v.length <= 40;
  if (q.fields !== undefined && (!Array.isArray(q.fields) || !q.fields.length || q.fields.length > MEMBER_FIELDS.length
    || new Set(q.fields).size !== q.fields.length || q.fields.some(f => !MEMBER_FIELDS.includes(f as MemberField)))) return false;
  if (q.kind !== undefined && !['human', 'bot'].includes(q.kind as string)) return false;
  const common = ['tool', 'event', 'op', 'fields'];
  const allowed = q.op === 'get' ? [...common, 'person'] : q.op === 'find' ? [...common, 'query', 'kind']
    : [...common, 'scope', 'kind', 'online', 'count'];
  if (Object.keys(q).some(key => !allowed.includes(key))) return false;
  if (q.op === 'get') return text(q.person);
  if (q.op === 'find') return text(q.query) && normalized(q.query as string).length >= 2 && !/^\d{15,22}$/.test(q.query as string);
  return q.op === 'list' && (q.scope === undefined || ['server', 'voice'].includes(q.scope as string))
    && (q.online === undefined || typeof q.online === 'boolean') && (q.count === undefined || typeof q.count === 'boolean')
    && !(q.count && q.fields !== undefined);
}

/** Discord data stays local. Only a bounded projection with session aliases
 * leaves this adapter; no raw IDs, history, pagination or unbounded fetches. */
export class MemberDirectory {
  private rosterJob?: Promise<GuildMember[]>;
  private nextRosterAt = 0;
  constructor(private guild: Guild, private config: Config,
    private identities: { resolve(ref: string): string | undefined; reference(id: string): string },
    private room: { channel: VoiceBasedChannel; audience(): string[]; presence?(p: GuildMember): ReturnType<typeof visiblePresence> }, private now = Date.now) {}

  private name(p: GuildMember) { return safeName(this.config.preferredNames[p.id] ?? p.displayName); }
  private names(p: GuildMember) {
    return [this.config.preferredNames[p.id], p.displayName, p.nickname, p.user.globalName, p.user.username]
      .filter((n): n is string => !!n).map(normalized);
  }
  private connected() { return this.guild.available && this.guild.client.isReady(); }
  private state(p: GuildMember) {
    if (!this.config.presenceContext || !this.connected()) return visiblePresence(null);
    return this.room.presence?.(p) ?? visiblePresence(p.presence);
  }
  private async wait<T>(job: Promise<T>, signal: AbortSignal) {
    return withAbort(job, AbortSignal.any([signal, AbortSignal.timeout(3000)]));
  }
  private async roster(signal: AbortSignal): Promise<GuildMember[] | undefined> {
    if (!this.config.memberContext || this.guild.memberCount > 10) return;
    const cached = [...this.guild.members.cache.values()];
    if (cached.length === this.guild.memberCount) return cached;
    if (!this.rosterJob) {
      if (this.now() < this.nextRosterAt) return;
      this.nextRosterAt = this.now() + 30000;
      this.rosterJob = this.guild.members.fetch({ query: '', limit: 11, withPresences: this.config.presenceContext, time: 3000 })
        .then(m => [...m.values()]).finally(() => { this.rosterJob = undefined; });
    }
    const members = await this.wait(this.rosterJob, signal);
    signal.throwIfAborted();
    // Membership may change while the request is in flight.
    if (this.guild.memberCount <= 10 && members.length === this.guild.memberCount
      && members.every(p => this.guild.members.cache.has(p.id))) return members;
  }
  private async candidates(query: string, signal: AbortSignal) {
    const full = await this.roster(signal);
    signal.throwIfAborted();
    if (full) return { members: full, complete: true, full: true };
    const found = await this.wait(this.guild.members.search({ query, limit: 4 }), signal);
    signal.throwIfAborted();
    const members = new Map([...found, ...this.guild.members.cache]);
    // Configured aliases are explicit local identity mappings, even when that
    // member has not spoken or appeared in the gateway's initial member set.
    const configured = Object.entries(this.config.preferredNames).filter(([, name]) => normalized(name) === normalized(query));
    await Promise.all(configured.slice(0, 3).filter(([id]) => !members.has(id)).map(async ([id]) => {
      try { members.set(id, await this.wait(this.guild.members.fetch({ user: id, force: true }), signal)); }
      catch (error) { if ((error as { code?: number }).code !== 10007) throw error; }
    }));
    signal.throwIfAborted();
    return { members: [...members.values()], complete: found.size < 4 && configured.length <= 3, full: false };
  }
  private result(members: GuildMember[], fields: readonly MemberField[], complete: boolean, status = 'ready'): MemberResult {
    const columns = ['ref', ...fields];
    const result: MemberResult = { status, columns, rows: [], complete };
    for (const p of members) {
      const state = fields.some(f => f === 'presence' || f === 'activity') ? this.state(p) : undefined;
      const value = (field: MemberField): unknown => {
        switch (field) {
          case 'name': return this.name(p);
          case 'username': return safeName(p.user.username);
          case 'displayName': return safeName(p.displayName);
          case 'bot': return Number(p.user.bot);
          case 'presence': return state?.presenceAvailable ? state.status : 'unknown';
          case 'activity': return state?.presenceAvailable ? state.activity : null;
          case 'voice': {
            const channel = p.voice.channel;
            if (!channel) return null;
            return this.room.audience().every(id => channel.permissionsFor(id)?.has(PermissionFlagsBits.ViewChannel))
              ? safeName(channel.name) : 'unknown';
          }
          case 'roles': {
            const roles = [...p.roles.cache.values()].filter(r => r.id !== this.guild.id);
            if (roles.length > 5) result.complete = false;
            return roles.slice(0, 5).map(r => safeText(r.name, 30));
          }
        }
      };
      const row = [this.identities.reference(p.id), ...fields.map(value)];
      result.rows!.push(row);
      // Reserve room for the receipt envelope and an unknown-presence count.
      if (Buffer.byteLength(JSON.stringify(result)) > MEMBER_RESULT_BYTES - 128) {
        result.rows!.pop(); result.complete = false; break;
      }
    }
    return result;
  }
  async resolve(reference: string, signal: AbortSignal): Promise<MemberResolution> {
    signal.throwIfAborted();
    if (!reference.trim() || reference.length > 40) return { result: { status: 'unknown_person' } };
    reference = reference.trim();
    if (!this.connected()) return { result: { status: 'unavailable' } };
    const id = this.identities.resolve(reference);
    if (id) {
      try {
        const p = await this.wait(this.guild.members.fetch({ user: id, force: true }), signal);
        signal.throwIfAborted();
        return { member: { id: p.id, name: this.name(p) } };
      } catch (error) {
        signal.throwIfAborted();
        if ((error as { code?: number }).code === 10007) return { result: { status: 'unknown_person' } };
        throw error;
      }
    }
    if (/^u\d+$/.test(reference) || /^\d{15,22}$/.test(reference)) return { result: { status: 'unknown_person' } };
    const { members, complete, full } = await this.candidates(reference, signal);
    signal.throwIfAborted();
    const exact = members.filter(p => this.names(p).includes(normalized(reference)));
    // Discord's search endpoint covers usernames and nicknames, not every
    // global display name. A unique cached display name is not proof of a
    // unique member on a partially loaded server.
    const searchable = exact.length === 1 && [exact[0]!.user.username, exact[0]!.nickname, this.config.preferredNames[exact[0]!.id]]
      .some(n => n && normalized(n) === normalized(reference));
    if (exact.length === 1 && complete && (full || searchable)) {
      // Recheck membership and channel-permission inputs immediately before a
      // message can use a name, just as for an already-issued session alias.
      const p = await this.wait(this.guild.members.fetch({ user: exact[0]!.id, force: true }), signal);
      signal.throwIfAborted();
      return { member: { id: p.id, name: this.name(p) } };
    }
    const possible = exact.length ? exact : members.filter(p => this.names(p).some(n => n.startsWith(normalized(reference))));
    return { result: possible.length || !complete
      ? this.result(possible.slice(0, 3), ['name', 'username', 'bot'], full && complete && possible.length <= 3, 'ambiguous_person')
      : { status: 'unknown_person' } };
  }
  async query(q: MemberQuery, signal: AbortSignal): Promise<MemberResult> {
    signal.throwIfAborted();
    if (!validMemberQuery(q)) return { status: 'rejected', reason: 'invalid_query' };
    if (!this.connected()) return { status: 'unavailable' };
    if (q.op === 'get') {
      const resolved = await this.resolve(q.person, signal);
      signal.throwIfAborted();
      if ('result' in resolved) return resolved.result;
      let p = this.guild.members.cache.get(resolved.member.id);
      if (p && !p.presence && this.config.presenceContext && q.fields?.some(f => f === 'presence' || f === 'activity')) {
        // REST member lookup does not include presence. Ask only for this
        // member when no live presence was received, never expand the roster.
        const fetched = await this.wait(this.guild.members.fetch({ user: [p.id], withPresences: true, time: 3000 }), signal);
        signal.throwIfAborted();
        p = fetched.get(p.id);
      }
      return p ? this.result([p], q.fields ?? ['name', 'bot'], true) : { status: 'unavailable' };
    }
    let members: GuildMember[], complete = true;
    if (q.op === 'find') {
      const found = await this.candidates(q.query, signal);
      signal.throwIfAborted();
      members = found.members.filter(p => this.names(p).some(n => n.startsWith(normalized(q.query))));
      complete = found.complete && found.full;
    } else {
      if (q.scope === 'voice') {
        members = [...this.room.channel.members.values()];
        if (members.length > 10) return { status: 'narrow_query' };
      } else {
        // Apply the size gate BEFORE any filtering, counting or network call.
        if (this.guild.memberCount > 10) return { status: 'narrow_query' };
        if (!this.config.memberContext) return { status: 'disabled', reason: 'member_list_disabled' };
        const full = await this.roster(signal);
        signal.throwIfAborted();
        if (this.guild.memberCount > 10) return { status: 'narrow_query' };
        if (!full) return { status: 'unavailable', reason: 'incomplete_roster' };
        members = full;
      }
    }
    if (q.kind) members = members.filter(p => p.user.bot === (q.kind === 'bot'));
    let unknown = 0;
    if (q.op === 'list' && q.online !== undefined) {
      if (!this.config.presenceContext) return { status: 'disabled', reason: 'presence_disabled' };
      members = members.filter(p => {
        const s = this.state(p);
        if (!s.presenceAvailable || !['online', 'idle', 'dnd', 'offline'].includes(s.status)) { unknown++; return false; }
        return isOnline(s.status) === q.online;
      });
      if (unknown) complete = false;
    }
    if (q.op === 'list' && q.count) return { status: 'ready', count: members.length, complete, ...(unknown ? { unknown } : {}) };
    const limit = q.op === 'find' ? 3 : 10;
    const fields: readonly MemberField[] = q.fields ?? (q.op === 'find' ? ['name', 'username', 'bot']
      : q.online !== undefined ? ['name', 'presence'] : q.kind ? ['name'] : ['name', 'bot']);
    const result = this.result(members.slice(0, limit), fields, complete && members.length <= limit);
    if (unknown) result.unknown = unknown;
    return result;
  }
}
