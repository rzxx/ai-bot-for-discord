import { ActivityType } from 'discord.js';
import { safeText } from './tool-safety';
import type { TaskObservation } from './tasks';

interface Activity {
  name?: string; type: number; details?: string | null; state?: string | null;
  syncId?: string | null; timestamps?: { start?: Date | null; end?: Date | null } | null;
  assets?: { largeText?: string | null } | null;
}
interface Presence { activities: readonly Activity[] }
interface Playback { identity: string; start?: number; end?: number; instance: number; absentSince?: number }

/** Detect transitions at the gateway boundary, before display formatting loses
 * track identity. Unavailable presence is a gap, not a fictitious track change. */
export class TaskPresence {
  private playback = new Map<string, Playback>();
  constructor(private observe: (observation: TaskObservation) => void, private now: () => number = Date.now) {}
  update(subject: string, presence: Presence | null | undefined, activity: string) {
    const at = this.now();
    this.observe({ source: 'activity', subject, key: activity, at, available: !!presence && !!activity, data: { activity } });
    const song = presence?.activities.find(a => a.type === ActivityType.Listening && a.name === 'Spotify');
    const previous = this.playback.get(subject);
    if (!song || !song.details) {
      if (presence && previous) previous.absentSince ??= at;
      this.observe({ source: 'spotify', subject, key: previous ? `${previous.identity}:${previous.instance}` : '', at, available: false, data: { playing: false } });
      return;
    }
    const title = safeText(song.details, 160), artist = safeText(song.state ?? '', 160), album = safeText(song.assets?.largeText ?? '', 160);
    // syncId is a useful optional hint, not a required/public Discord contract.
    const identity = song.syncId || JSON.stringify([title, artist, album]);
    const start = song.timestamps?.start?.getTime(), end = song.timestamps?.end?.getTime();
    const replay = !!previous && (start === undefined && previous.start === undefined && previous.absentSince !== undefined && at - previous.absentSince >= 5000
      || start !== undefined && previous.start !== undefined && start > previous.start + 1500 && previous.end !== undefined && start >= previous.end - 1500);
    const changed = !previous || previous.identity !== identity || replay;
    const playback: Playback = { identity, start, end, instance: (previous?.instance ?? 0) + Number(changed) };
    this.playback.set(subject, playback);
    this.observe({ source: 'spotify', subject, key: `${identity}:${playback.instance}`, at,
      data: { title, artist, album, playing: true, ...(start !== undefined ? { startedAt: start } : {}), ...(end !== undefined ? { endsAt: end } : {}) } });
  }
  forget(subject: string) { this.playback.delete(subject); }
  close() { this.playback.clear(); }
}
