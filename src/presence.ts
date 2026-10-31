import { t } from './locale';
import { ActivityType } from 'discord.js';
import { safeText } from './tool-safety';
import type { DiagnosticFields } from './telemetry';

interface Activity { type: number; name?: string; details?: string | null; state?: string | null }
export interface PublishedPresence { status: string; activities: readonly Activity[] }

const kinds: Record<number, string> = {
  [ActivityType.Playing]: 'playing', [ActivityType.Streaming]: 'streaming', [ActivityType.Listening]: 'listening',
  [ActivityType.Watching]: 'watching', [ActivityType.Custom]: 'custom', [ActivityType.Competing]: 'competing',
};
const priority = [ActivityType.Playing, ActivityType.Competing, ActivityType.Streaming, ActivityType.Listening, ActivityType.Watching, ActivityType.Custom];

/** A bounded view of Discord-published activity. No URLs, timestamps, assets,
 * party IDs or external lookups. Concrete activities take priority over status. */
export function visiblePresence(presence: PublishedPresence | null | undefined) {
  const labels = [...presence?.activities ?? []].filter(a => kinds[a.type])
    .sort((a, b) => priority.indexOf(a.type) - priority.indexOf(b.type)).map(activity => {
      const name = safeText(activity.name ?? '', 50);
      const details = safeText(activity.details ?? '', 50), state = safeText(activity.state ?? '', 50);
      const extra = [...new Set([details, state].filter(s => s && s !== name))].join(' — ');
      if (activity.type === ActivityType.Custom) return state ? t("status: {0}", state) : '';
      const description = [name, extra].filter(Boolean).join(' — ');
      if (!description) return '';
      const prefix = activity.type === ActivityType.Playing ? '' : activity.type === ActivityType.Competing ? t("competing: ")
        : activity.type === ActivityType.Streaming ? t("streaming: ") : activity.type === ActivityType.Listening ? t("listening: ") : t("watching: ");
      return safeText(prefix + description, 100);
    }).filter(Boolean);
  return { status: safeText(presence?.status ?? 'unknown', 16), presenceAvailable: !!presence,
    activity: safeText([...new Set(labels)].slice(0, 2).join('; '), 160) };
}

/** Only availability, types and counts enter the local diagnostic log. */
export function presenceDiagnostics(presence: PublishedPresence | null | undefined, summary = visiblePresence(presence)): DiagnosticFields {
  const activities = presence?.activities ?? [];
  return { presenceAvailable: summary.presenceAvailable, presenceStatus: summary.status,
    activityCount: activities.length, activityTypes: [...new Set(activities.map(a => kinds[a.type] ?? 'unknown'))].sort().join(','),
    hasActivityName: activities.some(a => !!a.name), hasActivityDetails: activities.some(a => !!a.details),
    hasActivityState: activities.some(a => !!a.state), exposedActivity: !!summary.activity, exposedActivityChars: summary.activity.length };
}
