import { t, setLocale } from '../src/locale';
import { configureNetwork } from '../src/network';
/** Opt-in, real Plus inference benchmark. Never changes config or joins Discord. */
import { createHash } from 'node:crypto';
import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { VoiceConnectionStatus } from '@discordjs/voice';
import { Decoder } from '@evan/opus';
import { loadConfig, LOCAL, safeError } from '../src/config';
import { CredentialStore, acquireLock } from '../src/platform';
import { PlanAuth, listModels, OpenAIError } from '../src/auth';
import { PlusBrain, type Brain, type Reply, type RoomSnapshot, type HTTPTransport, type TurnEvent } from '../src/llm';
import { SpeechRuntime } from '../src/speech';
import { toDiscordPCM, UtteranceGate, PCM_FRAME_BYTES } from '../src/audio';
import { RoomController } from '../src/room';
import { DiscordPlayer } from '../src/playback';
import { TaskQueue } from '../src/queue';
import type { LatencyRecord } from '../src/telemetry';

const arg = (key: string, fallback: string) => process.argv.find(v => v.startsWith(`--${key}=`))?.split('=').slice(1).join('=') ?? fallback;
const rounds = Number(arg('rounds', '2'));
const localOnly = process.argv.includes('--local-check');
const filter = arg('cases', '').split(',').filter(Boolean);
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 5) throw new Error(t("rounds must be 1..5"));
const config = await loadConfig();
setLocale(config.locale);
configureNetwork(config.networkMode);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const directory = resolve(LOCAL, `model-benchmark-${stamp}${localOnly ? '-local' : ''}`);
await mkdir(directory, { recursive: true });
const release = await acquireLock('model-benchmark');
// Separate ports keep an existing bot and its speech worker untouched.
const runtime = new SpeechRuntime({ ...config, speechPort: 18865, whisperPort: 18866 }, e => console.error(safeError(e)));
const auth = localOnly ? { token: async () => 'local-benchmark-fixture' } as unknown as PlanAuth : new PlanAuth(new CredentialStore());
const models = ['gpt-6.1-sol', 'gpt-6.1-terra'];
const roster = [{ id: 'fixture-alena', name: 'Алёна' }, { id: 'fixture-lesha', name: 'Лёша' }, { id: 'fixture-max', name: 'Макс' }];
type Fixture = { id: string; question: string; history: [number, string][]; rubric: string; speak: boolean; members?: typeof roster };
const b = config.botName;
const chatter: [number, string][] = Array.from({ length: 64 }, (_, i) => [i % 3,
  `Обсуждение ${i + 1}: ${['заходили в игру вечером и проверяли звук в голосовом канале', 'сравнивали карту и решили пока не менять настройки команды', 'обсуждали музыку для фона и договорились не делать её громкой', 'вспоминали вчерашний матч и смешной момент с отключённым микрофоном'][i % 4]}.`]);
