import { expect, test } from 'bun:test';
import { defaults } from '../src/config';
import { RoomController, type Player } from '../src/room';
import type { Reply } from '../src/llm';
import { TaskQueue } from '../src/queue';
import type { LatencyRecord } from '../src/telemetry';

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
async function until(check: () => boolean) {
  const deadline = Date.now() + 1500;
  while (!check()) { if (Date.now() > deadline) throw new Error('Cue scenario timed out'); await Bun.sleep(5); }
}
function fixture(delayedCue = false) {
  const replies: ReturnType<typeof deferred<Reply>>[] = [];
  const cue = deferred<Buffer>(), traces: LatencyRecord[] = [], synthesized: string[] = [], played: string[] = [];
  let active = 0, peak = 0;
  const player: Player = {
    async play(pcm, signal, hooks) {
      await hooks?.beforeStart?.(); signal.throwIfAborted();
      active++; peak = Math.max(peak, active); played.push(pcm.toString());
      const startedAt = Date.now(); hooks?.onStart?.(startedAt);
      try { await Bun.sleep(50); return { completed: !signal.aborted, playedMs: 50, startedAt, endedAt: Date.now() }; }
      finally { active--; }
    }, stop() {},
  };
  const room = new RoomController({ ...defaults, botName: 'Лёва', speechLanguage: 'ru', sttEngine: 'gigaam', voice: 'eugene', roomQuietMs: 1, replyStartQuietMs: 1, thinkingCueDelayMs: 15 }, {
    async reply() { const reply = deferred<Reply>(); replies.push(reply); return reply.promise; },
  }, { transcribe: async () => '' }, { async synthesize(text) { synthesized.push(text); return text === 'Хм.' && delayedCue ? cue.promise : Buffer.from(text); } },
  player, new TaskQueue(2), () => {}, { autoTick: false, convertOutput: async x => x, trace: r => traces.push(r) });
  const member = { id: '1', name: 'Алёна' }; room.setMember(member);
  const ask = () => { room.transcript(member, 'Лёва, расскажи о плане.', Date.now() - 100, Date.now() - 50); return room.tick(); };
  return { room, ask, replies, cue, traces, synthesized, played, peak: () => peak };
}

test('a slow direct question gets one local cue, separately measured from its actual answer', async () => {
  const f = fixture(); const task = f.ask();
  try {
    await until(() => f.room.diagnostics.thinkingCues === 1);
    expect(f.room.diagnostics.lastFirstAudioMs).toBe(0);
    f.replies[0]!.resolve({ speak: true, text: 'Встретимся у метро.' }); await task;
    expect(f.played).toEqual(['Хм.', 'Встретимся у метро.']); expect(f.peak()).toBe(1);
    expect(f.room.events.filter(e => e.kind === 'assistant').map(e => e.text)).toEqual(['Хм.', 'Встретимся у метро.']);
    expect(f.traces.filter(r => r.stage === 'thinking_cue_audio')).toHaveLength(1);
    expect(f.traces.filter(r => r.stage === 'first_audio')).toHaveLength(1);
    const second = f.ask(); await until(() => f.replies.length === 2); await Bun.sleep(30);
    f.replies[1]!.resolve({ speak: true, text: 'Потом зайдём в парк.' }); await second;
    expect(f.synthesized.filter(text => text === 'Хм.')).toHaveLength(1); // cooldown
  } finally { f.room.close(); }
});

test('an answer that becomes ready during cue synthesis cancels the unplayed cue', async () => {
  const f = fixture(true); const task = f.ask();
  try {
    await until(() => f.synthesized.includes('Хм.'));
    f.replies[0]!.resolve({ speak: true, text: 'Встретимся у метро.' });
    f.cue.resolve(Buffer.from('Хм.')); await task;
    expect(f.played).toEqual(['Встретимся у метро.']); expect(f.peak()).toBe(1);
    expect(f.room.diagnostics.thinkingCues).toBe(0);
  } finally { f.room.close(); }
});

test('stop during cue synthesis invalidates both the cue and an abort-ignoring model result', async () => {
  const f = fixture(true); const task = f.ask();
  try {
    await until(() => f.synthesized.includes('Хм.')); f.room.stop();
    f.cue.resolve(Buffer.from('Хм.')); f.replies[0]!.resolve({ speak: true, text: 'Уже поздно.' }); await task;
    expect(f.played).toHaveLength(0); expect(f.room.events.some(e => e.kind === 'assistant')).toBe(false);
  } finally { f.room.close(); }
});
