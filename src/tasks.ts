import { safeText } from './tool-safety';

export type TaskTool = 'search' | 'activity' | 'members' | 'message';
export type TaskTrigger =
  | { kind: 'once'; seconds: number }
  | { kind: 'interval'; seconds: number; jitterSeconds?: number }
  | { kind: 'daily'; time: string; timezone: string; weekdays?: number[] }
  | { kind: 'change'; source: string; subject?: string; includeCurrent?: boolean }
  | { kind: 'condition'; source: string; subject?: string; field?: string; equals: string | number | boolean; seconds: number }
  | { kind: 'silence'; seconds: number };
export interface TaskCondition { source: string; subject?: string; field?: string; equals: string | number | boolean }
export interface TaskDefinition {
  intent: string; trigger: TaskTrigger; delivery?: 'model' | 'prepared'; text?: string;
  tools?: TaskTool[]; conditions?: TaskCondition[]; pending?: 'all' | 'latest';
  cooldownSeconds?: number; expiresSeconds?: number; recentHumanSeconds?: number;
}
export interface TaskObservation {
  source: string; subject?: string; key: string; at?: number; available?: boolean;
  data: Record<string, string | number | boolean>;
}
export interface TaskEnvironment {
  members: ReadonlySet<string>; listeners: ReadonlySet<string>; lastHumanAt: number;
  humanSpeaking: boolean; lastBotAt: number;
}
export interface TaskResult { run: string; status: 'done' | 'skip' | 'defer'; seconds?: number }
export interface ScheduledTask extends TaskDefinition {
  id: string; owner: string; event: number; revision: number; createdAt: number; expiresAt: number;
  paused: boolean; nextAt?: number; lastDeliveryAt: number; heldSince?: number; latched: boolean;
  nextIndex?: number;
}
export interface TaskRun {
  id: string; task: string; revision: number; owner: string; dueAt: number; expiresAt: number;
  state: 'pending' | 'leased' | 'waiting'; notBefore: number; event?: number;
  observations: TaskObservation[]; receipts: Record<string, unknown>[]; merged: number;
  steps: number; searches: string[]; toolsStarted: Set<TaskTool>; effect: boolean;
  dropped: number;
  writeAttempted: boolean;
  observationVersion: number; describedVersion: number; observationCursor: number; receiptCursor: number; introduced: boolean;
  abort: AbortController;
}
export interface TaskGrant { run: TaskRun; task: ScheduledTask; signal: AbortSignal }
export interface TaskLimits {
  maxTasks: number; maxPending: number; maxBatch: number; maxObservations: number;
  modelIntervalMs: number; hourlyModelLimit: number; speechCooldownMs: number;
  maxSteps: number; runLifetimeMs: number;
}
export const taskLimits: TaskLimits = {
  maxTasks: 20, maxPending: 128, maxBatch: 8, maxObservations: 32,
  modelIntervalMs: 10000, hourlyModelLimit: 120, speechCooldownMs: 15000,
  maxSteps: 8, runLifetimeMs: 120000,
};
const sourceName = /^[a-z][a-z0-9_.-]{0,47}$/;
const scalar = (v: unknown): v is string | number | boolean => typeof v === 'string' && v.length <= 200
  || typeof v === 'number' && Number.isFinite(v) || typeof v === 'boolean';
