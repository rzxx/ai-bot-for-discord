import { test, expect } from 'bun:test';
import { defaults } from '../src/config';
import type { Config } from '../src/config';
import { RoomController, type Player, type Playback } from '../src/room';
import { TaskQueue } from '../src/queue';
import { OpenAIError } from '../src/auth';
import { InferenceError } from '../src/inference-error';
import type { Brain, RoomSnapshot, Reply } from '../src/llm';
import type { Speaker, Transcriber } from '../src/speech';
import type { ToolHost } from '../src/room-tools';

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const alice = { id: '1', name: 'Алёна' }, bob = { id: '2', name: 'Лёша' };
function fixture(brainImpl?: Brain['reply'], transcribe: Transcriber['transcribe'] = async () => '',
  options: { synthesize?: Speaker['synthesize']; convertOutput?: (wav: Buffer, signal: AbortSignal) => Promise<Buffer>; config?: Partial<Config>; tools?: ToolHost; canUseContext?: () => boolean } = {}) {
  let now = 100000;
  const snapshots: RoomSnapshot[] = [];
  const plays: { signal: AbortSignal; done: ReturnType<typeof deferred<Playback>> }[] = [];
  const brain: Brain = { reply: async (snapshot, signal) => { snapshots.push(snapshot); return brainImpl ? brainImpl(snapshot, signal) : { speak: true, text: 'Да, слышу вас обоих.' }; } };
  const player: Player = {
    play: (_audio, signal) => { const done = deferred<Playback>(); plays.push({ signal, done }); signal.addEventListener('abort', () => done.resolve({ completed: false, playedMs: 200 }), { once: true }); return done.promise; },
    stop: () => {},
  };
  const room = new RoomController({ ...defaults, botName: 'Лёва', speechLanguage: 'ru', sttEngine: 'gigaam', voice: 'eugene', roomQuietMs: 100, thinkingCues: false, ...options.config }, brain,
    { transcribe }, { synthesize: options.synthesize ?? (async () => Buffer.from('wav')) }, player, new TaskQueue(2), () => {},
    { autoTick: false, now: () => now, trace: () => {}, convertInput: async x => x, convertOutput: options.convertOutput ?? (async x => x), tools: options.tools, canUseContext: options.canUseContext });
  room.setMember(alice); room.setMember(bob);
  return { room, snapshots, plays, time: (delta = 200) => { now += delta; }, now: () => now };
}
async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); }

function toolHost(change: Partial<ToolHost> = {}): ToolHost {
  return { limits: new Map(), resolvePerson: () => bob, sendMessage: async () => {}, activity: () => ({ status: 'online', activity: 'Minecraft' }), ...change };
}

test('a new listener without text-channel access pauses retained chat context without rebuilding it', async () => {
  let visible = true;
  const f = fixture(undefined, async () => '', { canUseContext: () => visible });
  f.room.chat(alice, 'Информация только для участников канала.');
  visible = false; f.room.setMember({ id: 'new-person', name: 'Новый' });
  expect(f.room.phase).toBe('paused'); expect(() => f.room.resume()).toThrow('access');
  f.room.transcript(alice, 'Расскажи, что было в чате.'); f.time(); await f.room.tick();
  expect(f.snapshots).toHaveLength(0); expect(f.room.events.some(e => e.kind === 'chat')).toBe(true);
  visible = true; f.room.resume(); expect(f.room.phase).toBe('idle'); f.room.close();
});

test('chat retrieval acknowledges, admits evidence, silently opens context and answers through the room loop', async () => {
  const token = 'h' + '0'.repeat(16); let ownerEvent = 0, queries = 0;
  const f = fixture(async s => {
    if (f.snapshots.length === 1) { ownerEvent = s.responsePolicy!.triggerEventIds[0]!; return { speak: true, text: 'Проверю чат.', actions: [{ tool: 'chat', event: ownerEvent, op: 'history', channel: 'general' }] }; }
    if (f.snapshots.length === 2) return { speak: false, text: '', actions: [{ tool: 'chat', event: ownerEvent, op: 'continue', token, next: 'around', message: 'm1' }] };
    return { speak: true, text: 'Алекс прислал адрес сервера вчера.' };
  }, async () => '', { config: { chatTools: true, chatContext: false }, tools: toolHost({ chat: {
    query: async q => { queries++; return { status: 'ready', messages: [{ ref: 'm1', text: q.op === 'history' ? 'server address' : 'surrounding context' }], ...(queries === 1 ? { next: token } : {}) }; },
    continuationOwner: (_token, event) => event === ownerEvent ? alice.id : undefined,
    onSpeech() {}, cancel() {}, canUseContext: () => true,
  } }) });
  try {
    f.room.transcript(alice, 'Лёва, что Алекс прислал в чат general?'); f.time();
    const initial = f.room.tick(); await settle(); await f.room.tools!.settle();
    expect(queries).toBe(1); expect(f.plays).toHaveLength(1);
    f.plays[0]!.done.resolve({ completed: true, playedMs: 300 }); await initial;
    f.time(); await f.room.tick(); await f.room.tools!.settle(); expect(queries).toBe(2); expect(f.plays).toHaveLength(1);
    f.time(); const answer = f.room.tick(); await settle(); expect(f.plays).toHaveLength(2);
    expect(f.snapshots[2]!.events.some(e => e.kind === 'tool' && e.text.includes('surrounding context'))).toBe(true);
    f.plays[1]!.done.resolve({ completed: true, playedMs: 300 }); await answer;
  } finally { f.room.close(); }
});

