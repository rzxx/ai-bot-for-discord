import { test, expect } from 'bun:test';
import { VoiceConnectionStatus } from '@discordjs/voice';
import { defaults, type Config } from '../src/config';
import { PlusBrain, cleanReply, type HTTPTransport, type Reply } from '../src/llm';
import type { PlanAuth } from '../src/auth';
import { ReplySentences } from '../src/reply-stream';
import { RoomController } from '../src/room';
import { DiscordPlayer } from '../src/playback';
import { TaskQueue } from '../src/queue';
import { pcm16ToWav, PCM_FRAME_BYTES } from '../src/audio';
import type { LatencyRecord } from '../src/telemetry';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { resolve, promise };
}
async function within<T>(promise: Promise<T>, ms = 4000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Streaming test timed out')), ms); })]); }
  finally { clearTimeout(timeout); }
}
const encoder = new TextEncoder();
const auth = { token: async () => 'fixture' } as unknown as PlanAuth;

function fixture(streamReplies = true, failTts = false, overrides: Partial<Config> = {}, question = 'Проверка.') {
  let controller!: ReadableStreamDefaultController<Uint8Array>, calls = 0, cancelled = false, aborted = false;
  const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; }, cancel() { cancelled = true; } });
  const ready = deferred<void>();
  const transport: HTTPTransport = async (_url, init) => {
    calls++; ready.resolve();
    init.signal?.addEventListener('abort', () => { aborted = true; if (!cancelled) controller.error(init.signal!.reason); }, { once: true });
    return new Response(body);
  };
  const player = new DiscordPlayer();
  const connection = { state: { status: VoiceConnectionStatus.Ready }, prepareAudioPacket() {}, dispatchAudio() {}, setSpeaking() {}, onSubscriptionRemoved() {} };
  const subscription = Reflect.get(player.audio, 'subscribe').call(player.audio, connection);
  const traces: LatencyRecord[] = [], synthesized: string[] = [];
  const audible = deferred<void>();
  const cueAudible = deferred<void>();
  const pcm = Buffer.alloc(PCM_FRAME_BYTES * 10);
  for (let i = 0; i < pcm.length / 4; i++) {
    const sample = Math.round(Math.sin(2 * Math.PI * 440 * i / 48000) * 5000);
    pcm.writeInt16LE(sample, i * 4); pcm.writeInt16LE(sample, i * 4 + 2);
  }
  const config = { ...defaults, botName: 'Лёва', speechLanguage: 'ru', sttEngine: 'gigaam', voice: 'eugene', model: 'fixture', roomQuietMs: 1, streamReplies, ...overrides };
  const brain = new PlusBrain(auth, config, transport);
  const room = new RoomController(config, brain, { transcribe: async () => '' }, {
    synthesize: async text => { if (failTts) throw new Error('fixture synthesis failure'); synthesized.push(text); return pcm16ToWav(pcm, 48000, 2); },
  }, player, new TaskQueue(2), () => {}, { autoTick: false, trace: record => { traces.push(record); if (record.stage === 'first_audio') audible.resolve(); if (record.stage === 'thinking_cue_audio') cueAudible.resolve(); } });
  const member = { id: '1', name: 'Тест' };
  room.setMember(member); room.transcript(member, question, Date.now() - 100, Date.now() - 50);
  const event = (data: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
  return {
    room, player, brain, traces, synthesized, ready: ready.promise, audible: audible.promise, cueAudible: cueAudible.promise,
    calls: () => calls, cancelled: () => cancelled || aborted,
    delta: (delta: string) => event({ type: 'response.output_text.delta', delta }),
    complete: () => event({ type: 'response.completed', response: { usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 64 }, output_tokens: 20 } } }),
    fail: () => event({ type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'Fixture quota' } } }),
    breakStream: () => controller.error(Object.assign(new Error('Connection reset'), { code: 'ECONNRESET' })),
    close: () => { room.close(); player.stop(); subscription.unsubscribe(); },
  };
}

test('sentence extraction handles arbitrary JSON escapes, Cyrillic and Unicode boundaries without speaking metadata', () => {
  const reply: Reply = { speak: true, text: 'Привет, Алёна! Он сказал: "Да". Ёж тут 😀.' };
  const raw = JSON.stringify(reply).replace('Ё', '\\u0401').replace('😀', '\\ud83d\\ude00');
  const emitted: string[] = [];
  const stream = new ReplySentences(650, text => emitted.push(text));
  for (let i = 1; i <= raw.length; i++) stream.feed(raw.slice(0, i));
  expect(emitted).toEqual(['Привет, Алёна!', 'Он сказал: "Да".', 'Ёж тут 😀.']);
  stream.finish(reply);
  expect(emitted).toEqual(['Привет, Алёна!', 'Он сказал: "Да".', 'Ёж тут 😀.']);
});