const seconds = (v: unknown, min = 0, max = 604800): v is number => Number.isInteger(v) && Number(v) >= min && Number(v) <= max;
export function validTaskCondition(v: any): v is TaskCondition {
  return !!v && sourceName.test(v.source) && (v.subject === undefined || typeof v.subject === 'string' && v.subject.length <= 40)
    && (v.field === undefined || /^[a-zA-Z][\w.-]{0,39}$/.test(v.field)) && scalar(v.equals);
}
export function validTaskTrigger(v: any): v is TaskTrigger {
  if (!v || typeof v !== 'object') return false;
  switch (v.kind) {
    case 'once': case 'silence': return seconds(v.seconds, 5);
    case 'interval': return seconds(v.seconds, 5) && (v.jitterSeconds === undefined || seconds(v.jitterSeconds, 0, Math.floor(v.seconds / 2)));
    case 'daily': {
      if (typeof v.time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(v.time)
        || typeof v.timezone !== 'string' || v.timezone.length > 100
        || v.weekdays !== undefined && (!Array.isArray(v.weekdays) || !v.weekdays.length || v.weekdays.length > 7 || !v.weekdays.every((d: unknown) => seconds(d, 0, 6)))) return false;
      try { new Intl.DateTimeFormat('en', { timeZone: v.timezone }); return true; } catch { return false; }
    }
    case 'change': return sourceName.test(v.source) && (v.subject === undefined || typeof v.subject === 'string' && v.subject.length <= 40)
      && (v.includeCurrent === undefined || typeof v.includeCurrent === 'boolean');
    case 'condition': return validTaskCondition(v) && seconds((v as any).seconds, 5);
    default: return false;
  }
}
export function validTaskDefinition(v: any): v is TaskDefinition {
  return !!v && typeof v.intent === 'string' && !!safeText(v.intent, 600) && v.intent.length <= 600 && validTaskTrigger(v.trigger)
    && (v.delivery === undefined || ['model', 'prepared'].includes(v.delivery))
    && (v.text === undefined || typeof v.text === 'string' && v.text.length <= 600)
    && (v.delivery !== 'prepared' || typeof v.text === 'string' && !!safeText(v.text, 600))
    && (v.tools === undefined || Array.isArray(v.tools) && v.tools.length <= 4 && v.tools.every((t: string) => ['search', 'activity', 'members', 'message'].includes(t)))
    && (v.conditions === undefined || Array.isArray(v.conditions) && v.conditions.length <= 4 && v.conditions.every(validTaskCondition))
    && (v.pending === undefined || ['all', 'latest'].includes(v.pending))
    && (v.cooldownSeconds === undefined || seconds(v.cooldownSeconds, 5))
    && (v.expiresSeconds === undefined || seconds(v.expiresSeconds, 5))
    && (v.recentHumanSeconds === undefined || seconds(v.recentHumanSeconds, 0));
}
export function parseTaskResults(value: unknown): TaskResult[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).filter((v): v is TaskResult => !!v && /^o\d+$/.test(v.run)
    && ['done', 'skip', 'defer'].includes(v.status) && (v.seconds === undefined || seconds(v.seconds, 5, 3600)));
}

/** Next local wall-clock occurrence. Minute iteration handles DST gaps and folds;
 * after a fold we deliberately schedule the following local date, not twice. */