test('retained retrieval sources gate inference and resume even with passive chat disabled', async () => {
  let visible = true, canceled = 0;
  const f = fixture(undefined, async () => '', { config: { chatTools: true, chatContext: false }, tools: toolHost({ chat: {
    query: async () => ({ status: 'empty' }), continuationOwner: () => undefined,
    onSpeech() {}, cancel: () => { canceled++; }, canUseContext: () => visible,
  } }) });
  visible = false; f.room.setMember({ id: 'new-listener', name: 'New listener' });
  expect(f.room.phase).toBe('paused'); expect(() => f.room.resume()).toThrow('access'); expect(canceled).toBeGreaterThan(0);
  f.room.transcript(alice, 'Лёва, что было в чате?'); f.time(); await f.room.tick(); expect(f.snapshots).toHaveLength(0);
  visible = true; f.room.resume(); expect(f.room.phase).toBe('idle'); f.room.close();
});

test('audience changes cancel pending retrieval and an ignoring host cannot return a late receipt', async () => {
  let signal!: AbortSignal; const lookup = deferred<{ status: string; text: string }>();
  const f = fixture(async s => ({ speak: true, text: 'Проверю.', actions: [{ tool: 'chat', event: s.responsePolicy!.triggerEventIds[0]!, op: 'history' }] }),
    async () => '', { config: { chatTools: true }, tools: toolHost({ chat: {
      query: async (_q, _owner, _event, s) => { signal = s; return lookup.promise; },
      continuationOwner: () => undefined, onSpeech() {}, cancel() {}, canUseContext: () => true,
    } }) });
  try {
    f.room.transcript(alice, 'Лёва, прочти чат.'); f.time(); const turn = f.room.tick(); await settle();
    f.room.setMember({ id: 'new-listener', name: 'New listener' }); expect(signal.aborted).toBe(true);
    await f.room.tools!.settle(); lookup.resolve({ status: 'ready', text: 'late private content' }); await settle();
    expect(f.room.events.some(e => e.kind === 'tool' && e.text.includes('late private content'))).toBe(false);
    f.plays[0]!.done.resolve({ completed: true, playedMs: 300 }); await turn;
  } finally { f.room.close(); }
});

test('expired or canceled model replies cannot execute side effects', async () => {
  const pending = deferred<Reply>(); let sends = 0;
  const f = fixture(async () => pending.promise, async () => '', { tools: toolHost({ sendMessage: async () => { sends++; } }) });
  const event = f.room.transcript(alice, 'Напиши Лёше, чтобы заходил.'); f.time(); const task = f.room.tick(); await settle();
  f.time(defaults.maxResponseAgeMs + 1);
  pending.resolve({ speak: true, text: 'Отправляю.', actions: [{ tool: 'message', event: event!, text: 'Заходи!' }] });
  await task; await f.room.tools!.settle(); expect(sends).toBe(0); expect(f.plays).toHaveLength(0); f.room.close();
});

test('a failed message returns one explanation opportunity and cannot create a tool-only retry loop', async () => {
  let sends = 0;
  const f = fixture(async s => ({ speak: false, text: '', actions: [{ tool: 'message', event: s.responsePolicy!.triggerEventIds[0]!, text: 'Привет!', mentions: ['unknown'] }] }),
    async () => '', { tools: toolHost({ resolvePerson: () => undefined, sendMessage: async () => { sends++; } }) });
  try {
    f.room.transcript(alice, 'Напечатай привет в общий чат.'); f.time(); await f.room.tick(); await f.room.tools!.settle();
    expect(f.room.events.some(e => e.kind === 'tool' && JSON.parse(e.text).status === 'unknown_person')).toBe(true);
    f.time(); await f.room.tick(); await f.room.tools!.settle();
    expect(f.snapshots).toHaveLength(2); expect(sends).toBe(0);
    expect(f.snapshots[1]!.responsePolicy!.triggerEventIds.every(id => f.snapshots[1]!.events.find(e => e.id === id)?.kind === 'tool')).toBe(true);
    f.time(); await f.room.tick(); expect(f.snapshots).toHaveLength(2);
  } finally { f.room.close(); }
});

test('reminder failures yield to a new topic while actual due reminders keep their own delivery intent', async () => {
  const f = fixture(async s => f.snapshots.length === 1 ? { speak: false, text: '', actions: [{ tool: 'remind', event: s.responsePolicy!.triggerEventIds[0]!, seconds: 30, text: 'Проверь чай.' }] }
    : { speak: false, text: '' }, async () => '', { config: { reminderTools: false }, tools: toolHost() });
  try {
    f.room.transcript(alice, 'Напомни мне про чай через полминуты.'); f.time(); await f.room.tick(); await f.room.tools!.settle();
    expect(f.room.events.some(e => e.kind === 'tool' && JSON.parse(e.text).status === 'disabled')).toBe(true);
    f.room.transcript(bob, 'Какую карту выберем?'); f.time(); await f.room.tick();
    expect(f.snapshots).toHaveLength(2);
    expect(f.snapshots[1]!.responsePolicy!.triggerEventIds.every(id => f.snapshots[1]!.events.find(e => e.id === id)?.kind === 'speech')).toBe(true);
  } finally { f.room.close(); }
});