test('streaming respects the same reply limit as the completed answer', () => {
  const raw = { speak: true, text: 'Короткий ответ. ' + 'Продолжение '.repeat(20) + 'готово.' };
  const emitted: string[] = [];
  const stream = new ReplySentences(90, text => emitted.push(text));
  stream.feed(JSON.stringify(raw)); stream.finish(cleanReply(raw, 90));
  expect(emitted.join(' ')).toBe(cleanReply(raw, 90).text);
  expect(emitted.join(' ').length).toBeLessThanOrEqual(90);
});

test('a substantial first clause can start audio before a long sentence finishes', () => {
  const emitted: string[] = [];
  const text = 'Если мы договоримся о времени встречи заранее и проверим новый маршрут, добраться до места получится гораздо быстрее.';
  const stream = new ReplySentences(240, chunk => emitted.push(chunk));
  stream.feed('{"speak":true,"text":"' + text.slice(0, 100));
  expect(emitted).toEqual(['Если мы договоримся о времени встречи заранее и проверим новый маршрут,']);
  stream.feed(JSON.stringify({ speak: true, text })); stream.finish({ speak: true, text });
  expect(emitted.join(' ')).toBe(text);
});

test('already available tiny opening and continuation share one synthesis chunk', () => {
  const emitted: string[] = [];
  const stream = new ReplySentences(240, chunk => emitted.push(chunk));
  stream.feed(JSON.stringify({ speak: true, text: 'Да. Лучше встретиться у метро.' }));
  expect(emitted).toEqual(['Да. Лучше встретиться у метро.']);
});

test('a closed unpunctuated text field streams before the provider terminal event', () => {
  const chunks: string[] = [];
  const stream = new ReplySentences(240, chunk => chunks.push(chunk));
  stream.feed('{"speak":true,"text":"Готово"');
  expect(chunks).toEqual(['Готово']);
  stream.finish({ speak: true, text: 'Готово' });
  expect(chunks).toEqual(['Готово']);
});

test('speak=false never emits and noncanonical JSON falls back to the validated answer', () => {
  const emitted: string[] = [];
  const silent = new ReplySentences(650, text => emitted.push(text));
  silent.feed('{"speak":false,"text":"Не озвучивать. "}'); silent.finish({ speak: false, text: '' });
  expect(emitted).toEqual([]);
  const reordered = new ReplySentences(650, text => emitted.push(text));
  reordered.feed('{"text":"Да, слышу.","speak":true}');
  expect(emitted).toEqual([]);
  reordered.finish({ speak: true, text: 'Да, слышу.' }); expect(emitted).toEqual(['Да, слышу.']);
});

test('real Opus playback starts before response.completed and survives a slow next sentence', async () => {
  const f = fixture(); const task = f.room.tick();
  try {
    await f.ready;
    f.delta('{"speak":true,"text":"Да, я здесь. ');
    await within(f.audible);
    expect(f.brain.contextMetrics(f.room.sessionId)?.calls).toBe(0);
    expect(f.synthesized).toEqual(['Да, я здесь.']);
    // The 200ms first sentence finishes before the second sentence arrives.
    await Bun.sleep(550);
    expect(f.room.phase).toBe('speaking');
    f.delta('Слышу тебя."}'); f.complete();
    await within(task);
    expect(f.synthesized).toEqual(['Да, я здесь.', 'Слышу тебя.']);
    expect(f.room.diagnostics.spokenReplies).toBe(1);
    expect(f.room.events.find(e => e.kind === 'assistant')?.text).toBe('Да, я здесь. Слышу тебя.');
    const stages = f.traces.map(t => t.stage);
    expect(stages.indexOf('first_audio')).toBeLessThan(stages.indexOf('model_completed'));
    expect(f.traces.find(t => t.stage === 'playback_finished')!.streamWaitMs).toBeGreaterThan(0);
    expect(f.traces.find(t => t.stage === 'model_completed')!.cachedTokens).toBe(64);
    expect(f.player.metrics.maxBufferedPackets).toBeLessThanOrEqual(4);
    expect(f.player.metrics.underruns).toBe(0);
    expect(JSON.stringify(f.traces)).not.toContain('Да, я здесь');
  } finally { f.close(); await within(task); }
}, 8000);

test('late quota failure stops early audio, records interruption and pauses without replay', async () => {
  const f = fixture(); const task = f.room.tick();
  try {
    await f.ready; f.delta('{"speak":true,"text":"Да, я здесь. ');
    await within(f.audible); await Bun.sleep(80); f.fail();
    await within(task);
    expect(f.room.phase).toBe('paused'); expect(f.calls()).toBe(1);
    expect(f.room.events.some(e => e.kind === 'assistant')).toBe(false);
    expect(f.room.events.find(e => e.kind === 'interrupted')!.playedMs).toBeGreaterThan(0);
    expect(f.room.diagnostics.lastError).toContain('ChatGPT plan usage limit reached');
  } finally { f.close(); await within(task); }
}, 8000);

test('connection reset after a streamed sentence is never retried', async () => {
  const f = fixture(); const task = f.room.tick();
  try {
    await f.ready; f.delta('{"speak":true,"text":"Да, я здесь. ');
    await within(f.audible); await Bun.sleep(60); f.breakStream(); await within(task);
    expect(f.calls()).toBe(1); expect(f.room.diagnostics.spokenReplies).toBe(0);
    expect(f.room.events.some(e => e.kind === 'interrupted')).toBe(true);
  } finally { f.close(); await within(task); }
}, 8000);

