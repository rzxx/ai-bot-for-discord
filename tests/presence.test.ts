import { test, expect } from 'bun:test';
import { ActivityType } from 'discord.js';
import { visiblePresence, presenceDiagnostics } from '../src/presence';

test('published games retain their names and bounded rich presence details', () => {
  expect(visiblePresence({ status: 'online', activities: [{ type: ActivityType.Playing, name: 'Minecraft' }] }))
    .toEqual({ status: 'online', presenceAvailable: true, activity: 'Minecraft' });
  expect(visiblePresence({ status: 'idle', activities: [{ type: ActivityType.Playing, name: 'Game', details: 'Ranked match', state: 'Map One' }] }).activity)
    .toBe('Game — Ranked match — Map One');
});

test('listening, watching, streaming, custom and competing activities are available without links or IDs', () => {
  for (const [type, prefix] of [[ActivityType.Listening, 'listening'], [ActivityType.Watching, 'watching'],
    [ActivityType.Streaming, 'streaming'], [ActivityType.Competing, 'competing']] as const) {
    const activity = visiblePresence({ status: 'online', activities: [{ type, name: 'Service', details: 'Title', state: 'Artist' }] }).activity;
    expect(activity).toBe(`${prefix}: Service — Title — Artist`);
  }
  expect(visiblePresence({ status: 'online', activities: [{ type: ActivityType.Custom, name: 'Custom Status', state: 'Играем вечером' }] }).activity).toBe('status: Играем вечером');
  expect(visiblePresence({ status: 'online', activities: [{ type: ActivityType.Listening, name: 'Service', details: '@everyone <@123> Title https://private.test/' }] }).activity)
    .toBe('listening: Service — Title');
});

test('concrete activities take priority over custom status and total context stays bounded', () => {
  const activity = visiblePresence({ status: 'online', activities: [
    { type: ActivityType.Custom, name: 'Custom Status', state: 'Status' },
    { type: ActivityType.Listening, name: 'Spotify', details: 'Track', state: 'Artist' },
    { type: ActivityType.Playing, name: 'Minecraft' },
  ] }).activity;
  expect(activity).toBe('Minecraft; listening: Spotify — Track — Artist');
  expect(visiblePresence({ status: 'online', activities: Array.from({ length: 20 }, (_, n) => ({ type: ActivityType.Playing,
    name: `Game ${n} ` + 'я'.repeat(200), details: 'я'.repeat(500), state: 'я'.repeat(500) })) }).activity.length).toBeLessThanOrEqual(160);
});

test('missing presence stays unknown and unavailable activities never invent a game', () => {
  expect(visiblePresence(null)).toEqual({ status: 'unknown', presenceAvailable: false, activity: '' });
  expect(visiblePresence({ status: 'online', activities: [] })).toEqual({ status: 'online', presenceAvailable: true, activity: '' });
  expect(visiblePresence({ status: 'offline', activities: [{ type: 99, name: 'Unsupported' }] }).activity).toBe('');
});

test('presence diagnostics show received types and data availability without logging activity content', () => {
  const fields = presenceDiagnostics({ status: 'online', activities: [{ type: ActivityType.Playing,
    name: 'private-game-title', details: 'private-details', state: 'private-state' }, { type: ActivityType.Custom, state: 'private-status' }] });
  expect(fields).toMatchObject({ presenceAvailable: true, activityCount: 2, activityTypes: 'custom,playing',
    hasActivityDetails: true, hasActivityState: true, exposedActivity: true });
  expect(JSON.stringify(fields)).not.toContain('private-');
  expect(presenceDiagnostics(null)).toMatchObject({ presenceAvailable: false, activityCount: 0, exposedActivity: false });
});