test('a search never blocks the initial spoken reply and returns through the ordinary room loop', async () => {
  const lookup = deferred<any[]>(); let searchStarted = false;
  const f = fixture(async s => s.responsePolicy!.triggerEventIds.some(id => s.events.find(e => e.id === id)?.kind === 'speech')
    ? { speak: true, text: 'Не уверен, сейчас проверю.', actions: [{ tool: 'search', event: s.responsePolicy!.triggerEventIds[0]!, query: 'Minecraft release' }] }
    : { speak: true, text: 'Проверил, вышло новое обновление.' }, async () => '', { tools: toolHost({ search: async () => { searchStarted = true; return lookup.promise; } }) });
  f.room.transcript(alice, 'Лёва, поищи последнее обновление игры.'); f.time();
  const first = f.room.tick(); await settle();
  expect(searchStarted).toBe(true); expect(f.plays).toHaveLength(1); expect(f.snapshots).toHaveLength(1);
  lookup.resolve([{ title: 'News', snippet: 'New release', url: 'https://www.minecraft.net/' }]); await f.room.tools!.settle();
  expect(f.plays).toHaveLength(1); // One audio player; no overlapping follow-up.
  f.plays[0]!.done.resolve({ completed: true, playedMs: 600 }); await first;
  f.time(); const followup = f.room.tick(); await settle();
  expect(f.snapshots).toHaveLength(2); expect(f.plays).toHaveLength(2);
  expect(f.snapshots[1]!.events.some(e => e.kind === 'tool' && e.text.includes('New release'))).toBe(true);
  f.plays[1]!.done.resolve({ completed: true, playedMs: 700 }); await followup; f.room.close();
});

test('the agent can silently refine weak search evidence and then answer through the voice loop', async () => {
  let searches = 0;
  const f = fixture(async s => {
    if (f.snapshots.length === 1) return { speak: true, text: 'Сейчас проверю.', actions: [{ tool: 'search', event: s.responsePolicy!.triggerEventIds[0]!, query: 'Minecraft release' }] };
    if (f.snapshots.length === 2) {
      const receipt = JSON.parse(s.events.find(e => s.responsePolicy!.triggerEventIds.includes(e.id) && e.kind === 'tool')!.text);
      return { speak: false, text: '', actions: [{ tool: 'search', event: receipt.event, query: 'Minecraft release exact date', continue: receipt.next }] };
    }
    return { speak: true, text: 'Нашёл точную дату.' };
  }, async () => '', { tools: toolHost({ search: async () => {
    searches++; return [{ title: 'Source', snippet: searches === 1 ? 'An announcement without the date.' : 'The exact release date is documented.', url: `https://source${searches}.org/` }];
  } }) });
  try {
    f.room.transcript(alice, 'Лёва, найди дату выхода обновления.'); f.time();
    const initial = f.room.tick(); await settle(); await f.room.tools!.settle();
    f.plays[0]!.done.resolve({ completed: true, playedMs: 300 }); await initial;
    f.time(); await f.room.tick(); await f.room.tools!.settle();
    expect(searches).toBe(2); expect(f.plays).toHaveLength(1);
    f.time(); const answer = f.room.tick(); await settle();
    expect(f.plays).toHaveLength(2); expect(f.snapshots).toHaveLength(3);
    f.plays[1]!.done.resolve({ completed: true, playedMs: 300 }); await answer;
  } finally { f.room.close(); }
});

test('new conversation cancels outstanding web work and late results cannot resurrect the topic', async () => {
  const lookup = deferred<any[]>(); let signal!: AbortSignal;
  const f = fixture(async s => f.snapshots.length === 1 ? { speak: true, text: 'Проверю.', actions: [{ tool: 'search', event: s.responsePolicy!.triggerEventIds[0]!, query: 'Minecraft release' }] } : { speak: true, text: 'Обсудим новую карту.' },
    async () => '', { tools: toolHost({ search: (_query, s) => { signal = s; return lookup.promise; } }) });
  f.room.transcript(alice, 'Лёва, поищи обновление.'); f.time(); const first = f.room.tick(); await settle();
  f.plays[0]!.done.resolve({ completed: true, playedMs: 300 }); await first;
  f.room.transcript(bob, 'Какую карту выберем?'); expect(signal.aborted).toBe(true);
  await f.room.tools!.settle(); lookup.resolve([{ title: 'Late', snippet: 'Old topic', url: 'https://www.minecraft.net/' }]); await settle();
  f.time(); const second = f.room.tick(); await settle();
  expect(f.snapshots[1]!.responsePolicy!.triggerEventIds.every(id => f.snapshots[1]!.events.find(e => e.id === id)?.kind === 'speech')).toBe(true);
  expect(f.room.events.some(e => e.kind === 'tool' && e.text.includes('Old topic'))).toBe(false);
  f.plays[1]!.done.resolve({ completed: true, playedMs: 400 }); await second;
  f.time(); await f.room.tick(); expect(f.snapshots).toHaveLength(2); f.room.close();
});

test('new speech also cancels a web follow-up that is already generating', async () => {
  const oldAnswer = deferred<Reply>();
  const f = fixture(async s => f.snapshots.length === 1 ? { speak: true, text: 'Проверю.', actions: [{ tool: 'search', event: s.responsePolicy!.triggerEventIds[0]!, query: 'Minecraft release' }] }
    : f.snapshots.length === 2 ? oldAnswer.promise : { speak: true, text: 'Сейчас про новую карту.' }, async () => '', { tools: toolHost({ search: async () => [{ title: 'News', snippet: 'Result', url: 'https://www.minecraft.net/' }] }) });
  f.room.transcript(alice, 'Лёва, поищи обновление.'); f.time(); const first = f.room.tick(); await settle(); await f.room.tools!.settle();
  f.plays[0]!.done.resolve({ completed: true, playedMs: 300 }); await first;
  f.time(); const stale = f.room.tick(); await settle(); expect(f.snapshots).toHaveLength(2);
  f.room.transcript(bob, 'Какую новую карту выберем?'); oldAnswer.resolve({ speak: true, text: 'Устаревший результат поиска.' }); await stale;
  expect(f.plays).toHaveLength(1);
  f.time(); const next = f.room.tick(); await settle(); expect(f.plays).toHaveLength(2);
  f.plays[1]!.done.resolve({ completed: true, playedMs: 300 }); await next; f.room.close();
});

