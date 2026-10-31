import { test, expect } from 'bun:test';
import { ReminderScheduler, type Reminder } from '../src/reminders';
import { RoomTools } from '../src/room-tools';
import { defaults } from '../src/config';

test('due timers batch once by owner and destination and never overlap or repeat delivery', async () => {
  let now = 0, finish!: (value: 'done') => void;
  const delivered: Reminder[][] = [];
  const scheduler = new ReminderScheduler(async reminders => { delivered.push(reminders); return new Promise(resolve => { finish = resolve; }); }, () => now);
  const room = scheduler.forRoom('guild', 'chat');
  room.create('alice', 5, 'Первое напоминание', 1); room.create('alice', 5, 'Второе напоминание', 2);
  now = 4999; scheduler.tick(); expect(delivered).toHaveLength(0);
  now = 5000; scheduler.tick(); scheduler.tick(); expect(delivered).toHaveLength(1); expect(delivered[0]).toHaveLength(2);
  finish('done'); await scheduler.settle(); scheduler.tick(); expect(delivered).toHaveLength(1); expect(room.list('alice')).toEqual([]);
  scheduler.close();
});

test('an explicitly requested reminder survives voice-tool teardown but not process shutdown', async () => {
  let now = 0; const delivered: Reminder[][] = [];
  const scheduler = new ReminderScheduler(async reminders => { delivered.push(reminders); return 'done'; }, () => now);
  const access = scheduler.forRoom('guild', 'chat');
  const tools = new RoomTools(defaults, { limits: new Map(), resolvePerson: () => undefined, sendMessage: async () => {},
    activity: () => ({ status: '', activity: '' }), reminders: access }, () => true, () => {}, () => now);
  tools.submit([{ tool: 'remind', event: 1, seconds: 5, text: 'Проверь чай.' }], [{ id: 1, kind: 'speech', at: 0, userId: 'alice', text: 'Напомни мне проверить чай.' }], new AbortController().signal);
  await tools.settle(); tools.close();
  now = 5000; scheduler.tick(); await scheduler.settle();
  expect(delivered).toHaveLength(1); expect(delivered[0]![0]).toMatchObject({ owner: 'alice', destination: 'chat', text: 'Проверь чай.' });
  access.create('alice', 5, 'Ещё одно.', 2); scheduler.close(); now += 5000; scheduler.tick(); expect(delivered).toHaveLength(1);
  const fresh = new ReminderScheduler(async () => 'done'); expect(fresh.forRoom('guild', 'chat').list('alice')).toEqual([]); fresh.close();
});

test('reminders are private to their owner/guild, bounded, and cancellable from a later voice session', () => {
  const scheduler = new ReminderScheduler(async () => 'done', () => 0);
  const oldRoom = scheduler.forRoom('guild', 'chat'), newRoom = scheduler.forRoom('guild', 'new-chat');
  const reminder = oldRoom.create('alice', 5, '@everyone https://host.test/ Проверить чай.', 1)!;
  expect(reminder.text).toBe('Проверить чай.'); expect(oldRoom.cancel('bob', reminder.id)).toBe(false);
  expect(scheduler.forRoom('other-guild', 'chat').list('alice')).toEqual([]);
  expect(newRoom.list('alice')).toHaveLength(1); expect(newRoom.cancel('alice', reminder.id)).toBe(true);
  for (let i = 0; i < 5; i++) expect(newRoom.create('alice', 5, `Таймер ${i}`, i + 2)).toBeDefined();
  expect(newRoom.create('alice', 5, 'Лишний', 10)).toBeUndefined(); scheduler.close();
});

test('cooldowns may defer before sending, but expired tasks and ambiguous sends never retry', async () => {
  let now = 0, available = false, attempts = 0;
  const scheduler = new ReminderScheduler(async () => { attempts++; if (!available) return 'defer'; throw new Error('unknown delivery outcome'); }, () => now);
  const access = scheduler.forRoom('guild', 'chat'); access.create('alice', 5, 'Чай.', 1);
  now = 5000; scheduler.tick(); await scheduler.settle(); expect(access.list('alice')).toHaveLength(1);
  available = true; scheduler.tick(); await scheduler.settle(); scheduler.tick(); expect(attempts).toBe(2); expect(access.list('alice')).toEqual([]);
  access.create('alice', 5, 'Слишком поздно.', 2); now += 66000; scheduler.tick(); expect(attempts).toBe(2); scheduler.close();
});
