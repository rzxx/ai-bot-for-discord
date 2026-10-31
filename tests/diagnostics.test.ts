import { test, expect } from 'bun:test';
import { PlusBrain, type BrainTiming, type HTTPTransport } from '../src/llm';
import type { PlanAuth } from '../src/auth';
import { defaults } from '../src/config';
import { diagnosticsReport, parseDiagnostics } from '../src/diagnostics-report';
import type { LatencyRecord, DiagnosticFields } from '../src/telemetry';
import { pcm16Levels } from '../src/audio-levels';
import { encodeDiscordOpus, PCM_FRAME_BYTES } from '../src/audio';
import { DiscordPlayer } from '../src/playback';
import { VoiceConnectionStatus } from '@discordjs/voice';
import { voiceSnapshot } from '../src/voice-diagnostics';
import { RoomTools, type ToolHost } from '../src/room-tools';

const auth = { token: async () => 'secret-fixture-credential' } as unknown as PlanAuth;
const snapshot = { sessionId: 'fixture-session', members: [{ id: 'fixture-user', name: 'Тест' }], events: [], botName: 'Лёва', now: 1 };
const signal = () => new AbortController().signal;
const stream = (items: unknown[]) => new Response(items.map(item => `data: ${JSON.stringify(item)}\n\n`).join(''));
const completion = { type: 'response.completed', response: { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{"speak":false,"text":""}' }] }],
  usage: { input_tokens: 2000, input_tokens_details: { cached_tokens: 1500, cache_write_tokens: 500 }, output_tokens: 60, output_tokens_details: { reasoning_tokens: 20 } } } };
const records = (timings: BrainTiming[]): LatencyRecord[] => timings.map(t => ({ session: snapshot.sessionId, turn: 1, at: '2026-01-01T00:00:00Z', ...t }));

test('diagnostics count a reset retry and usage once without changing requests or logging content', async () => {
  const timings: BrainTiming[] = [], bodies: string[] = [];
  const transport: HTTPTransport = async (_url, init) => {
    bodies.push(String(init.body));
    if (bodies.length === 1) throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
    return stream([completion]);
  };
  const brain = new PlusBrain(auth, { ...defaults, model: 'fixture' }, transport, { diagnostic: true });
  await brain.reply(snapshot, signal(), { onTiming: t => timings.push(t) });
  await brain.reply({ ...snapshot, now: 2 }, signal(), { onTiming: t => timings.push(t) });
  expect(bodies[0]).toBe(bodies[1]);
  expect(timings.filter(t => t.stage === 'request_started').map(t => t.prefixUnchanged)).toEqual([undefined, true, true]);
  const report = diagnosticsReport(records(timings));
  expect(report.model).toMatchObject({ attempts: 3, retries: 1, requestsWithReportedUsage: 2, requestsWithUnknownUsage: 1,
    reportedInputTokens: 4000, reportedCachedTokens: 3000, reportedNonCachedInputTokens: 1000, reportedOutputTokens: 120, reportedReasoningTokens: 40 });
  expect(report.context.changedPrefixes).toBe(0);
  expect(JSON.stringify(timings)).not.toContain('secret-fixture');
  expect(JSON.stringify(timings)).not.toContain('дружелюбный');
  const plain: string[] = [];
  const plainBrain = new PlusBrain(auth, { ...defaults, model: 'fixture' }, async (_url, init) => { plain.push(String(init.body)); return stream([completion]); }, { diagnostic: false });
  await plainBrain.reply(snapshot, signal()); await plainBrain.reply({ ...snapshot, now: 2 }, signal());
  expect(plain).toEqual([bodies[1]!, bodies[2]!]);
});

test('HTTP quota errors preserve status/request id/remaining limits and never become zero-token success', async () => {
  const timings: BrainTiming[] = [];
  const brain = new PlusBrain(auth, { ...defaults, model: 'fixture' }, async () => Response.json({ error: { code: 'subscription_sharing_usage_limit_exceeded' } },
    { status: 429, headers: { 'x-request-id': 'req-fixture', 'retry-after': '60', 'x-ratelimit-remaining-tokens': '0' } }));
  await expect(brain.reply(snapshot, signal(), { onTiming: t => timings.push(t) })).rejects.toThrow('ChatGPT plan usage limit reached');
  expect(timings.find(t => t.stage === 'response_headers')).toMatchObject({ status: 429, requestId: 'req-fixture', retryAfter: '60', remainingTokens: '0' });
  const report = diagnosticsReport(records(timings));
  expect(report.model.requestsWithUnknownUsage).toBe(1);
  expect(report.model.lastFailure).toMatchObject({ status: 429, errorCode: 'subscription_sharing_usage_limit_exceeded', usageKnown: false });
});