test('a reminder uses the normal speech loop without another human utterance', async () => {
  const f = fixture(async s => f.snapshots.length === 1 ? { speak: false, text: '', actions: [{ tool: 'remind', event: s.responsePolicy!.triggerEventIds[0]!, seconds: 5, text: 'Алёна, пора проверить чай!' }] }
    : { speak: true, text: 'Алёна, пора проверить чай!' }, async () => '', { tools: toolHost() });
  f.room.transcript(alice, 'Напомни мне проверить чай через пять секунд.'); f.time(); await f.room.tick();
  expect(f.plays).toHaveLength(0); f.time(5000); const due = f.room.tick(); await settle();
  expect(f.snapshots).toHaveLength(2); expect(f.snapshots[1]!.events.some(e => e.kind === 'tool' && e.text.includes('due'))).toBe(true);
  f.plays[0]!.done.resolve({ completed: true, playedMs: 500 }); await due; f.time(); await f.room.tick(); expect(f.snapshots).toHaveLength(2); f.room.close();
});

test('a process timer result wakes a fresh room, but cannot run another privileged action', async () => {
  let sends = 0;
  const f = fixture(async s => ({ speak: true, text: 'Алёна, пора проверить чай!', actions: [{ tool: 'message', event: s.responsePolicy!.triggerEventIds[0]!, text: 'Не должно отправиться' }] }),
    async () => '', { tools: toolHost({ sendMessage: async () => { sends++; } }) });
  expect(f.room.remind(alice.id, [{ id: 'r100', text: 'Проверь чай.' }])).toBe(true);
  f.time(); const task = f.room.tick(); await settle();
  expect(f.snapshots).toHaveLength(1); expect(f.plays).toHaveLength(1); expect(f.snapshots[0]!.events.some(e => e.kind === 'speech')).toBe(false);
  await f.room.tools!.settle(); expect(sends).toBe(0);
  f.plays[0]!.done.resolve({ completed: true, playedMs: 500 }); await task;
  f.room.removeMember(alice.id); expect(f.room.remind(alice.id, [{ id: 'r101', text: 'Ещё одно.' }])).toBe(false); f.room.close();
});

test('live text chat is bounded, sanitized background and never triggers inference by itself', async () => {
  const f = fixture(); f.room.chat(bob, 'Привет https://host.test/link @everyone <@&role>');
  f.room.chat(bob, 'duplicate'); f.room.chat(alice, 'x'.repeat(2001)); f.time(); await f.room.tick();
  expect(f.snapshots).toHaveLength(0); expect(f.room.events.filter(e => e.kind === 'chat').map(e => e.text)).toEqual(['Привет']);
  f.room.transcript(alice, 'Лёва, что написал Лёша?'); f.time(); const task = f.room.tick(); await settle();
  expect(f.snapshots[0]!.events.some(e => e.kind === 'chat' && e.text === 'Привет')).toBe(true);
  f.plays[0]!.done.resolve({ completed: true, playedMs: 300 }); await task; f.room.close();
});

test('a Plus sharing limit pauses the room and prevents repeated model calls', async () => {
  const f = fixture(async () => { throw new OpenAIError(0, 'subscription_sharing_usage_limit_exceeded', 'Limit reached'); });
  f.room.transcript(alice, 'Ты меня слышишь?'); f.time(); await f.room.tick();
  expect(f.room.phase).toBe('paused'); expect(f.plays).toHaveLength(0);
  expect(f.room.diagnostics.lastError).toContain('ChatGPT plan usage limit reached');
  f.time(); await f.room.tick();
  expect(f.snapshots).toHaveLength(1); f.room.close();
});

test('an alternate provider can pause the room on quota without an OpenAI-specific error', async () => {
  const f = fixture(async () => { throw new InferenceError(429, 'fixture_quota', 'Provider allowance exhausted.', true); });
  f.room.transcript(alice, 'Can you help?'); f.time(); await f.room.tick();
  expect(f.room.phase).toBe('paused'); expect(f.plays).toHaveLength(0);
  expect(f.room.diagnostics.lastError).toContain('Provider allowance exhausted.');
  f.time(); await f.room.tick(); expect(f.snapshots).toHaveLength(1); f.room.close();
});

test('a new question during playback is retained without aborting, then answered', async () => {
  const f = fixture();
  f.room.transcript(alice, 'Ты слышишь нас?', f.now()); f.time();
  const first = f.room.tick(); await settle();
  expect(f.room.phase).toBe('speaking');
  f.room.activity(bob.id, true); f.room.transcript(bob, 'А как меня зовут?', f.now());
  expect(f.plays[0]!.signal.aborted).toBe(false);
  await f.room.tick(); expect(f.snapshots.length).toBe(1);
  f.room.activity(bob.id, false);
  f.plays[0]!.done.resolve({ completed: true, playedMs: 2500 }); await first;
  f.time(); const second = f.room.tick(); await settle();
  expect(f.snapshots.length).toBe(2);
  expect(f.snapshots[1]!.events.some(e => e.text === 'А как меня зовут?' && e.userId === bob.id)).toBe(true);
  expect(f.snapshots[1]!.events.some(e => e.kind === 'assistant')).toBe(true);
  f.plays[1]!.done.resolve({ completed: true, playedMs: 900 }); await second; f.room.close();
});

