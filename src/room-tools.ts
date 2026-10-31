import { t } from './locale';
import type { Config } from './config';
import type { Member, TurnEvent } from './llm';
import { publicResultUrl, safeText } from './tool-safety';
import { createWebSearch, publicQuery, type SearchProvider, type SearchResult } from './web-search';
import { canonicalUrl } from './search-text';
import { ReminderScheduler, type ReminderAccess } from './reminders';
import type { DiagnosticFields } from './telemetry';
import { validMemberQuery, type MemberQuery, type MemberResult, type MemberResolution } from './member-directory';
import { withAbort } from './abort';

export type ToolAction = { tool: 'message'; event: number; text: string; mentions?: string[] }
  | { tool: 'remind'; event: number; seconds: number; text: string }
  | { tool: 'cancel_reminder'; event: number; id: string }
  | { tool: 'reminders'; event: number }
  | { tool: 'activity'; event: number; person: string }
  | ({ tool: 'members'; event: number } & MemberQuery)
  | { tool: 'search'; event: number; query: string; continue?: string };
interface SearchChain { owner: string; event: number; round: number; expires: number; queries: string[]; seen: SearchResult[]; next?: string }
export interface ToolReceipt { tool: ToolAction['tool']; event: number; status: string; [key: string]: unknown }
export interface ToolHost {
  resolvePerson(reference: string): Member | undefined;
  resolveMember?(reference: string, signal: AbortSignal): Promise<MemberResolution>;
  members?(query: MemberQuery, signal: AbortSignal): Promise<MemberResult>;
  sendMessage(actor: string, text: string, mentions: string[], signal: AbortSignal): Promise<void>;
  activity(person: Member): { status: string; activity: string; presenceAvailable?: boolean };
  // Shared across voice sessions so /leave + /join cannot bypass message limits.
  limits: Map<string, number>;
  search?: SearchProvider;
  privateTerms?(): string[];
  reminders?: ReminderAccess;
}
export function parseActions(value: unknown): ToolAction[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 2).filter((a): a is ToolAction => {
    if (!a || typeof a !== 'object' || !Number.isSafeInteger(a.event) || a.event < 1) return false;
    switch (a.tool) {
      case 'message': return typeof a.text === 'string' && a.text.length <= 1200 && (a.mentions === undefined || Array.isArray(a.mentions) && a.mentions.length <= 2 && a.mentions.every((m: unknown) => typeof m === 'string' && m.length <= 40));
      case 'remind': return Number.isInteger(a.seconds) && a.seconds >= 5 && a.seconds <= 86400 && typeof a.text === 'string' && a.text.length <= 600;
      case 'cancel_reminder': return typeof a.id === 'string' && /^r\d{1,10}$/.test(a.id);
      case 'reminders': return true;
      case 'activity': return typeof a.person === 'string' && a.person.length > 0 && a.person.length <= 40;
      case 'members': return validMemberQuery(a);
      case 'search': return typeof a.query === 'string' && a.query.length >= 3 && a.query.length <= 180
        && (a.continue === undefined || typeof a.continue === 'string' && /^q[\da-f]{8}$/.test(a.continue));
      default: return false;
    }
  });
}