test('stop during streaming cancels both the model and audio, retaining only partial delivery', async () => {
  const f = fixture(); const task = f.room.tick();
  try {
    await f.ready; f.delta('{"speak":true,"text":"Да, я здесь. ');
    await within(f.audible); await Bun.sleep(60); f.room.stop(); await within(task);
    expect(f.room.phase).toBe('idle'); expect(f.cancelled()).toBe(true);
    expect(f.room.events.some(e => e.kind === 'assistant')).toBe(false);
    expect(f.room.events.some(e => e.kind === 'interrupted')).toBe(true);
    expect(f.synthesized).toEqual(['Да, я здесь.']);
  } finally { f.close(); await within(task); }
}, 8000);

test('synthesis failure cancels the outstanding model stream and is reported as synthesis failure', async () => {
  const f = fixture(true, true); const task = f.room.tick();
  try {
    await f.ready; f.delta('{"speak":true,"text":"Да, я здесь. '); await within(task);
    expect(f.room.diagnostics.lastError).toContain('fixture synthesis failure');
    expect(f.cancelled()).toBe(true); expect(f.room.diagnostics.spokenReplies).toBe(0);
  } finally { f.close(); await within(task); }
}, 8000);

test('buffered mode waits for completion before synthesis', async () => {
  const f = fixture(false); const task = f.room.tick();
  try {
    await f.ready; f.delta('{"speak":true,"text":"Да, я здесь."}');
    await Bun.sleep(40); expect(f.synthesized).toEqual([]);
    f.complete(); await within(task);
    expect(f.synthesized).toEqual(['Да, я здесь.']);
    expect(f.room.diagnostics.spokenReplies).toBe(1);
  } finally { f.close(); await within(task); }
}, 8000);

test('a streaming silence decision never starts synthesis or records a spoken reply', async () => {
  const f = fixture(); const task = f.room.tick();
  try {
    await f.ready; f.delta('{"speak":false,"text":""}'); f.complete(); await within(task);
    expect(f.synthesized).toEqual([]); expect(f.room.diagnostics.modelPasses).toBe(1);
    expect(f.room.events.some(e => e.kind === 'assistant' || e.kind === 'interrupted')).toBe(false);
  } finally { f.close(); await within(task); }
}, 8000);

test('a malformed final decision after early speech is interrupted rather than committed', async () => {
  const f = fixture(); const task = f.room.tick();
  try {
    await f.ready; f.delta('{"speak":true,"text":"Да, я здесь. ');
    await within(f.audible); await Bun.sleep(60);
    f.delta('Хвост", "speak":false}'); f.complete(); await within(task);
    expect(f.room.diagnostics.spokenReplies).toBe(0);
    expect(f.brain.contextMetrics(f.room.sessionId)?.calls).toBe(0);
    expect(f.room.events.some(e => e.kind === 'interrupted')).toBe(true);
    expect(f.room.diagnostics.lastError).toContain('differs');
  } finally { f.close(); await within(task); }
}, 8000);

test('a local thinking cue and streamed answer share the real player without colliding', async () => {
  const f = fixture(true, false, { thinkingCueDelayMs: 15, replyStartQuietMs: 1 }, 'Лёва, расскажи о плане.');
  const task = f.room.tick();
  try {
    await f.ready; await within(f.cueAudible);
    expect(f.room.diagnostics.lastFirstAudioMs).toBe(0);
    f.delta('{"speak":true,"text":"Встретимся у метро."}'); f.complete();
    await within(task);
    expect(f.room.diagnostics.spokenReplies).toBe(1);
    expect(f.room.diagnostics.thinkingCues).toBe(1);
    expect(f.room.events.filter(e => e.kind === 'assistant').map(e => e.text)).toEqual(['Хм.', 'Встретимся у метро.']);
    expect(f.player.metrics.underruns).toBe(0);
    expect(f.room.diagnostics.lastError).toBe('');
  } finally { f.close(); await within(task); }
}, 8000);

test('human speech stops a real thinking cue without aborting the pending model answer', async () => {
  const f = fixture(true, false, { thinkingCueDelayMs: 15, replyStartQuietMs: 1 }, 'Лёва, расскажи о плане.');
  const task = f.room.tick();
  try {
    await f.ready; await within(f.cueAudible); await Bun.sleep(30);
    f.room.activity('1', true); await Bun.sleep(30);
    expect(f.cancelled()).toBe(false);
    f.room.activity('1', false); await Bun.sleep(10);
    f.delta('{"speak":true,"text":"Встретимся у метро."}'); f.complete();
    await within(task);
    expect(f.room.diagnostics.spokenReplies).toBe(1);
    expect(f.room.events.some(e => e.kind === 'interrupted')).toBe(true);
    expect(f.room.diagnostics.lastError).toBe('');
  } finally { f.close(); await within(task); }
}, 8000);