test('next-turn context distinguishes comments during playback, after playback and late STT', async () => {
  const recognized = deferred<string>();
  const f = fixture(undefined, () => recognized.promise);
  f.room.transcript(alice, 'Расскажи длинную историю.'); f.time();
  const first = f.room.tick(); await settle();
  const startedAt = f.now() + 150; // Encoding finishes before actual playback begins.
  f.time(1000);
  const commentAt = f.now();
  f.room.transcript(bob, 'А что было дальше?', commentAt, commentAt + 200);
  f.room.ingest(alice, { pcm: Buffer.alloc(8), startedAt: commentAt + 100, endedAt: commentAt + 400, speechMs: 300 });
  await settle();
  f.time(2000); const endedAt = f.now() - 30;
  f.plays[0]!.done.resolve({ completed: true, playedMs: endedAt - startedAt, startedAt, endedAt }); await first;
  f.room.transcript(bob, 'Спасибо за историю.');
  recognized.resolve('Герой вернулся домой?'); await settle(); f.time();
  const second = f.room.tick(); await settle();
  const events = f.snapshots[1]!.events;
  const delivery = events.find(e => e.kind === 'assistant')!;
  expect(delivery).toMatchObject({ at: startedAt, end: endedAt, playedMs: endedAt - startedAt });
  for (const text of ['А что было дальше?', 'Герой вернулся домой?']) {
    const speech = events.find(e => e.text === text)!;
    expect(speech.at).toBeGreaterThan(delivery.at);
    expect(speech.end!).toBeLessThan(delivery.end!);
  }
  expect(events.find(e => e.text === 'Спасибо за историю.')!.at).toBeGreaterThan(delivery.end!);
  expect(f.snapshots[1]!.timeline!.sinceLastBotSpeechMs).toBe(f.now() - endedAt);
  f.plays[1]!.done.resolve({ completed: true, playedMs: 900 }); await second; f.room.close();
});

test('a question starts preparation during other speech, while playback waits for an opening', async () => {
  const f = fixture(); f.room.transcript(alice, 'Начинаем?'); f.room.activity(bob.id, true); f.time();
  const task = f.room.tick(); await settle();
  expect(f.snapshots).toHaveLength(1); expect(f.plays).toHaveLength(0);
  expect(f.snapshots[0]!.responsePolicy?.preparingEarly).toBe(true);
  f.room.activity(bob.id, false); f.time(); await Bun.sleep(55);
  expect(f.plays).toHaveLength(1);
  f.room.stop(); await task; f.room.close();
});

test('new speech during generation keeps the reply and is answered in the next turn', async () => {
  const generated = deferred<Reply>(); let signal: AbortSignal | undefined;
  const f = fixture(async (_snapshot, s) => { signal = s; return f.snapshots.length === 1 ? generated.promise : { speak: true, text: 'Теперь обсудим погоду.' }; });
  f.room.transcript(alice, 'Расскажи историю.'); f.time(); const first = f.room.tick(); await settle();
  f.room.activity(bob.id, true); f.room.transcript(bob, 'А потом расскажи про погоду.');
  expect(signal!.aborted).toBe(false);
  generated.resolve({ speak: true, text: 'Жили-были…' }); await settle();
  expect(f.plays).toHaveLength(0);
  expect(f.room.activeSpeakers).toBe(1); expect(f.room.diagnostics.staleReplies).toBe(0);
  await f.room.tick(); expect(f.snapshots).toHaveLength(1);
  f.room.activity(bob.id, false);
  f.time(); await Bun.sleep(55); expect(f.plays).toHaveLength(1);
  f.plays[0]!.done.resolve({ completed: true, playedMs: 1200 }); await first;
  f.time(); const second = f.room.tick(); await settle();
  expect(f.snapshots).toHaveLength(2);
  expect(f.snapshots[1]!.events.some(e => e.text === 'А потом расскажи про погоду.')).toBe(true);
  f.plays[1]!.done.resolve({ completed: true, playedMs: 900 }); await second;
  f.time(); await f.room.tick(); expect(f.snapshots).toHaveLength(2);
  expect(f.room.diagnostics.spokenReplies).toBe(2); f.room.close();
});

test('pending recognition of later speech does not delay a prepared reply', async () => {
  const generated = deferred<Reply>(), recognized = deferred<string>();
  const f = fixture(() => generated.promise, () => recognized.promise);
  f.room.transcript(alice, 'Привет.'); f.time(); const task = f.room.tick(); await settle();
  f.room.ingest(bob, { pcm: Buffer.alloc(8), startedAt: f.now(), endedAt: f.now(), speechMs: 400 });
  generated.resolve({ speak: true, text: 'Привет!' }); await settle();
  expect(f.room.pendingSTT).toBe(1); expect(f.plays).toHaveLength(1);
  recognized.resolve('И меня поприветствуй.'); await settle();
  expect(f.room.pendingSTT).toBe(0); expect(f.plays[0]!.signal.aborted).toBe(false);
  f.plays[0]!.done.resolve({ completed: true, playedMs: 500 }); await task;
  expect(f.room.events.some(e => e.text === 'И меня поприветствуй.')).toBe(true); f.room.close();
});