const allFixtures: Fixture[] = [
  { id: 'connection', question: `${b}, связь, ты меня слышишь?`, history: [], rubric: 'Answer the connection check directly in Russian, without inventing audio details.', speak: true },
  { id: 'fixed-short', question: `${b}, ответь ровно: Да, я здесь.`, history: [], rubric: 'Exactly «Да, я здесь.»; no preamble or extra sentence.', speak: true },
  { id: 'fixed-sentence', question: `${b}, скажи ровно: Хорошо, я подожду тебя у входа и никуда не уйду.`, history: [], rubric: 'Exactly the requested sentence, without additions.', speak: true },
  { id: 'practical-advice', question: `${b}, как нам быстро проверить, у кого эхо?`, history: [[1, 'у кого-то в голосовом чате эхо но непонятно у кого'], [2, 'у меня звук через колонки а не через наушники']], rubric: 'Suggest muting microphones one at a time and/or headphones, use the speaker clue; concise actionable answer.', speak: true },
  { id: 'correction', question: `${b}, во сколько и где мы встречаемся?`, history: [[0, 'давайте завтра в восемь у метро'], [1, 'нет исправляю в половине девятого у кинотеатра'], [0, 'да согласна новый вариант окончательный']], rubric: 'Final arrangement: tomorrow at 20:30 / half past eight, at the cinema; do not repeat superseded metro/eight.', speak: true },
  { id: 'shared-cost', question: `${b}, сколько платит каждый из нас троих?`, history: [[0, 'пицца стоит тысячу двести рублей доставка ещё сто пятьдесят делим поровну на троих']], rubric: '450 rubles each; natural spoken Russian, no incorrect arithmetic.', speak: true },
  { id: 'identity', question: `${b}, кто хотел чай, а кто кофе?`, history: [[0, 'мне пожалуйста чай без сахара'], [1, 'а мне кофе с молоком'], [2, 'я пока ничего не хочу']], rubric: 'Алёна tea without sugar; Лёша coffee with milk; do not swap speakers.', speak: true },
  { id: 'overlap', question: `${b}, повтори последнее, я не расслышала.`, history: [[1, 'предлагаю сыграть ещё один матч а потом сделать перерыв'], [0, 'погоди я говорила одновременно с тобой']], rubric: 'Repeat the concrete proposal to play one more match then take a break; no argument about whether she heard.', speak: true },
  { id: 'long-recall', question: `${b}, какое у нас кодовое слово?`, history: [[0, 'кодовое слово на сегодня янтарь запомни его пожалуйста'], ...chatter], rubric: 'Recall «янтарь» from the supplied longer context; no guessing or substitutions.', speak: true },
  { id: 'long-correction', question: `${b}, кто в итоге создаёт комнату и какая карта?`, history: [[1, 'сначала я создам комнату карта лес'], ...chatter, [2, 'обновление комнату создаю я макс карта теперь пустыня'], [1, 'да окончательно пусть макс создаёт пустыню']], rubric: 'Макс creates the room; final map is desert, not forest; use latest correction.', speak: true },
  { id: 'uncertainty', question: `${b}, а во сколько он придёт?`, history: [[0, 'Саша и Дима сегодня обещали зайти но время никто не написал']], rubric: 'Do not invent a time or resolve ambiguous «он» without evidence; brief clarification/acknowledge unknown.', speak: true },
  { id: 'ack-silence', question: 'Ага, спасибо.', history: [[1, 'я скинул тебе файл который ты просила']], rubric: 'Standalone acknowledgment clearly between humans: choose speak=false.', speak: false },
];
const fixtures = allFixtures.filter(f => !filter.length || filter.includes(f.id));
if (!fixtures.length) throw new Error(t("No cases selected"));
const records: any[] = [];
const save = async (record: any) => { records.push(record); await appendFile(resolve(directory, 'trials.jsonl'), JSON.stringify(record) + '\n'); };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function rms(pcm: Buffer) { let sum = 0; for (let n = 0; n + 1 < pcm.length; n += 2) sum += (pcm.readInt16LE(n) / 32768) ** 2; return Math.sqrt(sum / (pcm.length / 2)); }
async function retrySetup<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) { try { return await fn(); } catch (e) { if (attempt >= 2 || (e instanceof OpenAIError && e.blocksPlan)) throw e; console.log(t("Setup connectivity failed ({0}/3): {1}", attempt + 1, safeError(e))); await Bun.sleep(1000 * (attempt + 1)); } }
}
async function probe(pair: string, position: string) {
  const started = performance.now();
  try {
    const token = await auth.token();
    const sent = performance.now();
    const response = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(12000) });
    const headersMs = performance.now() - sent;
    await response.arrayBuffer();
    await save({ kind: 'probe', pair, position, at: new Date().toISOString(), status: response.status, headersMs: Math.round(headersMs), elapsedMs: Math.round(performance.now() - started) });
  } catch (e) { await save({ kind: 'probe', pair, position, at: new Date().toISOString(), error: safeError(e), elapsedMs: Math.round(performance.now() - started) }); }
}
type Prepared = { fixture: Fixture; pcm: Buffer; snapshot: RoomSnapshot; canonicalTranscript: string };
async function trial(prepared: Prepared, model: string, round: number, order: number, warmup = false) {
  const { fixture, pcm } = prepared;
  const id = `${warmup ? 'warmup' : 'r' + round}-${fixture.id}-${model.replace('gpt-6.1-', '')}`;
  const traces: LatencyRecord[] = [], requests: any[] = [], sentences: string[] = [], notices: string[] = [];
  let reply: Reply | undefined, caught: unknown, modelError: unknown, transcript = '';
  let speechStartAt = 0, speechEndAt = 0, firstDispatchAt = 0, firstAudibleAt = 0, pendingPacket: Buffer | undefined;
  let firstAudibleResolve!: () => void;
  const firstAudible = new Promise<void>(r => { firstAudibleResolve = r; });
  const player = new DiscordPlayer();
  const decoder = new Decoder({ sample_rate: 48000, channels: 2 });
  const connection = {
    state: { status: VoiceConnectionStatus.Ready },
    prepareAudioPacket(packet: Buffer) { pendingPacket = packet; },
    dispatchAudio() {
      if (!pendingPacket) return;
      firstDispatchAt ||= Date.now();
      if (!firstAudibleAt) {
        try { if (rms(Buffer.from(decoder.decode(pendingPacket))) >= 0.003) { firstAudibleAt = Date.now(); firstAudibleResolve(); } } catch (e) { notices.push(`decode: ${safeError(e)}`); }
      }
      pendingPacket = undefined;
    },
    setSpeaking() {}, onSubscriptionRemoved() {},
  };
  const subscription = Reflect.get(player.audio, 'subscribe').call(player.audio, connection);
  const transport: HTTPTransport = async (url, init) => {
    const body = JSON.parse(String(init.body));
    const request: any = { at: new Date().toISOString(), inputHash: hash(body.input), settings: { model: body.model, reasoning: body.reasoning, stream: body.stream, store: body.store }, startedAt: Date.now() };
    requests.push(request);
    try {
      if (localOnly) {
        const text = JSON.stringify(fixture.speak ? { speak: true, text: 'Да, я здесь. Слышу тебя.' } : { speak: false, text: '' });
        return new Response(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\ndata: ${JSON.stringify({ type: 'response.completed', response: { usage: { input_tokens: 100, output_tokens: 16, output_tokens_details: { reasoning_tokens: 0 } } } })}\n\n`);
      }
      const response = await fetch(url, init);
      request.headersMs = Date.now() - request.startedAt;
      request.status = response.status;
      request.responseHeaders = Object.fromEntries(['x-request-id', 'openai-processing-ms', 'server-timing'].map(k => [k, response.headers.get(k)]).filter(([, v]) => v !== null));
      return response;
    } catch (e) { request.error = safeError(e); request.failedMs = Date.now() - request.startedAt; throw e; }
  };
  const canonicalId = prepared.snapshot.sessionId;
  const brain = new PlusBrain(auth, { ...config, model, reasoningEffort: 'low', streamReplies: true }, transport);
  const wrapped: Brain = {
    async reply(snapshot, signal, hooks) {
      transcript = snapshot.events.filter(e => e.kind === 'speech').at(-1)?.text ?? '';
      const input = structuredClone(prepared.snapshot);
      input.events.at(-1)!.text = transcript;
      try { reply = await brain.reply(input, signal, hooks); return reply; } catch (e) { modelError = e; throw e; }
    },
  };
  const room = new RoomController({ ...config, model, reasoningEffort: 'low', streamReplies: true, thinkingCues: false }, wrapped, runtime.client, {
    async synthesize(text, signal) {
      sentences.push(text);
      const wav = await runtime.client.synthesize(text, signal);
      await writeFile(resolve(directory, `${id}-sentence-${sentences.length}.wav`), wav);
      return wav;
    },
  }, player, new TaskQueue(config.maxSttQueue), text => notices.push(text), { autoTick: false, modelOnly: true, trace: record => traces.push({ ...record, observedAt: Date.now() }) });
  for (const member of fixture.members ?? roster) room.setMember(member);
  let finishedResolve!: () => void;
  const finished = new Promise<void>(r => { finishedResolve = r; });
  let pendingTick: Promise<void> | undefined;
  const ticker = setInterval(() => {
    // tick catches inference errors internally; use turn_finished as terminal evidence.
    const tick = room.tick();
    pendingTick = tick;
    void tick.then(() => { if (traces.some(t => t.stage === 'turn_finished')) finishedResolve(); });
  }, 100);
  const gate = new UtteranceGate({ silenceMs: config.utteranceSilenceMs, minSpeechMs: config.minSpeechMs, maxMs: config.maxUtteranceMs, rms: config.speechRms }, u => { speechEndAt = u.endedAt; room.ingest(roster[0]!, u); }, (active, at) => room.activity(roster[0]!.id, active, at));
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let playbackCutoff: ReturnType<typeof setTimeout> | undefined;
  let playbackTruncated = false;
  try {
    speechStartAt = Date.now();
    // Real-time PCM arrival, same 20ms input framing as the live receiver.
    for (let offset = 0, frame = 0; offset < pcm.length; offset += PCM_FRAME_BYTES, frame++) {
      const wait = speechStartAt + frame * 20 - Date.now();
      if (wait > 0) await Bun.sleep(wait);
      gate.push(pcm.subarray(offset, offset + PCM_FRAME_BYTES), Date.now());
    }
    // Let the complete first sentence play, but cap very long recordings after
    // first audible onset. This happens only after the model has completed.
    void firstAudible.then(() => {
      playbackCutoff = setTimeout(() => { if (reply && !traces.some(t => t.stage === 'turn_finished')) { playbackTruncated = true; room.stop(); } }, 12000);
    });
    await Promise.race([finished, new Promise<never>((_, reject) => { watchdog = setTimeout(() => reject(new Error(t("Benchmark trial exceeded 125 seconds"))), 125000); })]);
  } catch (e) { caught = e; }
  finally {
    clearTimeout(watchdog); clearTimeout(playbackCutoff); clearInterval(ticker);
    gate.close(false); room.close(); await pendingTick?.catch(() => {}); player.stop(); subscription.unsubscribe(); brain.release(canonicalId);
  }
  const stage = (name: string) => traces.find(t => t.stage === name);
  const first = stage('first_audio'), start = stage('turn_started'), complete = stage('model_completed');
  const result = { kind: 'trial', id, pair: `r${round}-${fixture.id}`, round, order, warmup, model, effort: 'low', fixture: fixture.id, at: new Date().toISOString(), expectedSpeak: fixture.speak,
    transcript, canonicalTranscript: prepared.canonicalTranscript, transcriptMatchesPreparation: transcript === prepared.canonicalTranscript, reply, sentences,
    speechDurationMs: speechEndAt - speechStartAt,
    speechEndToRequestMs: start?.sinceSpeechEndMs ?? null,
    firstTextMs: stage('first_text')?.sinceTurnMs ?? null,
    firstSentenceMs: stage('first_sentence')?.sinceTurnMs ?? null,
    completionMs: complete?.sinceTurnMs ?? null,
    firstPlayerMs: first?.sinceSpeechEndMs ?? null,
    firstDispatchMs: firstDispatchAt && speechEndAt ? firstDispatchAt - speechEndAt : null,
    firstAudibleMs: firstAudibleAt && speechEndAt ? firstAudibleAt - speechEndAt : null,
    askStartToFirstAudibleMs: firstAudibleAt ? firstAudibleAt - speechStartAt : null,
    modelRequestToFirstAudibleMs: firstAudibleAt && start ? firstAudibleAt - Number(start.observedAt) : null,
    inputTokens: complete?.inputTokens ?? null, cachedTokens: complete?.cachedTokens ?? null, outputTokens: complete?.outputTokens ?? null, reasoningTokens: complete?.reasoningTokens ?? null,
    requests, traces, notices, playbackTruncated, playerMetrics: player.metrics,
    error: caught || modelError ? safeError(caught ?? modelError) : undefined,
    errorCode: modelError instanceof OpenAIError ? modelError.code : stage('turn_failed')?.errorCode,
    blocksPlan: modelError instanceof OpenAIError && modelError.blocksPlan,
    successful: !!complete && !caught && !modelError && (reply?.speak ? !!firstAudibleAt : true),
  };
  await save(result);
  console.log(t("BENCH {0}: {1} firstText={2}ms firstAudible={3}ms reasoning={4} attempts={5}{6}", id, result.successful ? 'OK' : 'FAIL', result.firstTextMs, result.firstAudibleMs, result.reasoningTokens, requests.length, result.error ? ` ${result.error}` : ''));
  return result;
}

let fatal: unknown;
try {
  console.log(t("BENCH output: {0}", directory));
  if (!localOnly) {
    const catalog = await retrySetup(() => listModels(auth));
    for (const model of models) {
      const available = catalog.find(m => m.slug === model);
      if (!available || !available.supported_reasoning_levels?.some(e => e.effort === 'low')) throw new Error(t("{0} low is unavailable", model));
    }
    await writeFile(resolve(directory, 'catalog.json'), JSON.stringify(catalog.map(m => ({ slug: m.slug, efforts: m.supported_reasoning_levels?.map(v => v.effort) })), null, 2));
  }
  await runtime.start();
  const signal = AbortSignal.timeout(180000);
  // Local-only warmup includes actual STT/TTS/FFmpeg, no inference quota.
  await runtime.client.synthesize('Проверка русской речи.', signal);
  const prepared: Prepared[] = [];
  for (const fixture of fixtures) {
    const wav = await runtime.client.synthesize(fixture.question, signal);
    let pcm = await toDiscordPCM(wav, signal);
    // Keep a little natural trailing silence; remove long TTS padding only.
    let end = pcm.length;
    while (end > PCM_FRAME_BYTES && rms(pcm.subarray(end - PCM_FRAME_BYTES, end)) < 0.001) end -= PCM_FRAME_BYTES;
    pcm = Buffer.concat([pcm.subarray(0, Math.min(pcm.length, end + 2 * PCM_FRAME_BYTES)), Buffer.alloc(PCM_FRAME_BYTES * 3)]);
    if (pcm.length / PCM_FRAME_BYTES * 20 >= config.maxUtteranceMs) throw new Error(t("Fixture {0} exceeds the utterance split boundary", fixture.id));
    const fixedNow = 1793091600000;
    const events: TurnEvent[] = fixture.history.map(([person, text], i) => ({ id: i + 1, at: fixedNow - (fixture.history.length - i + 1) * 10000, end: fixedNow - (fixture.history.length - i + 1) * 10000 + 3000, kind: 'speech', userId: roster[person]!.id, name: roster[person]!.name, text }));
    // Canonical ASR is for diagnostics only; every timed trial recognizes again.
    const { toSTTWav } = await import('../src/audio');
    const canonicalTranscript = await runtime.client.transcribe(await toSTTWav(pcm, signal), roster.map(m => m.name), signal);
    if (!canonicalTranscript) throw new Error(t("Fixture {0} failed STT", fixture.id));
    events.push({ id: events.length + 1, at: fixedNow - 4500, end: fixedNow - 1100, kind: 'speech', userId: roster[0]!.id, name: roster[0]!.name, text: canonicalTranscript });
    const snapshot: RoomSnapshot = { sessionId: crypto.randomUUID(), members: fixture.members ?? roster, events, botName: b, now: fixedNow, timeline: { sessionStartedAt: fixedNow - 1800000, quietForMs: config.roomQuietMs, sinceLastBotSpeechMs: null } };
    prepared.push({ fixture, pcm, snapshot, canonicalTranscript });
    await writeFile(resolve(directory, `${fixture.id}-input.wav`), wav);
    console.log(t("BENCH prepared {0}: {1}ms input", fixture.id, Math.round(pcm.length / PCM_FRAME_BYTES * 20)));
  }
  await writeFile(resolve(directory, 'method.json'), JSON.stringify({ at: stamp, localOnly, rounds, models, effort: 'low', productionModel: config.model,
    roomQuietMs: config.roomQuietMs, utteranceSilenceMs: config.utteranceSilenceMs, maxResponseAgeMs: config.maxResponseAgeMs,
    localParticipation: false, thinkingCues: false, earlyEndpointProbes: false,
    proxyConfigured: !!(process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy),
    scope: 'Real-time synthetic PCM -> production endpoint gate -> real STT -> real PlusBrain -> real TTS -> FFmpeg -> actual discord.js scheduler -> local Opus decode and RMS>=0.003. No Discord network or listener jitter buffer. Canonical timestamps/roster/session metadata give matched model inputs; only model and Sol-specific reasoning.context differ. Production 25s model deadline and built-in single pre-speech reset retry retained. Independent fresh scenario contexts; repeated prefixes may be cached; measured cache counts retained. No previous bot playback or competing human speech. Local speech worker warm; no inference warmup. All measured trials retained.',
    fixtures: prepared.map(p => ({ ...p.fixture, canonicalTranscript: p.canonicalTranscript, snapshot: p.snapshot })),
  }, null, 2));
  let blocked = false;
  for (let round = 1; round <= rounds && !blocked; round++) {
    // Pair order is interleaved across cases and reversed on the second pass.
    const ordered = round % 2 ? prepared : [...prepared].reverse();
    for (const [caseIndex, p] of ordered.entries()) {
      const pair = `r${round}-${p.fixture.id}`;
      if (!localOnly) await probe(pair, 'before');
      const order = ((round + prepared.indexOf(p)) % 2) ? models : [...models].reverse();
      for (const [index, model] of order.entries()) {
        const result = await trial(p, model, round, index + 1);
        if (result.blocksPlan) { blocked = true; break; }
      }
      if (!localOnly) await probe(pair, 'after');
      if (blocked) { console.log(t("BENCH stopped on a plan/auth/eligibility block; no quota polling.")); break; }
      if (localOnly) break;
    }
    if (localOnly) break;
  }
} catch (e) { fatal = e; console.error(t("BENCH fatal: {0}", safeError(e))); process.exitCode = 1; }
finally {
  await writeFile(resolve(directory, 'results.json'), JSON.stringify({ directory, fatal: fatal ? safeError(fatal) : undefined, records }, null, 2));
  await runtime.stop(); await release();
  console.log(t("BENCH finished: {0}", directory));
}