test('stream quota failures and canceled attempts are recorded even without a model completion', async () => {
  for (const canceled of [false, true]) {
    const timings: BrainTiming[] = [], abort = new AbortController();
    const brain = new PlusBrain(auth, { ...defaults, model: 'fixture' }, async () => {
      if (canceled) { abort.abort(); throw abort.signal.reason; }
      return stream([{ type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded' }, usage: completion.response.usage } }]);
    });
    await expect(brain.reply(snapshot, abort.signal, { onTiming: t => timings.push(t) })).rejects.toThrow();
    const report = diagnosticsReport(records(timings));
    expect(report.model.attempts).toBe(1);
    expect(report.model.outcomes).toEqual({ [canceled ? 'canceled' : 'failed']: 1 });
    expect(report.model.requestsWithReportedUsage).toBe(canceled ? 0 : 1);
    expect(report.model.requestsWithUnknownUsage).toBe(canceled ? 1 : 0);
  }
});

test('offline reports read legacy logs and partial lines without doubling tokens or inventing cache measurements', () => {
  const rows: LatencyRecord[] = [
    { session: 's', turn: 1, stage: 'auth_ready', attempt: 0 },
    { session: 's', turn: 1, stage: 'model_completed', inputTokens: 100, outputTokens: 10 },
    { session: 's', turn: 2, stage: 'auth_ready', attempt: 0 },
    { session: 's', turn: 2, stage: 'turn_failed', errorCode: 'AbortError', aborted: true },
  ];
  const parsed = parseDiagnostics(rows.map(r => '[time] [latency] ' + JSON.stringify(r)).join('\n') + '\n{"unfinished":');
  const report = diagnosticsReport(parsed);
  expect(report.model).toMatchObject({ attempts: 2, requestsWithUnknownUsage: 1, reportedInputTokens: 100, reportedOutputTokens: 10, reportedCachedTokens: null });
});

test('whole context snapshots are distinct from cumulative traffic and late observations join the correct request', () => {
  const rows: LatencyRecord[] = [
    { session: 's', stage: 'request_started', request: 1, turn: 1, at: '1' },
    { session: 's', stage: 'request_ended', request: 1, turn: 1, at: '2', outcome: 'completed', inputTokens: 2000, outputTokens: 50 },
    { session: 'other', stage: 'request_ended', request: 1, at: '3', inputTokens: 9000, outputTokens: 10 },
    { session: 's', stage: 'request_started', request: 2, turn: 2, at: '4', appendedSpeech: 1, stateUpdates: 0 },
    { session: 's', stage: 'request_ended', request: 2, turn: 2, at: '5', outcome: 'completed', inputTokens: 2100, cachedTokens: 1900, outputTokens: 60 },
    { session: 's', stage: 'context_tokens', request: 2, at: '6', visibleTextTokens: 2050, appendedTextTokens: 90,
      sourceTokens: JSON.stringify([{ source: 'speech', tokens: 200, bytes: 400 }]),
      breakdown: JSON.stringify([{ source: 'speech_text', tokens: 150, bytes: 250 }, { source: 'speech_metadata', tokens: 50, bytes: 150 }, { source: 'instructions', tokens: 1850, bytes: 3000 }]),
      appendedBreakdown: JSON.stringify([{ source: 'speech_text', tokens: 60, bytes: 100 }, { source: 'speech_metadata', tokens: 30, bytes: 50 }]),
      appendedContributors: JSON.stringify([{ kind: 'speech', person: 'u1', events: 1, wireTokens: 90, wireBytes: 150, textTokens: 55, textBytes: 90, contentWireTokens: 60, contentWireBytes: 100 }]),
      contributors: JSON.stringify([{ kind: 'speech', person: 'u1', events: 2, wireTokens: 200, wireBytes: 400, textTokens: 100, textBytes: 200 }]) },
    { session: 's', stage: 'context_tokens', request: 1, at: '7', visibleTextTokens: 1950 },
    { session: 's', stage: 'request_started', request: 3, at: '8' },
    { session: 's', stage: 'request_ended', request: 3, at: '9', outcome: 'canceled' },
  ];
  const report = diagnosticsReport(rows), session = report.context.sessions.find(r => r.session === 's')!;
  expect(report.model.reportedInputTokens).toBe(13100);
  expect(session).toMatchObject({ firstInputTokens: 2000, lastInputTokens: 2100, lastOutputTokens: 60,
    inputGrowthTokens: 100, cumulativeInputTokens: 4100, reportedRequests: 2, visibleTextTokens: 2050,
    providerFramingAndUnattributedTokens: 50 });
  expect(session.contributors![0]!.person).toBe('u1');
  expect(session.timeline[1]).toMatchObject({ inputGrowthSincePreviousRequest: 100, appendedVisibleTextTokens: 90, appendedSpeechEvents: 1 });
  expect(session).toMatchObject({ breakdownTokenTotal: 2050, breakdownMatchesVisibleText: true });
  expect(session).toMatchObject({ tokenizedRequests: 2, partitionedRequests: 1, droppedTokenMeasurements: 0 });
  expect(session.largestAdditions[0]!.appendedContributors![0]).toMatchObject({ person: 'u1', contentWireTokens: 60 });
  expect(session.timeline[1]!.appendedBreakdown![1]!.source).toBe('speech_metadata');
  expect(report.context.sessions.find(r => r.session === 'other')!.contributors).toBeNull();
  expect(report.context.sessions.find(r => r.session === 'other')!.breakdownMatchesVisibleText).toBeNull();
  expect(report.context.latestSession).toBe('s');
});

test('actual production Opus diagnostics distinguish silence and measurable audio off the timer thread', async () => {
  const tone = Buffer.alloc(PCM_FRAME_BYTES * 6);
  for (let at = 0; at < tone.length; at += 2) tone.writeInt16LE(Math.round(Math.sin(at / 4 / 48000 * Math.PI * 880) * 6000), at);
  expect(pcm16Levels(Buffer.alloc(32))).toMatchObject({ rms: 0, peak: 0, rmsDbfs: null });
  expect(pcm16Levels(tone).peak).toBeGreaterThan(5900);
  let observed!: DiagnosticFields;
  const packets = await encodeDiscordOpus(tone, signal(), fields => { observed = fields; });
  expect(observed.packets).toBe(packets.length);
  expect(Number(observed.pcmPeak)).toBeGreaterThan(5900);
  expect(Number(observed.decodedPeak)).toBeGreaterThan(4000);
  await encodeDiscordOpus(Buffer.alloc(tone.length), signal(), fields => { observed = fields; });
  expect(observed.pcmPeak).toBe(0);
  expect(Number(observed.decodedPeak)).toBeLessThanOrEqual(8); // Opus comfort noise is not speech.
});

test('playback reports consumed versus dispatched packets with an explicitly synthetic subscription', async () => {
  let dispatched = 0;
  const player = new DiscordPlayer({ diagnostic: true, network: () => ({ voicePackets: dispatched, voiceState: 'ready' }) });
  const fakeConnection = { state: { status: VoiceConnectionStatus.Ready }, prepareAudioPacket() {}, dispatchAudio() { dispatched++; }, setSpeaking() {}, onSubscriptionRemoved() {} };
  const subscription = Reflect.get(player.audio, 'subscribe').call(player.audio, fakeConnection);
  const rows: LatencyRecord[] = [];
  try {
    const played = await player.play(Buffer.alloc(PCM_FRAME_BYTES * 6), signal(), { onDiagnostic: (stage, fields) => rows.push({ session: 'fixture', stage, ...fields }) });
    expect(played.completed).toBe(true);
    const end = rows.find(r => r.stage === 'audio_player_finished')!;
    expect(Number(end.dispatchedPackets)).toBeGreaterThan(0);
    expect(Number(end.consumedPackets)).toBeGreaterThan(0);
    expect(Number(rows.find(r => r.stage === 'opus_signal')?.decodedPeak)).toBeLessThanOrEqual(8);
  } finally { player.stop(); subscription.unsubscribe(); }
});

test('voice snapshots allowlist scalar health and never include Discord secrets or connection objects', () => {
  const connection = { state: { status: VoiceConnectionStatus.Ready, subscription: {}, networking: { state: { code: 4,
    connectionOptions: { token: 'secret-voice-token' }, connectionData: { packetsPlayed: 18, speaking: true, encryptionMode: 'fixture', secretKey: 'secret-key' },
    dave: { protocolVersion: 1, session: { secret: 'secret-session' }, reinitializing: false } } } }, ping: { ws: 25, udp: 30 } };
  const snapshot = voiceSnapshot(connection as any);
  expect(snapshot).toMatchObject({ voicePackets: 18, voiceState: 'ready', subscribed: true, daveVersion: 1, daveSession: true });
  expect(JSON.stringify(snapshot)).not.toContain('secret');
  expect(Object.values(snapshot).every(v => v === null || typeof v !== 'object')).toBe(true);
});

test('tool observation explains rejected actions and records bounded jobs without revealing arguments', async () => {
  const rows: LatencyRecord[] = [];
  const host: ToolHost = { limits: new Map(), resolvePerson: () => undefined, sendMessage: async () => {}, activity: () => ({ status: 'unknown', activity: '' }) };
  const tools = new RoomTools(defaults, host, () => true, () => {}, Date.now, (stage, fields) => rows.push({ session: 'fixture', stage, ...fields }));
  try {
    const origins = [{ id: 1, at: 1, kind: 'speech' as const, userId: 'fixture-user', text: 'Напиши в чат привет.' }];
    tools.submit([{ tool: 'message', event: 9, text: 'private-message-fixture' }], origins, signal());
    tools.submit([{ tool: 'message', event: 1, text: 'private-message-fixture' }], origins, signal());
    await tools.settle();
    expect(rows.find(r => r.stage === 'tool_action_rejected')).toMatchObject({ reason: 'no_current_speaker' });
    expect(rows.find(r => r.stage === 'tool_job_finished')).toMatchObject({ tool: 'message', status: 'sent' });
    expect(JSON.stringify(rows)).not.toContain('private-message-fixture');
    expect(diagnosticsReport(rows).tools.rejected).toEqual({ no_current_speaker: 1 });
  } finally { tools.close(); }
});