for (const stage of ['synthesis', 'conversion'] as const) {
  test(`new speech during ${stage} retains preparation but waits for an opening`, async () => {
    const prepared = deferred<Buffer>();
    const f = fixture(undefined, undefined, stage === 'synthesis'
      ? { synthesize: () => prepared.promise } : { convertOutput: () => prepared.promise });
    f.room.transcript(alice, 'Поздоровайся.'); f.time(); const task = f.room.tick(); await settle();
    f.room.activity(bob.id, true); f.room.transcript(bob, 'А меня слышно?');
    prepared.resolve(Buffer.from('audio')); await settle();
    expect(f.plays).toHaveLength(0);
    f.room.activity(bob.id, false); f.time(); await Bun.sleep(55);
    expect(f.room.phase).toBe('speaking'); expect(f.plays).toHaveLength(1);
    expect(f.room.diagnostics.staleReplies).toBe(0);
    f.plays[0]!.done.resolve({ completed: true, playedMs: 500 }); await task; f.room.close();
  });

  test(`explicit stop during ${stage} still prevents playback when preparation ignores abort`, async () => {
    const prepared = deferred<Buffer>();
    const f = fixture(undefined, undefined, stage === 'synthesis'
      ? { synthesize: () => prepared.promise } : { convertOutput: () => prepared.promise });
    f.room.transcript(alice, 'Поздоровайся.'); f.time(); const task = f.room.tick(); await settle();
    f.room.stop(); prepared.resolve(Buffer.from('audio')); await task;
    expect(f.plays).toHaveLength(0); expect(f.room.phase).toBe('idle'); f.room.close();
  });
}

test('a reply that exceeds the response deadline is still discarded', async () => {
  const prepared = deferred<Buffer>();
  const f = fixture(undefined, undefined, { synthesize: () => prepared.promise });
  f.room.transcript(alice, 'Поздоровайся.'); f.time(); const task = f.room.tick(); await settle();
  f.time(defaults.maxResponseAgeMs + 1); prepared.resolve(Buffer.from('audio')); await task;
  expect(f.plays).toHaveLength(0); expect(f.room.diagnostics.staleReplies).toBe(1); f.room.close();
});

test('explicit stop invalidates an in-flight generation, including providers that ignore abort', async () => {
  const generated = deferred<Reply>(); const f = fixture(() => generated.promise);
  f.room.transcript(alice, 'Расскажи историю.'); f.time(); const task = f.room.tick(); await settle();
  f.room.stop(); generated.resolve({ speak: true, text: 'Жили-были…' }); await task;
  expect(f.plays.length).toBe(0); f.time(); await f.room.tick(); expect(f.snapshots.length).toBe(1); f.room.close();
});

test('pause survives completion of an in-flight task and discards new transcripts', async () => {
  const generated = deferred<Reply>(); const f = fixture(() => generated.promise);
  f.room.transcript(alice, 'Привет.'); f.time(); const task = f.room.tick(); await settle();
  f.room.pause(); f.room.transcript(bob, 'Не передавай это модели.');
  generated.resolve({ speak: true, text: 'Привет!' }); await task;
  expect(f.room.phase).toBe('paused'); expect(f.plays.length).toBe(0);
  expect(f.room.events.some(e => e.text.includes('Не передавай'))).toBe(false); f.room.close();
});

test('capture times determine order, identities survive equal names, and leave changes current roster', () => {
  const f = fixture(); f.room.setMember({ ...bob, name: 'Алёна' });
  f.room.transcript(bob, 'Вторая фраза.', 100100, 100150);
  f.room.transcript(alice, 'Первая фраза.', 100000, 100050);
  f.room.removeMember(bob.id);
  const snapshot = f.room.snapshot();
  expect(snapshot.members).toEqual([alice]);
  expect(snapshot.events.filter(e => e.kind === 'speech').map(e => e.userId)).toEqual([alice.id, bob.id]);
  expect(snapshot.events.some(e => e.kind === 'leave' && e.userId === bob.id)).toBe(true); f.room.close();
});

test('session history survives a long pause, and stopping an unspoken reply does not invent bot speech', () => {
  const f = fixture();
  f.room.transcript(alice, 'Наш разговор всё ещё продолжается.');
  f.time(60 * 60 * 1000);
  const before = f.room.snapshot();
  expect(before.events.some(e => e.text === 'Наш разговор всё ещё продолжается.')).toBe(true);
  expect(before.timeline?.quietForMs).toBe(60 * 60 * 1000);
  f.room.stop();
  expect(f.room.snapshot().timeline?.sinceLastBotSpeechMs).toBeNull();
  f.room.close(); expect(f.room.events).toHaveLength(0);
});

test('stop during playback marks partial delivery instead of claiming the whole answer was heard', async () => {
  const f = fixture(); f.room.transcript(alice, 'Скажи что-нибудь.'); f.time();
  const task = f.room.tick(); await settle(); const startedAt = f.now();
  f.time(200); f.room.stop(); await task;
  expect(f.room.events.find(e => e.kind === 'interrupted')).toMatchObject({ at: startedAt, end: f.now(), playedMs: 200 });
  expect(f.room.events.some(e => e.kind === 'assistant')).toBe(false); f.room.close();
});

test('a short Russian acknowledgment does not discard a pending reply', async () => {
  const generated = deferred<Reply>(); const f = fixture(() => generated.promise);
  f.room.transcript(alice, 'Как дела?'); f.time(); const task = f.room.tick(); await settle();
  f.room.transcript(bob, 'Ага.'); f.time();
  generated.resolve({ speak: true, text: 'Всё хорошо!' }); await settle();
  expect(f.plays).toHaveLength(1); f.room.stop(); await task; f.room.close();
});

test('only an explicit Russian stop addressed to the bot stops playback', async () => {
  const f = fixture(); f.room.transcript(alice, 'Поздоровайся.'); f.time(); const task = f.room.tick(); await settle();
  f.room.transcript(bob, 'Я сказал ему стоп.'); expect(f.plays[0]!.signal.aborted).toBe(false);
  f.room.transcript(bob, 'Лёва, стоп, пожалуйста!'); expect(f.plays[0]!.signal.aborted).toBe(true);
  await task; f.room.close();
});

