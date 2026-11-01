import { safeText } from './tool-safety';

export interface Reminder { id: string; owner: string; due: number; text: string; event: number; scope: string; destination: string }
export interface ReminderAccess {
  create(owner: string, seconds: number, text: string, event: number): Reminder | undefined;
  list(owner: string): Reminder[];
  cancel(owner: string, id: string): boolean;
}

/** Legacy one-shot fallback for standalone RoomTools without a RoomController.
 * Its owning RoomTools closes it at session end; never inject a process-global scheduler.
 * Delivery may defer BEFORE I/O for cooldowns; uncertain sends are never retried. */
export class ReminderScheduler {
  private reminders = new Map<string, Reminder>();
  private inFlight = new Set<string>();
  private sequence = 0;
  private lifetime = new AbortController();
  private jobs = new Set<Promise<void>>();
  constructor(private deliver: (reminders: Reminder[], signal: AbortSignal) => Promise<'done' | 'defer'>,
    private now: () => number = Date.now, private expired?: (reminder: Reminder) => void) {}
  forRoom(scope: string, destination: string): ReminderAccess {
    return {
      create: (owner, seconds, text, event) => {
        if (this.lifetime.signal.aborted || !Number.isInteger(seconds) || seconds < 5 || seconds > 86400) return;
        const scoped = [...this.reminders.values()].filter(r => r.scope === scope);
        if (scoped.length >= 20 || scoped.filter(r => r.owner === owner).length >= 5) return;
        const clean = safeText(text, 320);
        if (!clean) return;
        const reminder = { id: `r${++this.sequence}`, owner, due: this.now() + seconds * 1000, text: clean, event, scope, destination };
        this.reminders.set(reminder.id, reminder);
        return { ...reminder };
      },
      list: owner => [...this.reminders.values()].filter(r => r.scope === scope && r.owner === owner && !this.inFlight.has(r.id)).map(r => ({ ...r })),
      cancel: (owner, id) => {
        const reminder = this.reminders.get(id);
        if (!reminder || reminder.scope !== scope || reminder.owner !== owner || this.inFlight.has(id)) return false;
        return this.reminders.delete(id);
      },
    };
  }
  tick() {
    if (this.lifetime.signal.aborted) return;
    const batches = new Map<string, Reminder[]>();
    for (const reminder of this.reminders.values()) {
      if (this.inFlight.has(reminder.id) || reminder.due > this.now()) continue;
      if (this.now() - reminder.due > 60000) { this.reminders.delete(reminder.id); this.expired?.(reminder); continue; }
      const key = JSON.stringify([reminder.scope, reminder.destination, reminder.owner]);
      const batch = batches.get(key) ?? []; batch.push({ ...reminder }); batches.set(key, batch);
    }
    for (const batch of batches.values()) {
      for (const reminder of batch) this.inFlight.add(reminder.id);
      const job = (async () => {
        let result: 'done' | 'defer' = 'done';
        try { result = await this.deliver(batch, this.lifetime.signal); }
        catch { /* An unknown remote outcome must not resend a notification. */ }
        finally {
          for (const reminder of batch) {
            this.inFlight.delete(reminder.id);
            if (result !== 'defer') this.reminders.delete(reminder.id);
          }
        }
      })().finally(() => this.jobs.delete(job));
      this.jobs.add(job);
    }
  }
  close() { this.lifetime.abort(); this.reminders.clear(); this.inFlight.clear(); }
  async settle() { await Promise.allSettled([...this.jobs]); }
}
