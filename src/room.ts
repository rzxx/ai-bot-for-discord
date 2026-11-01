import { t, translate, withLocale } from './locale';
import type { Config } from './config';
import { safeError, log } from './config';
import { InferenceError } from './inference-error';
import { toDiscordPCM, toSTTWav, type Utterance } from './audio';
import type { Brain, Member, MemberState, TurnEvent, RoomSnapshot } from './llm';
import { ContextLimitError } from './context';
import { RoomTools, type ToolHost, type ToolReceipt } from './room-tools';
import { safeName, safeText } from './tool-safety';
import type { Transcriber, Speaker } from './speech';
import { TaskQueue } from './queue';
import { VoiceOutput } from './voice-output';
import { latency, type LatencyRecord, type DiagnosticFields } from './telemetry';
import { speechIntent, thinkingCueText, type SpeechIntent } from './conversation';
import { trimSpeechPadding } from './speech-cadence';
import type { Reporting, ReportSeed } from './reporting';
import { TaskRuntime, taskLimits, type TaskEnvironment, type TaskRun, type TaskResult } from './tasks';
import { TaskPresence } from './task-presence';

export interface Playback { completed: boolean; playedMs: number; startedAt?: number; endedAt?: number; error?: Error; streamWaitMs?: number }
export interface PlaybackHooks { beforeStart?: () => Promise<void>; onStart?: (at: number) => void; onTiming?: (stage: string, elapsedMs: number, chunk: number) => void; onDiagnostic?: (stage: string, fields: DiagnosticFields) => void }
export interface Player {
  play(pcm: Buffer, signal: AbortSignal, hooks?: PlaybackHooks): Promise<Playback>;
  playStream?(chunks: AsyncIterable<Buffer>, signal: AbortSignal, hooks?: PlaybackHooks): Promise<Playback>;
  stop(): void;
}
export type RoomPhase = 'idle' | 'thinking' | 'synthesizing' | 'ready' | 'speaking' | 'paused' | 'closed';
interface PreparedTurn {
  abort: AbortController; ids: number[]; sources: Set<string>; started: number;
  addressed: boolean; audible: boolean; answerReady: boolean; superseded: boolean;
  cueAbort?: AbortController; cueTask?: Promise<void>; cueTimer?: ReturnType<typeof setTimeout>; cueStarted?: boolean;
  taskRuns?: TaskRun[]; taskOnly?: boolean;
}
class FloorUnavailable extends Error {}
interface RoomOptions {
  tools?: ToolHost;
  reporting?: Reporting;
  canUseContext?: () => boolean;
  modelOnly?: boolean; // Controlled model benchmarks must exercise silence/local-check cases too.
  now?: () => number;
  autoTick?: boolean;
  convertInput?: (pcm: Buffer, signal: AbortSignal) => Promise<Buffer>;
  convertOutput?: (wav: Buffer, signal: AbortSignal) => Promise<Buffer>;
  trace?: (record: LatencyRecord) => void;
}