test('pause aborts running STT and skips queued audio instead of occupying the next turn', async () => {
  let calls = 0;
  let runningSignal: AbortSignal | undefined;
  const f = fixture(undefined, (_wav, _names, signal) => {
    calls++; runningSignal = signal;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true }));
  });
  const utterance = { pcm: Buffer.alloc(8), startedAt: f.now(), endedAt: f.now(), speechMs: 400 };
  f.room.ingest(alice, utterance); f.room.ingest(bob, utterance);
  await settle(); expect(calls).toBe(1); expect(f.room.pendingSTT).toBe(2);
  f.room.pause(); await settle();
  expect(runningSignal!.aborted).toBe(true);
  expect(calls).toBe(1); expect(f.room.pendingSTT).toBe(0);
  expect(f.room.events.some(e => e.kind === 'speech')).toBe(false);
  f.room.close();
});

test('backchannels, unrelated playback comments and late overlapping comments do not cause another turn', async () => {
  const f = fixture();
  f.room.transcript(alice, 'Расскажи историю.'); f.time();
  const task = f.room.tick(); await settle(); const start = f.now();
  f.time(100); f.room.transcript(bob, 'Ага.'); f.room.transcript(bob, 'Я сейчас возьму чай.'); f.room.transcript(bob, 'Нет, я не туда нажал.');
  f.time(500); const end = f.now();
  f.plays[0]!.done.resolve({ completed: true, playedMs: 600, startedAt: start, endedAt: end }); await task;
  f.room.transcript(bob, 'Открыл окно.', start + 200, start + 400); // late STT
  f.time(); await f.room.tick();
  expect(f.snapshots).toHaveLength(1);
  expect(f.room.events.filter(e => e.kind === 'speech')).toHaveLength(5);
  expect(f.room.diagnostics.backchannels).toBe(1); f.room.close();
});

test('a correction replaces an unspoken reply and retains the original request as a trigger', async () => {
  const generated = deferred<Reply>(); let oldSignal!: AbortSignal;
  const f = fixture(async (_snapshot, signal) => { oldSignal = signal; return f.snapshots.length === 1 ? generated.promise : { speak: true, text: 'Во вторник.' }; });
  f.room.transcript(alice, 'Лёва, напомни про встречу в понедельник.'); f.time();
  const old = f.room.tick(); await settle();
  f.room.transcript(alice, 'Нет, я имела в виду вторник.');
  expect(oldSignal.aborted).toBe(true);
  generated.resolve({ speak: true, text: 'В понедельник.' }); await old;
  expect(f.plays).toHaveLength(0);
  f.time(); const next = f.room.tick(); await settle();
  expect(f.snapshots[1]!.responsePolicy!.triggerEventIds).toHaveLength(2);
  expect(f.room.diagnostics.revisions).toBe(1);
  f.plays[0]!.done.resolve({ completed: true, playedMs: 700 }); await next; f.room.close();
});

test('the questioner can correct spoken output while another participant cannot cancel it with an unrelated correction', async () => {
  const f = fixture(); f.room.transcript(alice, 'Расскажи про встречу.'); f.time();
  const task = f.room.tick(); await settle();
  f.room.transcript(bob, 'Нет, я не туда нажал.');
  expect(f.plays[0]!.signal.aborted).toBe(false);
  f.room.transcript(alice, 'Нет, я имела в виду завтрашнюю встречу.');
  expect(f.plays[0]!.signal.aborted).toBe(true);
  await task;
  expect(f.room.diagnostics.yieldedReplies).toBe(1);
  expect(f.room.events.some(e => e.kind === 'interrupted')).toBe(true); f.room.close();
});

test('strict addressed connection checks use local speech without a model call', async () => {
  const f = fixture(); f.room.transcript(alice, 'Лёва, ты меня слышишь?'); f.time();
  const task = f.room.tick(); await settle();
  expect(f.snapshots).toHaveLength(0); expect(f.room.diagnostics.localReplies).toBe(1);
  expect(f.plays).toHaveLength(1);
  f.plays[0]!.done.resolve({ completed: true, playedMs: 900 }); await task;
  expect(f.room.events.find(e => e.kind === 'assistant')!.text).toBe('Да, я здесь, слышу тебя.'); f.room.close();
});

test('ordinary turns have a smaller speech budget and an explicit detailed request restores the full budget', async () => {
  const f = fixture(async () => ({ speak: false, text: '' }));
  f.room.transcript(alice, 'Что думаешь о плане?'); f.time(); await f.room.tick();
  expect(f.snapshots[0]!.responsePolicy!.maxChars).toBe(defaults.conversationReplyChars);
  f.room.transcript(alice, 'Объясни подробно новый план.'); f.time(); await f.room.tick();
  expect(f.snapshots[1]!.responsePolicy!.maxChars).toBe(defaults.maxReplyChars); f.room.close();
});

test('a completed preview is reused when final endpointing closes the same audio', async () => {
  let calls = 0;
  const f = fixture(undefined, async () => { calls++; return 'Расскажи мне про'; });
  const utterance = { pcm: Buffer.alloc(8), startedAt: f.now(), endedAt: f.now() + 400, speechMs: 400 };
  let accepted = false;
  f.room.preview(alice, utterance, () => { accepted = true; return true; }); await settle();
  expect(accepted).toBe(false); expect(f.room.events.some(e => e.kind === 'speech')).toBe(false);
  f.room.ingest(alice, utterance); await settle();
  expect(calls).toBe(1); expect(f.room.pendingSTT).toBe(0);
  expect(f.room.events.find(e => e.kind === 'speech')!.text).toBe('Расскажи мне про'); f.room.close();
});