export function nextDaily(trigger: Extract<TaskTrigger, { kind: 'daily' }>, after: number): number {
  const format = new Intl.DateTimeFormat('en-US', { timeZone: trigger.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' });
  const parts = (at: number) => Object.fromEntries(format.formatToParts(at).map(p => [p.type, p.value]));
  const initial = parts(after), initialDate = `${initial.year}-${initial.month}-${initial.day}`;
  const alreadyPassed = `${initial.hour}:${initial.minute}` >= trigger.time;
  for (let at = Math.floor(after / 60000) * 60000 + 60000; at < after + 9 * 86400000; at += 60000) {
    const p = parts(at), date = `${p.year}-${p.month}-${p.day}`;
    if (alreadyPassed && date === initialDate || `${p.hour}:${p.minute}` !== trigger.time) continue;
    if (trigger.weekdays && !trigger.weekdays.includes(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday!))) continue;
    return at;
  }
  throw new Error('No calendar occurrence within nine days.');
}

export interface TaskSource {
  name: string; intervalMs: number;
  poll(signal: AbortSignal): Promise<TaskObservation[]>;
}

/** Session-local observation and occurrence store. Never writes to disk or the
 * model context. claim/bind is the sole bridge into the conversational lane. */
export class TaskRuntime {
  private tasks = new Map<string, ScheduledTask>();
  private runs = new Map<string, TaskRun>();
  private observations = new Map<string, TaskObservation>();
  private sources = new Map<string, { source: TaskSource; nextAt: number; failures: number; active?: Promise<void> }>();
  private eventSources = new Set(['spotify', 'activity', 'chat', 'voice.join', 'voice.leave']);
  private lifetime = new AbortController();
  private sequence = 0; private runSequence = 0; private reminderSequence = 0;
  private suspended = false; private lastStart = -Infinity; private starts: number[] = [];
  private stoppedUntil = 0;
  private overflowed = new Set<string>();
  readonly metrics = { observed: 0, unchanged: 0, queued: 0, merged: 0, overflow: 0, expired: 0, delivered: 0, interrupted: 0, skipped: 0, modelBatches: 0, sourceFailures: 0 };
  constructor(readonly limits: TaskLimits = taskLimits, private now: () => number = Date.now,
    private outcome: (owner: string, receipt: Record<string, unknown>) => void = () => {}, private random: () => number = Math.random) {}

  create(owner: string, event: number, definition: TaskDefinition, reminder = false): ScheduledTask | undefined {
    if (this.lifetime.signal.aborted || !validTaskDefinition(definition) || this.tasks.size >= this.limits.maxTasks
      || [definition.trigger, ...definition.conditions ?? []].some(t => 'source' in t && !this.eventSources.has(t.source) && !this.sources.has(t.source))) return;
    const task = this.build(owner, event, definition, reminder ? `r${++this.reminderSequence}` : `t${++this.sequence}`, 1);
    this.tasks.set(task.id, task); this.includeCurrent(task);
    return structuredClone(task);
  }
  private build(owner: string, event: number, definition: TaskDefinition, id: string, revision: number): ScheduledTask {
    const input = structuredClone(definition), at = this.now();
    const task: ScheduledTask = { ...input, intent: safeText(input.intent, 600), ...(input.text ? { text: safeText(input.text, 600) } : {}),
      id, owner, event, revision,
      createdAt: at, expiresAt: input.expiresSeconds === undefined ? Infinity : at + input.expiresSeconds * 1000, paused: false, lastDeliveryAt: -Infinity, latched: false };
    task.tools ??= ['search', 'activity', 'members'];
    task.pending ??= task.trigger.kind === 'change' ? 'all' : 'latest';
    if (task.trigger.kind === 'once' || task.trigger.kind === 'interval') { task.nextAt = at + task.trigger.seconds * 1000 + this.jitter(task); task.nextIndex = 1; }
    if (task.trigger.kind === 'daily') task.nextAt = nextDaily(task.trigger, at);
    return task;
  }
  private includeCurrent(task: ScheduledTask) {
    if (task.trigger.kind === 'change' && task.trigger.includeCurrent) {
      for (const observation of this.observations.values()) if (this.matches(task.trigger, observation) && observation.available !== false) this.enqueue(task, this.now(), observation);
    }
  }
  list() { return [...this.tasks.values()].map(t => {
    const runs = [...this.runs.values()].filter(r => r.task === t.id);
    return { ...structuredClone(t), pendingRuns: runs.length, state: t.paused ? 'paused' : runs.some(r => r.state === 'waiting') ? 'waiting' : runs.length ? 'pending' : 'scheduled' };
  }); }
  sourceNames() { return [...new Set([...this.eventSources, ...this.sources.keys()])]; }
  get(id: string) { const task = this.tasks.get(id); return task && structuredClone(task); }
  manage(id: string, op: 'pause' | 'resume' | 'cancel' | 'update', definition?: TaskDefinition): boolean {
    const task = this.tasks.get(id);
    if (!task || this.lifetime.signal.aborted || op === 'update' && (!validTaskDefinition(definition)
      || [definition!.trigger, ...definition!.conditions ?? []].some(t => 'source' in t && !this.eventSources.has(t.source) && !this.sources.has(t.source)))) return false;
    this.clearRuns(id, 'canceled'); task.revision++;
    this.tasks.set(id, task);
    if (op === 'cancel') { this.tasks.delete(id); return true; }
    if (op === 'update') {
      const replacement = this.build(task.owner, task.event, definition!, task.id, task.revision);
      this.tasks.set(id, replacement); this.includeCurrent(replacement); return true;
    }
    task.paused = op === 'pause'; task.heldSince = undefined; task.latched = false;
    if (op === 'resume' && task.trigger.kind === 'once') task.nextAt = this.now() + task.trigger.seconds * 1000;
    return true;
  }
  private jitter(task: ScheduledTask) { return task.trigger.kind === 'interval' ? Math.floor((this.random() * 2 - 1) * (task.trigger.jitterSeconds ?? 0) * 1000) : 0; }
  private matches(trigger: { source: string; subject?: string }, observation: TaskObservation) {
    return trigger.source === observation.source && (trigger.subject === undefined || trigger.subject === observation.subject);
  }
  observe(input: TaskObservation) {
    if (this.lifetime.signal.aborted || !sourceName.test(input.source) || typeof input.key !== 'string' || input.key.length > 500
      || input.subject !== undefined && (typeof input.subject !== 'string' || input.subject.length > 40)
      || !input.data || typeof input.data !== 'object' || Array.isArray(input.data)
      || input.at !== undefined && (!Number.isFinite(input.at) || input.at > this.now() + 1000)) return;
    const data = Object.fromEntries(Object.entries(input.data).slice(0, 12).filter(([k, v]) => /^[a-zA-Z][\w.-]{0,39}$/.test(k) && scalar(v))
      .map(([k, v]) => [k, typeof v === 'string' ? safeText(v, 200) : v]));
    const observation: TaskObservation = { source: input.source, subject: input.subject, key: input.key, data,
      at: input.at ?? this.now(), available: input.available !== false };
    const key = JSON.stringify([input.source, input.subject ?? '']);
    const previous = this.observations.get(key);
    if (previous && observation.at! < previous.at!) return;
    if (!previous && this.observations.size >= 128) { this.metrics.overflow++; return; }
    this.observations.set(key, observation); this.metrics.observed++;
    // Availability returning does not invent another playback of the same key.
    const changed = !previous || previous.key !== observation.key;
    if (!changed) this.metrics.unchanged++;
    if (this.suspended) return;
    for (const task of this.tasks.values()) {
      if (task.paused || task.expiresAt <= this.now()) continue;
      if (changed && task.trigger.kind === 'change' && this.matches(task.trigger, observation) && observation.available) this.enqueue(task, this.now(), observation);
      if (task.trigger.kind === 'condition' && this.matches(task.trigger, observation) && !this.condition(task.trigger)) {
        task.heldSince = undefined; task.latched = false; this.clearRuns(task.id, 'condition_ended');
      }
    }
  }
  registerSource(source: TaskSource) {
    if (!sourceName.test(source.name) || !Number.isInteger(source.intervalMs) || source.intervalMs < 1000 || source.intervalMs > 3600000
      || this.sources.size >= 16 || this.sources.has(source.name) || this.lifetime.signal.aborted) throw new Error('Invalid or duplicate task source.');
    this.sources.set(source.name, { source, nextAt: this.now(), failures: 0 });
  }
  registerEventSource(name: string) {
    if (!sourceName.test(name) || this.eventSources.size >= 32 || this.lifetime.signal.aborted) throw new Error('Invalid task event source.');
    this.eventSources.add(name);
  }
  private poll() {
    for (const state of this.sources.values()) {
      if (state.active || state.nextAt > this.now()) continue;
      const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(Math.min(15000, state.source.intervalMs))]);
      // Retain the slot until the actual source settles, even if it ignores abort.
      state.active = Promise.resolve().then(() => { signal.throwIfAborted(); return state.source.poll(signal); }).then(values => {
        signal.throwIfAborted(); state.failures = 0;
        for (const observation of values.slice(0, 128)) if (observation.source === state.source.name) this.observe(observation);
      }).catch(() => {
        if (!this.lifetime.signal.aborted) { state.failures++; this.metrics.sourceFailures++; }
      }).finally(() => {
        state.nextAt = this.now() + Math.max(state.source.intervalMs, Math.min(300000, state.source.intervalMs * 2 ** Math.min(state.failures, 8))); state.active = undefined;
      });
    }
  }
  private condition(condition: TaskCondition): boolean {
    return [...this.observations.values()].some(o => o.available !== false && this.matches(condition, o)
      && (condition.field ? o.data[condition.field] : o.key) === condition.equals);
  }
  private eligible(task: ScheduledTask, env: TaskEnvironment) {
    if (this.suspended || task.paused || task.expiresAt <= this.now() || !env.members.has(task.owner) || !env.listeners.has(task.owner)) return false;
    if (!task.conditions?.every(c => this.condition(c)) && task.conditions?.length) return false;
    if (task.trigger.kind === 'condition' && !this.condition(task.trigger)) return false;
    if (task.trigger.kind === 'silence') {
      const recent = task.recentHumanSeconds ?? 900;
      if (env.humanSpeaking || !env.lastHumanAt || this.now() - env.lastHumanAt < task.trigger.seconds * 1000
        || recent > 0 && this.now() - env.lastHumanAt > recent * 1000) return false;
    }
    return true;
  }
  tick(env: TaskEnvironment) {
    if (this.lifetime.signal.aborted) return;
    if (!this.suspended) this.poll();
    for (const run of [...this.runs.values()]) if (run.expiresAt <= this.now()) this.finish(run, 'expired');
    for (const task of [...this.tasks.values()]) {
      if (task.expiresAt <= this.now()) { this.clearRuns(task.id, 'expired'); this.tasks.delete(task.id); continue; }
      if (task.paused || this.suspended) continue;
      if (task.trigger.kind === 'silence') {
        if (env.humanSpeaking || env.lastHumanAt > (task.heldSince ?? 0)) {
          task.latched = false; task.heldSince = env.lastHumanAt; this.clearRuns(task.id, 'silence_ended');
        }
        if (!task.latched && this.eligible(task, env)) { this.enqueue(task, this.now()); task.latched = true; }
      } else if (task.trigger.kind === 'condition') {
        if (!this.condition(task.trigger)) { task.heldSince = undefined; task.latched = false; this.clearRuns(task.id, 'condition_ended'); }
        else {
          task.heldSince ??= this.now();
          if (!task.latched && this.now() - task.heldSince >= task.trigger.seconds * 1000) { this.enqueue(task, this.now()); task.latched = true; }
        }
      } else if (task.nextAt !== undefined && task.nextAt <= this.now()) {
        const due = task.nextAt;
        if (task.trigger.kind === 'interval') {
          const period = task.trigger.seconds * 1000;
          // Anchor to creation rather than model completion or previous jitter.
          task.nextIndex = Math.max((task.nextIndex ?? 1) + 1, Math.floor((this.now() - task.createdAt) / period) + 1);
          task.nextAt = task.createdAt + task.nextIndex * period + this.jitter(task);
          if (task.nextAt <= this.now()) { task.nextIndex++; task.nextAt += period; }
        } else if (task.trigger.kind === 'daily') task.nextAt = nextDaily(task.trigger, this.now());
        else task.nextAt = undefined;
        this.enqueue(task, due);
      }
    }
  }
  private enqueue(task: ScheduledTask, dueAt: number, observation?: TaskObservation) {
    const existing = [...this.runs.values()].filter(r => r.task === task.id);
    // One active run plus at most one pending aggregate per task. Observations
    // remain distinct inside the aggregate, including a later replay of a song.
    const pending = existing.find(r => r.state === 'pending');
    if (pending) {
      pending.merged++; this.metrics.merged++;
      if (observation) pending.observationVersion++;
      if (observation && task.pending === 'all') {
        if (pending.observations.length < this.limits.maxObservations) pending.observations.push(structuredClone(observation));
        else {
          this.metrics.overflow++; pending.dropped++;
          if (pending.dropped === 1) this.outcome(task.owner, { tool: 'tasks', status: 'overflow', id: task.id, run: pending.id, dropped: 1 });
        }
      } else if (observation) pending.observations = [structuredClone(observation)];
      return;
    }
    if (this.runs.size >= this.limits.maxPending) {
      this.metrics.overflow++;
      if (!this.overflowed.has(task.id)) { this.overflowed.add(task.id); this.outcome(task.owner, { tool: 'tasks', status: 'overflow', id: task.id, dropped: 1 }); }
      return;
    }
    this.overflowed.delete(task.id);
    const run: TaskRun = { id: `o${++this.runSequence}`, task: task.id, revision: task.revision, owner: task.owner, dueAt,
      expiresAt: this.now() + this.limits.runLifetimeMs, state: 'pending', notBefore: this.now(),
      observations: observation ? [structuredClone(observation)] : [], receipts: [], merged: 1,
      steps: 0, searches: [], toolsStarted: new Set(), effect: false, dropped: 0, writeAttempted: false,
      observationVersion: observation ? 1 : 0, describedVersion: -1, observationCursor: 0, receiptCursor: 0, introduced: false, abort: new AbortController() };
    this.runs.set(run.id, run); this.metrics.queued++;
  }
  claim(env: TaskEnvironment, foreground = false): TaskRun[] {
    if (this.suspended || this.lifetime.signal.aborted || this.now() < this.stoppedUntil || env.humanSpeaking) return [];
    this.starts = this.starts.filter(t => this.now() - t < 3600000);
    const candidates = [...this.runs.values()].filter(run => {
      const task = this.tasks.get(run.task);
      return task && run.state === 'pending' && run.notBefore <= this.now() && run.expiresAt > this.now() && this.eligible(task, env)
        && this.now() - task.lastDeliveryAt >= (task.cooldownSeconds ?? 5) * 1000
        && ![...this.runs.values()].some(r => r.task === task.id && r.state !== 'pending');
    }).sort((a, b) => Number(this.tasks.get(b.task)!.delivery === 'prepared') - Number(this.tasks.get(a.task)!.delivery === 'prepared') || a.dueAt - b.dueAt);
    if (!candidates.length) return [];
    const canModel = foreground || this.now() - this.lastStart >= this.limits.modelIntervalMs && this.starts.length < this.limits.hourlyModelLimit;
    const canSpeak = foreground || this.now() - env.lastBotAt >= this.limits.speechCooldownMs;
    const selectedTasks = new Set<string>();
    const selected = candidates.filter(r => {
      const prepared = this.tasks.get(r.task)!.delivery === 'prepared';
      if (selectedTasks.has(r.task) || !(prepared || canModel) || !(prepared || canSpeak)) return false;
      selectedTasks.add(r.task); return true;
    }).slice(0, this.limits.maxBatch);
    // A pure prepared batch bypasses inference. Don't mix optional generated
    // banter into it and turn a cheap reminder into an expensive model call.
    const direct = !foreground && selected.some(r => this.tasks.get(r.task)!.delivery === 'prepared');
    let chars = 0;
    const batch = direct ? selected.filter(r => {
      const task = this.tasks.get(r.task)!;
      if (task.delivery !== 'prepared' || chars > 0 && chars + task.text!.length + 42 > 650) return false;
      chars += task.text!.length + 42; return true;
    }) : selected;
    for (const run of batch) { run.state = 'leased'; run.steps++; run.toolsStarted.clear(); }
    if (batch.length && !direct) { this.lastStart = this.now(); this.starts.push(this.now()); this.metrics.modelBatches++; }
    return batch;
  }
  bind(run: TaskRun, event: number) {
    if (this.runs.get(run.id) !== run || run.state !== 'leased') throw new Error('Run is not leased.');
    run.event = event;
  }
  describe(run: TaskRun) {
    const task = this.tasks.get(run.task)!;
    const observations = task.pending === 'all' ? run.observations.slice(run.observationCursor)
      : run.observationVersion !== run.describedVersion ? run.observations : [];
    const description = { tool: 'tasks', status: 'due', id: task.id, run: run.id, revision: task.revision,
      ...(!run.introduced ? { intent: task.intent, delivery: task.delivery ?? 'model', ...(task.text ? { text: task.text } : {}), tools: task.tools } : {}),
      merged: run.merged, dropped: run.dropped, observations: observations.map(({ source, data, at }) => ({ source, data, ageMs: this.now() - at! })),
      receipts: run.receipts.slice(run.receiptCursor), remainingSteps: this.limits.maxSteps - run.steps };
    // The room journals each description before inference; even a canceled
    // request retains that event/prefix, so subsequent admissions need deltas only.
    run.introduced = true; run.observationCursor = run.observations.length; run.describedVersion = run.observationVersion; run.receiptCursor = run.receipts.length;
    return description;
  }
  grant(id: string, event: number, tool: TaskTool, env: TaskEnvironment): TaskGrant | undefined {
    const run = this.runs.get(id), task = run && this.tasks.get(run.task);
    if (!run || !task || run.event !== event || run.state !== 'leased' || run.revision !== task.revision || run.abort.signal.aborted
      || run.expiresAt <= this.now() || !this.eligible(task, env) || !task.tools?.includes(tool) || run.toolsStarted.has(tool)
      || tool === 'message' && run.writeAttempted) return;
    run.toolsStarted.add(tool);
    return { run, task, signal: AbortSignal.any([this.lifetime.signal, run.abort.signal]) };
  }
  waiting(grant: TaskGrant) { if (this.runs.get(grant.run.id) === grant.run) grant.run.state = 'waiting'; }
  toolResult(grant: TaskGrant, receipt: Record<string, unknown>) {
    const run = grant.run, task = this.tasks.get(run.task);
    if (this.runs.get(run.id) !== run || !task || run.revision !== task.revision || run.abort.signal.aborted) return;
    run.receipts.push(receipt); // At most one per model step; the run has a hard step limit.
    if (receipt.tool === 'message' && run.writeAttempted && receipt.status !== 'sent') { this.finish(run, 'delivery_unknown'); return; }
    run.effect ||= receipt.status === 'sent';
    run.state = 'pending'; run.notBefore = this.now() + (receipt.status === 'cooldown' ? 30000 : 0);
    run.event = undefined;
    if (run.steps >= this.limits.maxSteps) this.finish(run, run.effect ? 'delivered' : 'step_limit');
  }
  valid(run: TaskRun, env: TaskEnvironment) {
    const task = this.tasks.get(run.task);
    return this.runs.get(run.id) === run && !!task && run.revision === task.revision && !run.abort.signal.aborted
      && run.expiresAt > this.now() && this.eligible(task, env);
  }
  release(batch: TaskRun[], results: TaskResult[], delivery: 'complete' | 'interrupted' | 'none', spoke: boolean) {
    for (const run of batch) {
      if (this.runs.get(run.id) !== run) continue;
      const result = results.find(r => r.run === run.id);
      if (result?.status === 'skip') { this.finish(run, 'skipped'); continue; }
      if (result?.status === 'done' && run.state === 'leased' && (delivery !== 'none' || run.effect)) { this.finish(run, delivery === 'interrupted' ? 'interrupted' : 'delivered'); continue; }
      // Spoken output without per-task accounting has an uncertain semantic
      // outcome. Record it, but never turn missing metadata into repeated audio.
      if (!result && spoke && delivery === 'complete' && run.state === 'leased') { this.finish(run, 'unconfirmed'); continue; }
      // Never replay uncertain/partial audio, even if the model omitted results.
      if (delivery === 'interrupted' && spoke) { this.finish(run, 'interrupted'); continue; }
      if (run.state !== 'leased') continue; // Task I/O has its own lifetime.
      if (run.steps >= this.limits.maxSteps) { this.finish(run, 'step_limit'); continue; }
      run.state = 'pending'; run.event = undefined;
      run.notBefore = this.now() + (result?.status === 'defer' ? (result.seconds ?? 15) * 1000 : Math.min(60000, 5000 * 2 ** (run.steps - 1)));
    }
  }
  directResults(batch: TaskRun[]): TaskResult[] { return batch.map(r => ({ run: r.id, status: 'done' })); }
  private finish(run: TaskRun, status: string) {
    this.runs.delete(run.id); run.abort.abort();
    const task = this.tasks.get(run.task);
    if (status === 'delivered' || status === 'interrupted') { if (task) task.lastDeliveryAt = this.now(); this.metrics[status]++; }
    else if (status === 'expired') this.metrics.expired++;
    else this.metrics.skipped++;
    this.outcome(run.owner, { tool: 'tasks', status, id: run.task, run: run.id, merged: run.merged });
    if (task?.trigger.kind === 'once' && task.nextAt === undefined) this.tasks.delete(task.id);
  }
  private clearRuns(id: string, status: string) { for (const run of [...this.runs.values()]) if (run.task === id) this.finish(run, status); }
  stop() {
    for (const run of [...this.runs.values()]) this.finish(run, 'stopped');
    for (const task of this.tasks.values()) if (task.trigger.kind === 'silence') task.latched = true;
    this.stoppedUntil = this.now() + this.limits.speechCooldownMs;
  }
  suspend(value: boolean) { this.suspended = value; if (value) this.stop(); }
  close() { this.lifetime.abort(); this.suspended = true; for (const run of this.runs.values()) run.abort.abort(); this.runs.clear(); this.tasks.clear(); this.observations.clear(); this.sources.clear(); this.overflowed.clear(); }
  async settleSources() { await Promise.allSettled([...this.sources.values()].flatMap(s => s.active ? [s.active] : [])); }
}