export class RoomTools {
  private reminders: ReminderAccess;
  private localReminders?: ReminderScheduler;
  private used = new Set<string>();
  private lifetime = new AbortController();
  private search?: { abort: AbortController; event: number };
  private chain?: SearchChain;
  private jobs = new Set<Promise<void>>();
  private lookups = new Map<AbortController, number>();
  constructor(private config: Config, private host: ToolHost, private present: (id: string) => boolean,
    private deliver: (owner: string, receipt: ToolReceipt, wake: boolean) => void, private now: () => number = Date.now,
    private observe: (stage: string, fields: DiagnosticFields) => void = () => {}) {
    if (host.reminders) this.reminders = host.reminders;
    else {
      this.localReminders = new ReminderScheduler(async reminders => {
        for (const r of reminders) this.deliver(r.owner, { tool: 'remind', event: r.event, status: this.present(r.owner) ? 'due' : 'expired', id: r.id, text: r.text }, this.present(r.owner));
        return 'done';
      }, now, r => this.deliver(r.owner, { tool: 'remind', event: r.event, status: 'expired', id: r.id, text: r.text }, false));
      this.reminders = this.localReminders.forRoom('local', '');
    }
  }
  get capabilities() {
    return [...(this.host.members ? ['members'] : this.config.presenceContext ? ['activity'] : []), ...(this.config.messageTools ? ['message'] : []), ...(this.config.reminderTools ? ['remind', 'cancel_reminder', 'reminders'] : []), ...(this.config.webSearch ? ['search'] : [])];
  }
  private limited(key: string, ms: number) { return this.now() - (this.host.limits.get(key) ?? -Infinity) < ms; }
  private stamp(key: string) { this.host.limits.set(key, this.now()); }
  onSpeech(event: number) {
    for (const [abort, source] of this.lookups) if (event > source) abort.abort();
    if (this.chain && event > this.chain.event) this.chain = undefined;
    if (this.search && event > this.search.event) { this.search.abort.abort(); this.search = undefined; }
  }
  cancelBackground() {
    for (const abort of this.lookups.keys()) abort.abort();
    this.search?.abort.abort(); this.search = undefined; this.chain = undefined;
  }
  submit(actions: ToolAction[], origins: TurnEvent[], signal: AbortSignal) {
    for (const action of parseActions(actions)) {
      // Only search can continue an app-issued, live search chain. All other
      // actions still require a current human speech origin.
      const origin = origins.find(e => e.id === action.event && e.kind === 'speech');
      const rejected = (reason: string, feedback = false) => {
        this.observe('tool_action_rejected', { tool: action.tool, sourceEvent: action.event, reason });
        if (feedback && origin?.userId && this.present(origin.userId) && !signal.aborted && !this.lifetime.signal.aborted) {
          this.deliver(origin.userId, { tool: action.tool, event: action.event, status: 'rejected', reason }, true);
        }
      };
      let continuation: SearchChain | undefined;
      if (action.tool === 'search' && action.continue) {
        const chain = this.chain;
        const receiptOrigin = origins.some(e => {
          if (e.kind !== 'tool' || e.userId !== chain?.owner) return false;
          try { const r = JSON.parse(e.text); return r.tool === 'search' && r.event === action.event && r.next === action.continue; } catch { return false; }
        });
        if (!chain || chain.next !== action.continue || chain.event !== action.event || chain.round >= 3
          || chain.expires <= this.now() || !receiptOrigin || chain.queries.includes(action.query.toLowerCase().trim().replace(/\s+/g, ' '))) {
          rejected('invalid_continuation'); continue;
        }
        continuation = chain;
      }
      const actor = continuation?.owner ?? origin?.userId;
      if (!actor || !this.present(actor) || signal.aborted || this.lifetime.signal.aborted) { rejected('no_current_speaker'); continue; }
      const words = (origin?.text ?? '').toLowerCase().replaceAll('ё', 'е');
      // Interpret freeform message requests in the same model turn that heard
      // them. A second verb whitelist rejected paraphrases and follow-ups.
      // Live human provenance, cancellation, permissions and cooldowns remain
      // deterministic; an explicit refusal still vetoes a proposed write.
      const request = action.tool === 'remind' ? /(?:напомн|таймер|засек|засеч|отсчет|remind|timer|alarm)/u
        : action.tool === 'cancel_reminder' ? /(?:отмен|удал|убер|убра|сними|cancel|delete)/u : undefined;
      if (request && !request.test(words)) { rejected('missing_request', true); continue; }
      const writes = ['message', 'remind', 'cancel_reminder'].includes(action.tool);
      if (writes && /(?:не|нельзя|don't|do not)\s+(?:мне\s+)?(?:пиш|напиш|напис|отправ|переда|сообщ|позов|приглас|пинг|став|созда|напом|отмен|удал|убира|write|send|post|invite|remind|cancel|delete|set)/u.test(words)) { rejected('negated_request', true); continue; }
      const detail = action.tool === 'remind' ? `${action.seconds}:${safeText(action.text, 320)}`
        : action.tool === 'cancel_reminder' ? action.id : action.tool === 'activity' ? action.person
        : action.tool === 'members' ? JSON.stringify(action) : '';
      const key = `${action.event}:${action.tool}:${continuation?.next ?? detail}`;
      if (this.used.has(key)) { rejected('duplicate_action'); continue; }
      this.used.add(key);
      if (continuation) this.chain = undefined; // Consume once, before I/O.
      const job = this.run(action, actor, signal, continuation).catch(() => {}).finally(() => this.jobs.delete(job));
      this.jobs.add(job);
    }
  }
  private async run(action: ToolAction, owner: string, turnSignal: AbortSignal, continuation?: SearchChain) {
    const began = this.now();
    let result = 'canceled';
    this.observe('tool_job_started', { tool: action.tool, sourceEvent: action.event });
    const lookup = ['members', 'message', 'activity'].includes(action.tool) ? new AbortController() : undefined;
    if (lookup) this.lookups.set(lookup, action.event);
    const signal = AbortSignal.any([turnSignal, this.lifetime.signal, ...(lookup ? [lookup.signal] : [])]);
    const report = (status: string, data: Record<string, unknown> = {}, wake = !['sent', 'scheduled', 'canceled'].includes(status)) => {
      result = status;
      // Receipt identity/outcome cannot be overwritten by payload fields.
      if (!this.lifetime.signal.aborted && (!lookup || !signal.aborted)) this.deliver(owner, { ...data, tool: action.tool, event: action.event, status }, wake && !signal.aborted && this.present(owner));
    };
    try {
      signal.throwIfAborted();
      if (!this.capabilities.includes(action.tool)) { report('disabled'); return; }
      if (action.tool === 'message') {
        if (this.limited(`message:${owner}`, this.config.messageCooldownSeconds * 1000) || this.limited('message:room', 10000)) { report('cooldown'); return; }
        const text = safeText(action.text, 500);
        if (!text) { report('empty'); return; }
        const mentions: string[] = [];
        for (const ref of action.mentions ?? []) {
          const resolved = this.host.resolveMember
            ? await withAbort(this.host.resolveMember(ref, signal), AbortSignal.any([signal, AbortSignal.timeout(4000)])) : undefined;
          signal.throwIfAborted();
          if (resolved && 'result' in resolved) {
            const { status, ...data } = resolved.result; report(status, data); return;
          }
          const member = resolved && 'member' in resolved ? resolved.member : this.host.resolvePerson(ref);
          if (!member) { report('unknown_person'); return; }
          if (this.limited(`mention:${member.id}`, this.config.mentionCooldownSeconds * 1000)) { report('mention_cooldown'); return; }
          if (!mentions.includes(member.id)) mentions.push(member.id);
        }
        // Resolution yields to I/O; recheck permissions/liveness and budgets
        // before reserving a send, including concurrent requests.
        signal.throwIfAborted();
        if (!this.present(owner)) return;
        if (this.limited(`message:${owner}`, this.config.messageCooldownSeconds * 1000) || this.limited('message:room', 10000)) { report('cooldown'); return; }
        if (mentions.some(id => this.limited(`mention:${id}`, this.config.mentionCooldownSeconds * 1000))) { report('mention_cooldown'); return; }
        // Reserve before I/O, including ambiguous failures: never retry a send.
        this.stamp(`message:${owner}`); this.stamp('message:room');
        for (const id of mentions) this.stamp(`mention:${id}`);
        await this.host.sendMessage(owner, text, mentions, signal);
        report('sent');
      } else if (action.tool === 'remind') {
        const text = safeText(action.text, 320);
        if (!text) { report('empty'); return; }
        const reminder = this.reminders.create(owner, action.seconds, text, action.event);
        if (!reminder) { report('limit'); return; }
        report('scheduled', { id: reminder.id, seconds: action.seconds, text });
      } else if (action.tool === 'cancel_reminder') {
        if (!this.reminders.cancel(owner, action.id)) { report('not_owned'); return; }
        report('canceled', { id: action.id });
      } else if (action.tool === 'reminders') {
        report('ready', { items: this.reminders.list(owner).map(r => ({ id: r.id, seconds: Math.max(0, Math.ceil((r.due - this.now()) / 1000)), text: r.text })) }, true);
      } else if (action.tool === 'members') {
        const result = await withAbort(this.host.members!(action, signal), AbortSignal.any([signal, AbortSignal.timeout(4000)]));
        signal.throwIfAborted();
        const { status, ...data } = result;
        report(status, data);
      } else if (action.tool === 'activity') {
        const person = this.host.resolvePerson(action.person);
        if (!person) { report('unknown_person', {}, true); return; }
        const state = this.host.activity(person);
        report('ready', { name: person.name, presenceStatus: safeText(state.status, 16),
          presenceAvailable: state.presenceAvailable ?? state.status !== 'unknown', activity: safeText(state.activity, 160) }, true);
      } else if (action.tool === 'search') {
        if (!publicQuery(action.query)) { report('private_query'); return; }
        const normalized = action.query.toLowerCase().replaceAll('ё', 'е');
        if ((this.host.privateTerms?.() ?? []).some(term => {
          const name = term.toLowerCase().replaceAll('ё', 'е');
          return name.length >= 3 && normalized.includes(name);
        })) { report('private_query'); return; }
        if (this.search || !continuation && this.limited('search:room', this.config.searchCooldownSeconds * 1000)) { report('cooldown'); return; }
        if (!continuation) { this.stamp('search:room'); this.chain = undefined; }
        const chain: SearchChain = continuation ?? { owner, event: action.event, round: 0, expires: this.now() + 20000, queries: [], seen: [] };
        chain.round++; chain.queries.push(action.query.toLowerCase().trim().replace(/\s+/g, ' '));
        const abort = new AbortController(), job = { abort, event: action.event }; this.search = job;
        const timeout = setTimeout(() => abort.abort(new Error(t("Search deadline exceeded."))), Math.min(this.config.searchTimeoutMs, Math.max(1, chain.expires - this.now())));
        const bounded = AbortSignal.any([signal, abort.signal]);
        try {
          const provider = this.host.search ?? createWebSearch();
          // Race too: an injected/misbehaving provider cannot hold a job forever.
          const results = await new Promise<Awaited<ReturnType<SearchProvider>>>((resolve, reject) => {
            const canceled = () => reject(bounded.reason);
            bounded.addEventListener('abort', canceled, { once: true });
            if (bounded.aborted) { canceled(); return; }
            void provider(action.query, bounded, { previous: chain.seen }).then(resolve, reject).finally(() => bounded.removeEventListener('abort', canceled));
          });
          bounded.throwIfAborted();
          const excerpts = results.slice(0, 6).flatMap<SearchResult>(result => {
            const safe = publicResultUrl(result.url), url = safe && canonicalUrl(safe);
            const title = safeText(result.title, 80), snippet = safeText(result.snippet, 650);
            return url && !chain.seen.some(r => r.url === url && r.snippet === snippet) && url.length <= 350 && title && snippet ? [{ title, url, snippet,
              via: result.via === 'page' ? 'page' : 'snippet',
              ...(result.published && /^\d{4}-\d{2}-\d{2}$/.test(result.published) ? { published: result.published } : {}) }] : [];
          }).slice(0, 3);
          chain.seen.push(...excerpts);
          const more = chain.round < 3 && this.now() < chain.expires;
          if (more) { chain.next = 'q' + crypto.randomUUID().replaceAll('-', '').slice(0, 8); this.chain = chain; }
          report(excerpts.length ? 'ready' : 'unavailable', { round: chain.round, ...(more ? { next: chain.next } : {}),
            ...(excerpts.length ? { results: excerpts } : {}) }, true);
        } catch {
          if (!signal.aborted && this.search === job) report('unavailable', {}, true);
          else report('canceled', {}, false);
        } finally { clearTimeout(timeout); if (this.search === job) this.search = undefined; }
      }
    } catch {
      // No raw network errors, queried text, credentials or exception objects.
      if (!signal.aborted) report('unavailable');
    } finally {
      if (lookup) this.lookups.delete(lookup);
      this.observe('tool_job_finished', { tool: action.tool, sourceEvent: action.event, status: result, elapsedMs: this.now() - began });
    }
  }
  tick() { this.localReminders?.tick(); }
  close() { this.lifetime.abort(); this.cancelBackground(); this.localReminders?.close(); this.used.clear(); }
  async settle() { await Promise.allSettled([...this.jobs]); await this.localReminders?.settle(); }
}