test('a preview that finishes after stop cannot resurrect a transcript or an early endpoint', async () => {
  const recognized = deferred<string>(); const f = fixture(undefined, () => recognized.promise);
  let accepted = false;
  f.room.preview(alice, { pcm: Buffer.alloc(8), startedAt: f.now(), endedAt: f.now() + 500, speechMs: 500 }, () => { accepted = true; return true; });
  await settle(); f.room.stop(); recognized.resolve('Лёва сколько будет два плюс два'); await settle();
  expect(accepted).toBe(false); expect(f.room.pendingSTT).toBe(0);
  expect(f.room.events.some(e => e.kind === 'speech')).toBe(false); f.room.close();
});

test('a confirmed answer stays ready for the next opening without another question or model request', async () => {
  const f = fixture(undefined, undefined, { config: { replyFloorWaitMs: 80 } });
  f.room.transcript(alice, 'Что думаешь о маршруте?'); f.room.activity(bob.id, true); f.time();
  const task = f.room.tick(); await settle();
  expect(f.snapshots).toHaveLength(1); expect(f.plays).toHaveLength(0);
  f.time(200); await Bun.sleep(55);
  expect(f.room.phase).toBe('ready'); expect(f.room.diagnostics.withheldReplies).toBe(0); expect(f.plays).toHaveLength(0);
  f.room.activity(bob.id, false); f.time(); await Bun.sleep(55);
  expect(f.plays).toHaveLength(1); expect(f.snapshots).toHaveLength(1);
  f.plays[0]!.done.resolve({ completed: true, playedMs: 900 }); await task;
  f.time(); await f.room.tick(); expect(f.snapshots).toHaveLength(1); f.room.close();
});

test('a retained answer expires once and is never regenerated automatically', async () => {
  const f = fixture(undefined, undefined, { config: { replyFloorWaitMs: 80, maxResponseAgeMs: 500 } });
  f.room.transcript(alice, 'Что думаешь о маршруте?'); f.room.activity(bob.id, true); f.time();
  const task = f.room.tick(); await settle();
  f.time(600); await Bun.sleep(55); await task;
  expect(f.room.diagnostics.withheldReplies).toBe(1); expect(f.room.diagnostics.staleReplies).toBe(1);
  f.room.activity(bob.id, false); f.time(); await f.room.tick();
  expect(f.snapshots).toHaveLength(1); expect(f.plays).toHaveLength(0); f.room.close();
});

test('a correction replaces a retained answer and only the corrected answer can become audible', async () => {
  const f = fixture(async snapshot => ({ speak: true, text: snapshot.events.some(e => e.text.includes('поезд')) ? 'На поезде.' : 'На машине.' }));
  f.room.transcript(alice, 'Как добраться до парка?'); f.room.activity(bob.id, true); f.time();
  const first = f.room.tick(); await settle();
  expect(f.room.phase).toBe('ready'); expect(f.plays).toHaveLength(0);
  f.room.transcript(alice, 'Нет, я имела в виду поезд.'); await first;
  f.room.activity(bob.id, false); f.time(); const second = f.room.tick(); await settle();
  expect(f.plays).toHaveLength(1); expect(f.snapshots).toHaveLength(2);
  f.plays[0]!.done.resolve({ completed: true, playedMs: 900 }); await second;
  expect(f.room.events.filter(e => e.kind === 'assistant').map(e => e.text)).toEqual(['На поезде.']); f.room.close();
});

test('a directly addressed question can take a bounded turn while somebody else keeps talking', async () => {
  const f = fixture(undefined, undefined, { config: { replyFloorWaitMs: 80 } });
  f.room.transcript(alice, 'Лёва, что думаешь о маршруте?'); f.room.activity(bob.id, true); f.time();
  const task = f.room.tick(); await settle();
  expect(f.plays).toHaveLength(0);
  f.time(200); await Bun.sleep(55);
  expect(f.plays).toHaveLength(1); expect(f.room.activeSpeakers).toBe(1);
  f.room.stop(); await task; f.room.close();
});

test('a prepared reply never forces its way over its own questioner', async () => {
  const generated = deferred<Reply>();
  const f = fixture(() => generated.promise, undefined, { config: { replyFloorWaitMs: 80 } });
  f.room.transcript(alice, 'Лёва, расскажи о маршруте.'); f.time();
  const task = f.room.tick(); await settle();
  f.room.activity(alice.id, true); generated.resolve({ speak: true, text: 'Через парк.' }); await settle();
  f.time(300); await Bun.sleep(55);
  expect(f.plays).toHaveLength(0); expect(f.room.diagnostics.withheldReplies).toBe(0);
  f.room.activity(alice.id, false); f.time(); await Bun.sleep(55);
  expect(f.plays).toHaveLength(1);
  f.room.stop(); await task; f.room.close();
});

test('single-speaker speech can prepare before global room quiet without depending on question punctuation', async () => {
  const f = fixture(async () => ({ speak: false, text: '' }), undefined, { config: { roomQuietMs: 1100, prepareQuietMs: 500 } });
  f.room.transcript(alice, 'Предлагаю начать в восемь.'); f.time(750); await f.room.tick();
  expect(f.snapshots).toHaveLength(1);
  expect(f.snapshots[0]!.responsePolicy!.preparingEarly).toBe(true); f.room.close();
});

test('ordinary group conversation retains its longer quiet window', async () => {
  const f = fixture(async () => ({ speak: false, text: '' }), undefined, { config: { roomQuietMs: 1100, prepareQuietMs: 500 } });
  f.room.activity(bob.id, true); f.room.activity(bob.id, false); f.room.transcript(alice, 'Предлагаю начать в восемь.');
  f.time(750); await f.room.tick(); expect(f.snapshots).toHaveLength(0);
  f.time(500); await f.room.tick(); expect(f.snapshots).toHaveLength(1); f.room.close();
});