export class RoomController {
  private t = (message: string, ...values: unknown[]) => translate(this.config.locale, message, ...values);
  readonly sessionId = crypto.randomUUID();
  readonly members = new Map<string, Member>();
  readonly events: TurnEvent[] = [];
  readonly tools?: RoomTools;
  readonly tasks: TaskRuntime;
  readonly presence: TaskPresence;
  private states = new Map<string, MemberState>();
  private lastChat = new Map<string, number>();
  private followups = new Map<number, { source: number; expires: number; transient: boolean }>();
  private latestMeaningfulSpeech = 0;
  phase: RoomPhase = 'idle';
  pendingSTT = 0;
  readonly diagnostics = { utterances: 0, transcripts: 0, emptyTranscripts: 0, sttErrors: 0, modelCalls: 0, modelPasses: 0, staleReplies: 0, spokenReplies: 0, localReplies: 0, earlyEndpoints: 0, previewStt: 0, backchannels: 0, revisions: 0, yieldedReplies: 0, withheldReplies: 0, thinkingCues: 0, lastSttMs: 0, lastModelMs: 0, lastFirstTextMs: 0, lastFirstAudioMs: 0, lastTtsMs: 0, lastError: '' };
  private active = new Set<string>();
  private lastHumanAt = 0;
  private lastPlaybackAt = 0;
  private lastAudibleAt = 0;
  private sequence = 0;
  private consumedThrough = 0;
  private epoch = 0;
  private stoppedAt = 0;
  private current?: AbortController;
  private preparing?: PreparedTurn;
  private turnSequence = 0;
  private pendingIntents = new Map<number, SpeechIntent>();
  private lastVoice = new Map<string, number>();
  private recognizing = new Map<string, number>();
  private previews = new Map<string, { startedAt: number; endedAt: number; epoch: number; text: Promise<string | undefined> }>();
  private lastCueAt = -Infinity;
  private cueCache?: { key: string; pcm: Buffer };
  private busy = false;
  private timer?: ReturnType<typeof setInterval>;
  private readonly now: () => number;
  private readonly startedAt: number;
  private readonly convertInput: (pcm: Buffer, signal: AbortSignal) => Promise<Buffer>;
  private readonly convertOutput: (wav: Buffer, signal: AbortSignal) => Promise<Buffer>;
  private readonly trace: (record: LatencyRecord) => void;
  private readonly modelOnly: boolean;
  private readonly canUseContext: () => boolean;
  private transcriptions = new Set<AbortController>();
  private lastNoticeAt = 0;
  private lastWaitTraceAt = 0;
  private previousTranscript = new Map<string, { text: string; end: number }>();
  private reporting?: Reporting;
  constructor(readonly config: Config, readonly brain: Brain, readonly transcriber: Transcriber,
    readonly speaker: Speaker, readonly player: Player, readonly queue: TaskQueue,
    private notify: (message: string) => void, options: RoomOptions = {}) {
    this.now = options.now ?? Date.now;
    this.startedAt = this.now();
    this.convertInput = options.convertInput ?? toSTTWav;
    this.convertOutput = options.convertOutput ?? toDiscordPCM;
    this.trace = options.trace ?? latency;
    this.modelOnly = options.modelOnly ?? false;
    this.canUseContext = () => (options.canUseContext?.() ?? true) && (options.tools?.chat?.canUseContext() ?? true);
    this.reporting = config.reportTools ? options.reporting : undefined;
    this.tasks = new TaskRuntime({ ...taskLimits, maxTasks: config.taskMaxTasks, maxPending: config.taskMaxPending,
      modelIntervalMs: config.taskModelIntervalSeconds * 1000, hourlyModelLimit: config.taskHourlyModelLimit,
      speechCooldownMs: config.taskSpeechCooldownSeconds * 1000 }, this.now, (owner, receipt) => {
        if (this.phase !== 'closed') this.add({ kind: 'tool', userId: owner, text: JSON.stringify(receipt) });
        this.trace({ session: this.sessionId, stage: 'task_outcome', status: String(receipt.status) });
      });
    this.presence = new TaskPresence(observation => this.tasks.observe(observation), this.now);
    if (options.tools) this.tools = new RoomTools(config, options.tools, id => this.members.has(id), (owner, receipt, wake) => this.toolReceipt(owner, receipt, wake), this.now,
      (stage, fields) => this.trace({ session: this.sessionId, stage, ...fields }), this.tasks, () => this.taskEnvironment());
    void this.brain.warm?.(this.sessionId).catch(() => {});
    if (options.autoTick !== false) this.timer = setInterval(() => { void this.tick(); }, 100);
  }
  setMember(member: Member) {
    member = { ...member, name: safeName(member.name) };
    const previous = this.members.get(member.id);
    if (!previous) this.tools?.cancelBackground();
    this.members.set(member.id, { ...member });
    if (!previous) {
      this.add({ kind: 'join', userId: member.id, name: member.name, text: this.t("Joined the voice channel.") });
      this.tasks.observe({ source: 'voice.join', subject: member.id, key: String(this.sequence), data: { name: member.name } });
    }
    else if (previous.name !== member.name) this.add({ kind: 'rename', userId: member.id, name: member.name, text: this.t("Previous name: {0}", previous.name) });
    if (!this.canUseContext()) { this.pause(); this.notice(this.t("A VC participant cannot access the chat context. Replies paused; check channel permissions before /resume.")); }
  }
  removeMember(id: string) {
    const member = this.members.get(id);
    if (!member) return;
    this.tools?.cancelBackground();
    this.members.delete(id); this.states.delete(id); this.active.delete(id); this.lastVoice.delete(id); this.previews.delete(id);
    for (const event of this.events) if (event.userId === id) this.pendingIntents.delete(event.id);
    this.add({ kind: 'leave', userId: id, name: member.name, text: this.t("Left the voice channel.") });
    this.tasks.observe({ source: 'voice.leave', subject: id, key: String(this.sequence), data: { name: member.name } });
    this.presence.update(id, null, ''); this.presence.forget(id);
    this.invalidateTasks();
  }
  setState(state: MemberState) {
    if (this.members.has(state.userId)) this.states.set(state.userId, { ...state, status: safeText(state.status ?? '', 16), activity: safeText(state.activity ?? '', 160) });
  }
  chat(member: Member, text: string, at = this.now()) {
    if (this.phase === 'closed' || this.phase === 'paused' || at < this.startedAt || text.length > 2000
      || at - (this.lastChat.get(member.id) ?? -Infinity) < 1000
      || this.events.filter(e => e.kind === 'chat' && e.id > (this.contextMetrics?.submittedThroughEventId ?? 0)).length >= 20) return;
    const clean = safeText(text, 320);
    if (!clean) return;
    this.lastChat.set(member.id, at);
    this.add({ at, kind: 'chat', userId: member.id, name: safeName(member.name), text: clean });
    this.tasks.observe({ source: 'chat', subject: member.id, key: String(this.sequence), at, data: { text: clean.slice(0, 200), name: safeName(member.name) } });
  }
  private toolReceipt(owner: string, receipt: ToolReceipt, wake: boolean) {
    if (this.phase === 'closed') return;
    this.reporting?.toolFailure(receipt, { session: this.sessionId, turn: this.turnSequence, events: [receipt.event] },
      this.reportEvidence().filter(e => e.event === receipt.event));
    this.add({ kind: 'tool', userId: owner, name: this.members.get(owner)?.name, text: JSON.stringify(receipt) });
    const event = this.sequence;
    const dueReminder = receipt.tool === 'remind' && receipt.status === 'due';
    this.trace({ session: this.sessionId, stage: 'tool_receipt', tool: receipt.tool, sourceEvent: receipt.event,
      receiptEvent: event,
      status: receipt.status, bytes: Buffer.byteLength(JSON.stringify(receipt)), wakeRequested: wake,
      wakesModel: wake && this.phase !== 'paused' && (dueReminder || this.latestMeaningfulSpeech <= receipt.event) });
    if (!wake || this.phase === 'paused' || !dueReminder && this.latestMeaningfulSpeech > receipt.event) return;
    this.followups.set(event, { source: receipt.event, expires: this.now() + (dueReminder ? 60000 : 12000), transient: !dueReminder });
    this.pendingIntents.set(event, { kind: 'request', addressed: false, complete: true, detailed: false, stop: false, normalized: '' });
  }
  manageTask(actor: string, id: string, op: 'pause' | 'resume' | 'cancel'): boolean {
    const result = this.tasks.manage(id, op);
    if (result) {
      this.add({ kind: 'tool', userId: actor, text: JSON.stringify({ tool: 'tasks', id, status: op === 'cancel' ? 'canceled' : op === 'pause' ? 'paused' : 'resumed' }) });
      this.invalidateTasks();
    }
    return result;
  }
  activity(id: string, speaking: boolean, at = this.now()) {
    if (this.phase === 'closed') return;
    if (speaking) this.preparing?.cueAbort?.abort(); // Optional thinking sounds yield to any real speech.
    if (speaking && this.preparing?.taskOnly) this.yieldProactive();
    if (speaking) { this.active.add(id); this.lastHumanAt = Math.max(at, this.lastHumanAt); }
    else { this.active.delete(id); this.lastHumanAt = Math.max(at, this.lastHumanAt); }
    this.lastVoice.set(id, Math.max(at, this.lastVoice.get(id) ?? 0));
    this.tasks.tick(this.taskEnvironment());
    this.updateReporting();
  }
  /** Optional batch-ASR probe at a short pause. No provisional transcript enters
   * history. The gate atomically accepts it only if no new voiced frame arrived. */
  preview(member: Member, utterance: Utterance, accept: (text: string) => boolean) {
    if (this.phase === 'closed' || this.phase === 'paused' || this.config.sttEngine !== 'gigaam' || this.queue.length || utterance.startedAt < this.stoppedAt) return;
    const epoch = this.epoch, abort = new AbortController();
    this.transcriptions.add(abort); this.pendingSTT++; this.diagnostics.previewStt++;
    this.updateReporting();
    this.recognizing.set(member.id, (this.recognizing.get(member.id) ?? 0) + 1);
    const began = this.now();
    const text = this.queue.submit(async () => {
      abort.signal.throwIfAborted();
      const wav = await this.convertInput(utterance.pcm, abort.signal);
      return this.transcriber.transcribe(wav, [...this.members.values()].map(m => m.name), abort.signal);
    }).then(text => {
      if (this.epoch !== epoch || abort.signal.aborted) return undefined;
      const intent = speechIntent(text, this.config.botName, this.members.values(), this.config.speechLanguage);
      const accepted = !!text && intent.complete && intent.kind !== 'elsewhere' && accept(text);
      if (accepted) this.diagnostics.earlyEndpoints++;
      this.trace({ session: this.sessionId, stage: 'endpoint_preview', elapsedMs: this.now() - began, accepted, sinceSpeechEndMs: this.now() - utterance.endedAt });
      return text;
    }).catch(() => undefined).finally(() => {
      this.transcriptions.delete(abort); this.pendingSTT--;
      this.updateReporting();
      this.recognizing.set(member.id, Math.max(0, (this.recognizing.get(member.id) ?? 1) - 1));
    });
    this.previews.set(member.id, { startedAt: utterance.startedAt, endedAt: utterance.endedAt, epoch, text });
  }
  ingest(member: Member, utterance: Utterance) {
    if (this.phase === 'closed' || this.phase === 'paused' || utterance.startedAt < this.stoppedAt) return;
    const epoch = this.epoch;
    this.pendingSTT++;
    this.updateReporting();
    this.recognizing.set(member.id, (this.recognizing.get(member.id) ?? 0) + 1);
    this.diagnostics.utterances++;
    const utteranceId = this.diagnostics.utterances;
    const capturedAt = this.now();
    const trace = (stage: string, extra: Partial<LatencyRecord> = {}) => this.trace({ session: this.sessionId, utterance: utteranceId, stage, ...extra });
    trace('utterance_ready', { captureMs: utterance.endedAt - utterance.startedAt, endpointMs: capturedAt - utterance.endedAt, queueDepth: this.queue.length });
    const abort = new AbortController();
    this.transcriptions.add(abort);
    const names = [...this.members.values()].map(m => m.name);
    const preview = this.previews.get(member.id);
    const reusable = preview?.epoch === epoch && preview.startedAt === utterance.startedAt && preview.endedAt === utterance.endedAt ? preview : undefined;
    const recognize = () => this.queue.submit(async () => {
      if (this.epoch !== epoch || this.phase === 'closed') return '';
      if (this.now() - capturedAt > 30000) throw new Error(this.t("Skipped stale audio: STT cannot keep up."));
      trace('stt_started', { queueMs: this.now() - capturedAt });
      const conversionBegan = this.now();
      const wav = await this.convertInput(utterance.pcm, abort.signal);
      trace('input_converted', { elapsedMs: this.now() - conversionBegan });
      const sttBegan = this.now();
      const text = await this.transcriber.transcribe(wav, names, abort.signal);
      this.diagnostics.lastSttMs = this.now() - sttBegan;
      trace('stt_completed', { elapsedMs: this.diagnostics.lastSttMs, sinceSpeechEndMs: this.now() - utterance.endedAt, chars: text.length });
      if (text) this.diagnostics.transcripts++; else this.diagnostics.emptyTranscripts++;
      log(this.t("Speech: STT {0} ms, {1} characters; queued {2}.", this.diagnostics.lastSttMs, text.length, this.pendingSTT - 1));
      return text;
    });
    void (async () => {
      let text = utterance.recognizedText ?? (reusable ? await reusable.text : undefined);
      if (text === undefined) text = await recognize();
      else { this.diagnostics.transcripts += Number(!!text); this.diagnostics.emptyTranscripts += Number(!text); trace('stt_reused', { sinceSpeechEndMs: this.now() - utterance.endedAt }); }
      if (this.epoch !== epoch || abort.signal.aborted) return;
      const previous = this.previousTranscript.get(member.id);
      if (utterance.overlap && previous && Math.abs(utterance.startedAt - previous.end) < 1500) {
        const before = previous.text.split(/\s+/), after = text.split(/\s+/);
        const normalize = (word: string) => word.toLowerCase().replaceAll('ё', 'е').replace(/[^\p{L}\p{N}]/gu, '');
        for (let count = Math.min(10, before.length, after.length); count >= 2; count--) {
          if (before.slice(-count).map(normalize).join(' ') === after.slice(0, count).map(normalize).join(' ')) { text = after.slice(count).join(' '); break; }
        }
      }
      if (this.epoch === epoch && text) {
        this.previousTranscript.set(member.id, { text, end: utterance.endedAt });
        const eventId = this.transcript(member, text, utterance.startedAt, utterance.endedAt);
        trace('transcript_submitted', { eventId });
      }
    })().catch(error => { trace('stt_failed', { aborted: abort.signal.aborted }); if (!abort.signal.aborted) {
      this.reporting?.failure('speech_recognition', error instanceof Error ? error.name : 'unknown', { session: this.sessionId, events: [] }, `${this.sessionId}:stt:${utteranceId}`);
      this.diagnostics.sttErrors++; this.diagnostics.lastError = `STT: ${safeError(error)}`; this.notice(this.diagnostics.lastError);
    } })
      .finally(() => { this.transcriptions.delete(abort); this.pendingSTT--; this.recognizing.set(member.id, Math.max(0, (this.recognizing.get(member.id) ?? 1) - 1)); this.updateReporting(); });
  }
  transcript(member: Member, text: string, at = this.now(), end = at) {
    if (this.phase === 'closed' || this.phase === 'paused' || at < this.stoppedAt || !text.trim()) return;
    this.reporting?.setForeground(this.sessionId, true);
    const intent = speechIntent(text, this.config.botName, this.members.values(), this.config.speechLanguage);
    if (intent.stop) { this.stop(); return; }
    if (this.preparing?.taskOnly) this.yieldProactive();
    this.add({ at, end, kind: 'speech', userId: member.id, name: member.name, text: text.trim().slice(0, 4000), attention: intent.kind });
    const eventId = this.sequence, turn = this.preparing;
    if (intent.kind !== 'backchannel') {
      const followupTurn = turn?.ids.some(id => this.followups.get(id)?.transient);
      this.latestMeaningfulSpeech = eventId;
      this.tools?.onSpeech(eventId);
      for (const [id, followup] of this.followups) if (followup.transient && eventId > followup.source) { this.pendingIntents.delete(id); this.followups.delete(id); }
      // A lookup correction already preparing must also yield to a new topic.
      if (turn && followupTurn) {
        for (const id of turn.ids) { this.pendingIntents.delete(id); this.followups.delete(id); }
        turn.abort.abort(); turn.superseded = true; this.player.stop();
      }
    }
    const duringPlayback = !!turn?.audible || this.events.some(e => (e.kind === 'assistant' || e.kind === 'interrupted') && (e.playedMs ?? 0) > 0 && e.at <= end && (e.end ?? e.at) >= at);
    this.lastHumanAt = Math.max(this.lastHumanAt, end);
    this.lastVoice.set(member.id, Math.max(end, this.lastVoice.get(member.id) ?? 0));
    this.trace({ session: this.sessionId, stage: 'speech_classified', eventId, intent: intent.kind, addressed: intent.addressed, complete: intent.complete });
    if (this.modelOnly) { this.pendingIntents.set(eventId, intent); return eventId; }
    if (intent.kind === 'backchannel' || intent.kind === 'elsewhere') {
      if (intent.kind === 'backchannel') this.diagnostics.backchannels++;
      return eventId;
    }
    const repeated = turn?.ids.some(id => speechIntent(this.events.find(e => e.id === id)?.text ?? '', this.config.botName, [], this.config.speechLanguage).normalized === intent.normalized);
    // Repeated connection checks and exact repeats while a reply is pending don't
    // become another spoken answer. Everything remains in the room journal.
    if (turn && !turn.audible && (repeated || intent.localReply && turn.sources.has(member.id))) return eventId;
    const continuation = turn && !turn.audible && turn.sources.has(member.id);
    const sideCorrection = turn && intent.kind === 'correction' && !intent.addressed && !turn.sources.has(member.id);
    if (!sideCorrection && ((!turn && !duringPlayback) || intent.kind !== 'comment' || intent.addressed || continuation)) this.pendingIntents.set(eventId, intent);
    if (turn && !turn.superseded && ((intent.kind === 'correction' && (intent.addressed || turn.sources.has(member.id)))
      || !turn.audible && (continuation || intent.addressed))) {
      turn.superseded = true;
      if (turn.audible) this.diagnostics.yieldedReplies++; else this.diagnostics.revisions++;
      this.trace({ session: this.sessionId, stage: turn.audible ? 'reply_yielded' : 'reply_revised', eventId });
      turn.abort.abort(); this.player.stop();
    }
    return eventId;
  }
  private add(event: Omit<TurnEvent, 'id' | 'at'> & { at?: number }) {
    this.events.push({ ...event, at: event.at ?? this.now(), id: ++this.sequence });
    this.prune();
  }
  private prune() {
    // Capture time defines chronology, not the order asynchronous STT completes.
    this.events.sort((a, b) => a.at - b.at || a.id - b.id);
    // This local journal is NOT provider history. Reclaim already-submitted,
    // consumed records without ever editing the append-only model prefix.
    const through = Math.min(this.consumedThrough, this.contextMetrics?.submittedThroughEventId ?? 0);
    for (let i = this.events.length - 1; i >= 0; i--) if (this.events[i]!.id <= through && !this.pendingIntents.has(this.events[i]!.id)) this.events.splice(i, 1);
  }
  get contextMetrics() { return this.brain.contextMetrics?.(this.sessionId); }
  get activeSpeakers() { return this.active.size; }
  private taskEnvironment(): TaskEnvironment {
    return { members: new Set(this.members.keys()), listeners: new Set([...this.members.keys()].filter(id => !this.states.get(id)?.deafened)),
      lastHumanAt: this.lastHumanAt, humanSpeaking: !!this.active.size || !!this.pendingSTT, lastBotAt: this.lastAudibleAt || -Infinity };
  }
  private yieldProactive() {
    const turn = this.preparing;
    if (!turn?.taskOnly) return;
    turn.superseded = true; turn.abort.abort(); this.player.stop();
  }
  private invalidateTasks() {
    const turn = this.preparing;
    if (turn?.taskRuns?.some(run => !this.tasks.valid(run, this.taskEnvironment()))) {
      turn.superseded = true; turn.abort.abort(); this.player.stop();
    }
  }
  private updateReporting() {
    this.reporting?.setForeground(this.sessionId, this.phase !== 'closed' &&
      (this.busy || !!this.active.size || !!this.pendingSTT || this.phase !== 'paused' && !!this.pendingIntents.size));
  }
  private reportEvidence(): ReportSeed['evidence'] {
    return this.events.filter(e => {
      if (e.kind === 'speech') return true;
      if (e.kind !== 'tool') return false;
      try { return JSON.parse(e.text).tool !== 'chat'; } catch { return false; }
    }).slice(-6)
      .map(e => ({ event: e.id, kind: e.kind as 'speech' | 'tool', text: e.text }));
  }
  snapshot(): RoomSnapshot {
    this.prune();
    return { sessionId: this.sessionId, members: [...this.members.values()].map(v => ({ ...v })), events: this.events.map(v => ({ ...v })), botName: this.config.botName, now: this.now(),
      states: [...this.states.values()], capabilities: [...(this.tools?.capabilities ?? []), ...(this.reporting ? ['report'] : [])],
      timeline: { sessionStartedAt: this.startedAt, quietForMs: Math.max(0, this.now() - Math.max(this.lastHumanAt, this.lastAudibleAt, this.startedAt)), sinceLastBotSpeechMs: this.lastAudibleAt ? this.now() - this.lastAudibleAt : null } };
  }
  get quiet() { return !this.active.size && !this.pendingSTT && this.now() - Math.max(this.lastHumanAt, this.lastPlaybackAt) >= this.config.roomQuietMs; }
  private sourceBusy(turn: PreparedTurn) {
    return [...turn.sources].some(id => this.active.has(id) || (this.recognizing.get(id) ?? 0) > 0);
  }
  private async waitForFloor(turn: PreparedTurn) {
    const began = this.now(), gap = Math.min(this.config.replyStartQuietMs, this.config.roomQuietMs);
    this.phase = 'ready';
    this.trace({ session: this.sessionId, stage: 'reply_ready' });
    const acquired = (forcedEntry: boolean) => this.trace({ session: this.sessionId, stage: 'floor_acquired', elapsedMs: this.now() - began, forcedEntry });
    for (;;) {
      turn.abort.signal.throwIfAborted();
      this.invalidateTasks(); turn.abort.signal.throwIfAborted();
      if (![...turn.sources].some(id => this.members.has(id))) throw new FloorUnavailable('Participant has left.');
      if (this.now() - turn.started > this.config.maxResponseAgeMs) { this.diagnostics.staleReplies++; throw new FloorUnavailable('Reply became stale before speech started.'); }
      const sourceQuiet = [...turn.sources].every(id => this.now() - (this.lastVoice.get(id) ?? 0) >= gap);
      if (!this.sourceBusy(turn) && sourceQuiet && !this.active.size && this.now() - this.lastHumanAt >= gap) { acquired(false); return; }
      if (this.now() - began >= this.config.replyFloorWaitMs && !this.sourceBusy(turn) && sourceQuiet) {
        // A directly addressed answer can take a short turn after waiting for an
        // opening, but it never cuts off its own questioner. Unsolicited speech yields.
        if (turn.addressed) { acquired(true); return; }
        // Keep the prepared text/audio. The next opening is sufficient; there
        // is no need for another question or another model request.
      }
      await new Promise<void>((resolve, reject) => {
        const signal = turn.abort.signal;
        const cancel = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); reject(signal.reason); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, 40);
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) cancel();
      });
    }
  }
  private async thinkingCue(turn: PreparedTurn, trace: (stage: string, extra?: Partial<LatencyRecord>) => void) {
    const cue = thinkingCueText(this.config.speechLanguage);
    if (!cue || turn.answerReady || turn.abort.signal.aborted || this.active.size || this.pendingSTT || this.now() - this.lastHumanAt < this.config.replyStartQuietMs
      || this.now() - this.lastCueAt < this.config.thinkingCueCooldownMs) return;
    const abort = new AbortController(); turn.cueAbort = abort;
    const signal = AbortSignal.any([abort.signal, turn.abort.signal]);
    let startedAt = 0;
    try {
      const key = JSON.stringify([cue, this.config.voice, this.config.pronunciations]);
      let pcm = this.cueCache?.key === key ? this.cueCache.pcm : undefined;
      if (!pcm) {
        const wav = await this.speaker.synthesize(cue, signal);
        pcm = trimSpeechPadding(await this.convertOutput(wav, signal)).subarray(0, 48000 * 4); // at most one second
        signal.throwIfAborted(); this.cueCache = { key, pcm };
      }
      if (turn.answerReady || this.active.size || this.pendingSTT) return;
      const played = await this.player.play(pcm, signal, {
        beforeStart: async () => { if (turn.answerReady || this.active.size || this.pendingSTT) throw new FloorUnavailable(); },
        onStart: at => { turn.cueStarted = true; startedAt = at; this.lastCueAt = at; this.diagnostics.thinkingCues++; trace('thinking_cue_audio'); },
        onDiagnostic: (stage, fields) => trace(stage, { ...fields, cue: true }),
      });
      if (played.playedMs > 0) {
        this.lastAudibleAt = played.endedAt ?? this.now();
        this.add({ kind: played.completed ? 'assistant' : 'interrupted', at: played.startedAt ?? startedAt, end: played.endedAt ?? this.now(), playedMs: played.playedMs,
          name: this.config.botName, text: played.completed ? cue : this.t("Thinking cue interrupted; the main answer has not been spoken.") });
      }
    } catch { trace('thinking_cue_skipped'); } // An optional cue must never fail a real answer.
  }
  async tick() {
    this.updateReporting();
    if (!this.members.size || this.phase === 'paused' || this.phase === 'closed') return;
    if (!this.canUseContext()) { this.pause(); this.notice(this.t("Chat context permissions changed. Replies paused.")); return; }
    this.tasks.tick(this.taskEnvironment());
    this.invalidateTasks();
    this.tools?.tick();
    for (const [id, followup] of this.followups) if (followup.expires < this.now()) { this.pendingIntents.delete(id); this.followups.delete(id); }
    const newSpeech = this.events.filter(e => this.pendingIntents.has(e.id));
    const urgent = newSpeech.some(e => {
      const intent = this.pendingIntents.get(e.id)!;
      return (intent.addressed || intent.kind !== 'comment') && !this.active.has(e.userId!) && !(this.recognizing.get(e.userId!) ?? 0);
    });
    const singleSpeakerReady = !this.active.size && !this.pendingSTT && this.now() - this.lastHumanAt >= this.config.prepareQuietMs
      && [...this.lastVoice.values()].filter(at => this.now() - at < 2000).length <= 1;
    if (this.busy || this.phase !== 'idle' || !this.quiet && !urgent && !singleSpeakerReady) {
      if (this.now() - this.lastWaitTraceAt >= 2000 && newSpeech.length) {
        this.lastWaitTraceAt = this.now();
        this.trace({ session: this.sessionId, stage: 'turn_waiting', phase: this.phase,
          reason: this.busy ? 'reply_in_progress' : this.active.size ? 'people_speaking' : this.pendingSTT ? 'transcribing' : 'quiet_window',
          activeSpeakers: this.active.size, pendingSTT: this.pendingSTT, quietForMs: this.now() - Math.max(this.lastHumanAt, this.lastPlaybackAt) });
      }
      return;
    }
    const taskOnly = !newSpeech.length;
    const taskBatch = this.tasks.claim(this.taskEnvironment(), !taskOnly);
    for (const run of taskBatch) {
      this.add({ kind: 'tool', userId: run.owner, text: JSON.stringify(this.tasks.describe(run)) });
      this.tasks.bind(run, this.sequence);
      this.pendingIntents.set(this.sequence, { kind: 'request', addressed: false, complete: true, detailed: false, stop: false, normalized: '' });
      newSpeech.push(this.events.find(e => e.id === this.sequence)!);
    }
    if (!newSpeech.length) return;
    const latest = Math.max(...newSpeech.map(e => e.end ?? e.at));
    const consumed = Math.max(...newSpeech.map(e => e.id));
    if (this.now() - latest > 45000) { for (const event of newSpeech) this.pendingIntents.delete(event.id); this.consumedThrough = consumed; this.notice(this.t("Skipped stale reply: conversation moved on.")); return; }
    this.busy = true;
    this.updateReporting();
    const abort = new AbortController(); this.current = abort;
    const epoch = this.epoch;
    const canSpeak = () => this.epoch === epoch && !abort.signal.aborted && this.members.size > 0 && this.canUseContext()
      && taskBatch.every(run => this.tasks.valid(run, this.taskEnvironment()));
    const started = this.now();
    const turn = ++this.turnSequence;
    const focused = newSpeech.filter(e => { const intent = this.pendingIntents.get(e.id)!; return intent.addressed || intent.kind !== 'comment'; });
    const prepared: PreparedTurn = { abort, ids: newSpeech.map(e => e.id), sources: new Set((focused.length ? focused : newSpeech).map(e => e.userId!)), started,
      addressed: newSpeech.some(e => this.pendingIntents.get(e.id)!.addressed), audible: false, answerReady: false, superseded: false,
      taskRuns: taskBatch, taskOnly: taskOnly && !!taskBatch.length };
    this.preparing = prepared;
    const directTasks = taskOnly && taskBatch.length > 0 && taskBatch.every(r => this.tasks.get(r.task)?.delivery === 'prepared');
    const localReply = directTasks ? taskBatch.map(r => {
      const name = this.members.get(r.owner)?.name ?? '', text = this.tasks.get(r.task)!.text!;
      return name && !text.startsWith(name) ? `${name}, ${text}` : text;
    }).join(' ')
      : !taskBatch.length && !this.modelOnly && newSpeech.length === 1 ? this.pendingIntents.get(newSpeech[0]!.id)!.localReply : undefined;
    const snapshot = this.snapshot();
    snapshot.responsePolicy = { triggerEventIds: [...prepared.ids], maxChars: Math.min(this.config.maxReplyChars,
      newSpeech.some(e => this.pendingIntents.get(e.id)!.detailed) ? this.config.maxReplyChars : this.config.conversationReplyChars), preparingEarly: !this.quiet };
    const triggerTools = [...new Set(newSpeech.filter(e => e.kind === 'tool').flatMap(e => {
      try { const tool = JSON.parse(e.text).tool; return typeof tool === 'string' && ['message', 'remind', 'cancel_reminder', 'reminders', 'activity', 'members', 'search', 'chat', 'tasks'].includes(tool) ? [tool] : []; } catch { return []; }
    }))].sort().join(',');
    const triggerSpeech = newSpeech.filter(e => e.kind === 'speech').length;
    const triggerMode = triggerTools ? triggerSpeech ? 'mixed' : 'tool' : 'human';
    const trace = (stage: string, extra: Partial<LatencyRecord> = {}) => this.trace({ session: this.sessionId, turn, stage, sinceTurnMs: this.now() - started,
      triggerMode, triggerTools, triggerSpeech, ...extra });
    trace('turn_started', { sinceSpeechEndMs: started - latest, quietRequiredMs: this.config.roomQuietMs, model: this.config.model, streaming: this.config.streamReplies && !!this.player.playStream, throughEventId: consumed, speechEvents: newSpeech.length, preparingEarly: !this.quiet, localReply: !!localReply,
      triggerReason: urgent ? 'question_or_address' : singleSpeakerReady && !this.quiet ? 'single_speaker_pause' : 'room_quiet', maxReplyChars: snapshot.responsePolicy.maxChars });
    let output: VoiceOutput | undefined;
    let deliveryRecorded = false;
    let playbackRequestedAt = 0;
    let taskResults: TaskResult[] = directTasks ? this.tasks.directResults(taskBatch) : [];
    let taskDelivery: 'complete' | 'interrupted' | 'none' = 'none';
    let taskSpoke = false;
    const recordDelivery = (played: Playback, text: string) => {
      if (deliveryRecorded || this.phase === 'closed') return;
      deliveryRecorded = true;
      taskDelivery = played.playedMs > 0 ? played.completed ? 'complete' : 'interrupted' : 'none';
      this.lastPlaybackAt = this.now();
      if (played.playedMs > 0) this.lastAudibleAt = played.endedAt ?? this.lastPlaybackAt;
      const delivery = played.playedMs > 0
        ? { at: played.startedAt ?? playbackRequestedAt, end: played.endedAt ?? this.lastPlaybackAt, playedMs: played.playedMs }
        : { playedMs: 0 };
      const reference = localReply ? {} : { replyTo: consumed };
      if (played.completed) { this.diagnostics.spokenReplies++; this.add({ ...delivery, ...reference, kind: 'assistant', name: this.config.botName, text }); }
      else this.add({ ...delivery, ...reference, kind: 'interrupted', name: this.config.botName, text: this.t("Reply interrupted after {0} seconds; the full answer was not transmitted.", Math.round(played.playedMs / 1000)) });
      trace('playback_finished', { completed: played.completed, playedMs: Math.round(played.playedMs), streamWaitMs: played.streamWaitMs ?? 0 });
    };
    const playbackHooks: PlaybackHooks = {
      beforeStart: () => this.waitForFloor(prepared),
      onStart: at => {
        if (!canSpeak() || at - started > this.config.maxResponseAgeMs) {
          this.diagnostics.staleReplies++; trace('reply_expired', { beforeFirstAudio: true });
          abort.abort(); this.player.stop(); return;
        }
        this.phase = 'speaking';
        prepared.audible = true;
        this.diagnostics.lastFirstAudioMs = at - latest;
        trace('first_audio', { sinceSpeechEndMs: at - latest, startupMs: at - playbackRequestedAt });
      },
      onTiming: (stage, elapsedMs, chunk) => trace(stage, { elapsedMs, chunk }),
      onDiagnostic: (stage, fields) => trace(stage, fields),
    };
    try {
      this.phase = 'thinking';
      if (localReply) this.diagnostics.localReplies++; else this.diagnostics.modelCalls++;
      this.diagnostics.lastFirstTextMs = 0; this.diagnostics.lastFirstAudioMs = 0; this.diagnostics.lastTtsMs = 0;
      const streaming = !taskBatch.length && this.config.streamReplies && !!this.player.playStream;
      const answerReady = () => {
        prepared.answerReady = true; clearTimeout(prepared.cueTimer);
        if (!prepared.cueStarted) prepared.cueAbort?.abort();
      };
      const createOutput = () => {
        const player: Player = { stop: () => this.player.stop(), play: (...args) => this.player.play(...args),
          playStream: async (chunks, signal, hooks) => { await prepared.cueTask; signal.throwIfAborted(); return this.player.playStream!(chunks, signal, hooks); } };
        return new VoiceOutput(this.speaker, this.convertOutput, player, abort.signal, {
          ...playbackHooks,
          onTiming: (stage, elapsedMs, chunk) => {
            if (stage === 'tts_completed') this.diagnostics.lastTtsMs = elapsedMs;
            playbackHooks.onTiming?.(stage, elapsedMs, chunk);
          },
        }, () => abort.abort());
      };
      if (!localReply && prepared.addressed && this.config.thinkingCues) prepared.cueTimer = setTimeout(() => {
        prepared.cueTask = this.thinkingCue(prepared, trace);
      }, this.config.thinkingCueDelayMs);
      const reply = localReply ? { speak: true, text: localReply } : await this.brain.reply(snapshot, abort.signal, {
        onSentence: streaming ? sentence => {
          if (!canSpeak() || this.now() - started > this.config.maxResponseAgeMs) throw new Error(this.t("Reply deadline exceeded."));
          answerReady();
          if (!playbackRequestedAt) { playbackRequestedAt = this.now(); this.phase = 'synthesizing'; }
          output ??= createOutput();
          output!.write(sentence);
          trace('sentence_ready', { chars: sentence.length });
        } : undefined,
        onTiming: timing => {
          if (!timing.compaction && timing.stage === 'first_text') this.diagnostics.lastFirstTextMs = this.now() - started;
          trace(timing.stage, { ...timing });
        },
      });
      answerReady();
      taskResults = directTasks ? taskResults : reply.taskResults ?? [];
      taskSpoke = reply.speak && !!reply.text;
      this.diagnostics.lastModelMs = this.now() - started;
      log(this.t("Reply: {0}, {1} ms, speak={2}.", this.config.model, this.diagnostics.lastModelMs, reply.speak));
      trace('reply_decision', { speak: reply.speak, chars: reply.text.length, actions: reply.actions?.length ?? 0 });
      if (!canSpeak() || this.now() - started > this.config.maxResponseAgeMs) { this.diagnostics.staleReplies++; return; }
      const reportContext = { session: this.sessionId, turn, events: newSpeech.map(e => e.id) };
      if (reply.report === true) this.reporting?.review({ ...reportContext, reason: 'agent', evidence: [
        ...this.reportEvidence(), { event: 0, kind: 'assistant', text: reply.text },
      ] });
      else if (reply.report) this.reporting?.capture(reply.report, reportContext);
      const actions = (reply.actions ?? []).filter(a => a.tool === 'search' ? a.run || a.continue || reply.speak && !!reply.text
        : a.tool === 'chat' ? a.op === 'continue' || reply.speak && !!reply.text : true);
      for (const action of actions) trace('tool_action_proposed', { tool: action.tool, sourceEvent: action.event });
      this.tools?.submit(actions, newSpeech, abort.signal);
      this.tools?.onSpeech(this.latestMeaningfulSpeech);
      if (!reply.speak || !reply.text) { this.diagnostics.modelPasses++; return; }
      let played: Playback;
      if (streaming) {
        output ??= createOutput();
        playbackRequestedAt ||= this.now();
        output.finish(reply);
        played = await output.result;
        if (output.error) throw output.error;
      } else {
        this.phase = 'synthesizing';
        let began = this.now();
        const wav = await this.speaker.synthesize(reply.text, abort.signal);
        this.diagnostics.lastTtsMs = this.now() - began;
        trace('tts_completed', { elapsedMs: this.diagnostics.lastTtsMs, chunk: 1 });
        trace('tts_audio', { chunk: 1, wavBytes: wav.length });
        if (!canSpeak()) { this.diagnostics.staleReplies++; return; }
        began = this.now();
        const converted = await this.convertOutput(wav, abort.signal);
        const pcm = trimSpeechPadding(converted);
        trace('pcm_audio', { chunk: 1, beforeTrimBytes: converted.length, pcmBytes: pcm.length, durationMs: Math.round(pcm.length / 192) });
        trace('pcm_converted', { elapsedMs: this.now() - began, chunk: 1 });
        await prepared.cueTask;
        await this.waitForFloor(prepared);
        if (!canSpeak() || this.now() - started > this.config.maxResponseAgeMs) { this.diagnostics.staleReplies++; return; }
        this.phase = 'speaking'; prepared.audible = true; playbackRequestedAt = this.now();
        played = await this.player.play(pcm, abort.signal, { ...playbackHooks, beforeStart: undefined });
      }
      recordDelivery(played, reply.text);
      if (played.error) throw played.error;
      log(this.t("Speech transmission: {0}, {1} ms.", played.completed ? 'complete' : 'interrupted', Math.round(played.playedMs)));
    } catch (error) {
      output?.cancel();
      if (output) { const played = await output.result; if (played.playedMs > 0) recordDelivery({ ...played, completed: false }, ''); }
      const failure = output?.error ?? error;
      if (failure instanceof FloorUnavailable) { this.diagnostics.withheldReplies++; trace('reply_withheld'); }
      else if (!abort.signal.aborted || output?.error) {
        const failedPhase = this.phase;
        this.reporting?.failure(failure instanceof InferenceError ? 'model' : output?.error || failedPhase === 'synthesizing' || failedPhase === 'speaking' ? 'audio' : 'turn',
          failure instanceof InferenceError ? failure.code : failure instanceof Error ? failure.name : 'unknown',
          { session: this.sessionId, turn, events: prepared.ids });
        if (failure instanceof InferenceError && failure.blocksInference || failure instanceof ContextLimitError) this.pause();
        this.diagnostics.lastError = `${failedPhase}: ${safeError(failure)}`;
        this.notice(this.diagnostics.lastError);
      }
      trace('turn_failed', { aborted: abort.signal.aborted, phase: this.phase, partialSpeech: deliveryRecorded,
        errorDomain: failure instanceof InferenceError ? 'model' : failure instanceof ContextLimitError ? 'context' : output?.error || this.phase === 'synthesizing' || this.phase === 'speaking' ? 'audio' : 'turn',
        httpStatus: failure instanceof InferenceError ? failure.status : undefined,
        errorCode: failure instanceof InferenceError ? failure.code : failure instanceof Error ? failure.name : 'unknown' });
    } finally {
      clearTimeout(prepared.cueTimer); prepared.cueAbort?.abort(); await prepared.cueTask;
      output?.cancel();
      if (output) {
        const played = await output.result;
        if (!deliveryRecorded && played.playedMs > 0) recordDelivery({ ...played, completed: false }, '');
      }
      trace('turn_finished', { aborted: abort.signal.aborted, delivered: deliveryRecorded });
      this.tasks.release(taskBatch, taskResults, taskDelivery, taskSpoke);
      for (const event of newSpeech) if (event.kind === 'tool') {
        try { if (JSON.parse(event.text).tool === 'tasks') this.pendingIntents.delete(event.id); } catch { /* Not a task wake. */ }
      }
      if (!prepared.superseded) {
        for (const id of prepared.ids) { this.pendingIntents.delete(id); this.followups.delete(id); }
        this.consumedThrough = Math.max(this.consumedThrough, consumed); this.prune();
      }
      this.busy = false;
      if (this.preparing === prepared) this.preparing = undefined;
      if (this.current === abort) this.current = undefined;
      if (!['paused', 'closed'].includes(this.phase)) this.phase = 'idle';
      this.updateReporting();
    }
  }
  stop() {
    this.epoch++; this.stoppedAt = this.now();
    this.consumedThrough = this.sequence;
    this.previousTranscript.clear(); this.pendingIntents.clear(); this.previews.clear();
    this.tools?.cancelBackground(); this.followups.clear();
    this.tasks.stop();
    for (const task of this.transcriptions) task.abort();
    this.current?.abort(); this.player.stop();
    this.lastPlaybackAt = this.now();
    this.updateReporting();
  }
  pause() { this.stop(); this.tasks.suspend(true); this.phase = 'paused'; }
  resume() {
    if (!this.canUseContext()) throw new Error(this.t("All VC participants must have access to the context channel. Check permissions or start a new session without chat context."));
    if (this.phase === 'paused') { this.phase = 'idle'; this.lastHumanAt = this.now(); this.tasks.suspend(false); }
  }
  close() { this.stop(); this.tasks.close(); this.presence.close(); this.tools?.close(); this.phase = 'closed'; this.reporting?.forget(this.sessionId); clearInterval(this.timer); this.active.clear(); this.members.clear(); this.states.clear(); this.lastChat.clear(); this.events.length = 0; this.brain.release?.(this.sessionId); }
  private notice(message: string) {
    if (this.now() - this.lastNoticeAt < 5000) return;
    this.lastNoticeAt = this.now(); this.notify(message);
  }
}
