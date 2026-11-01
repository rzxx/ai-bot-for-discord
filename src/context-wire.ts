import type { Member, RoomSnapshot, TurnEvent } from './llm';

/** Session-local wire identities. Discord IDs never enter the model prompt. */
export class ContextWire {
  private ids = new Map<string, string>();
  private people = new Map<string, { name: string; voice: number }>();
  private states = new Map<string, Record<string, string | number>>();
  private startedAt?: number;
  private initialized = false;
  private limit?: number;
  resolve(ref: string) { return [...this.ids].find(([, alias]) => alias === ref)?.[0]; }
  ref(id: string) {
    let ref = this.ids.get(id);
    if (!ref) { ref = `u${this.ids.size + 1}`; this.ids.set(id, ref); }
    return ref;
  }
  encode(snapshot: RoomSnapshot, events: TurnEvent[]) {
    this.startedAt ??= snapshot.timeline?.sessionStartedAt ?? snapshot.now;
    const relative = (at: number) => at - this.startedAt!;
    const update: Record<string, unknown> = { t: relative(snapshot.now) };
    if (snapshot.capabilities?.includes('chat')) update.utc = new Date(snapshot.now).toISOString();
    if (!this.initialized) { update.start = this.startedAt; update.cap = snapshot.capabilities ?? []; }
    const roster = new Map<string, Member>(snapshot.members.map(m => [m.id, m]));
    // Introduce departed speakers/chat authors too, including late STT.
    for (const event of events) if (event.userId && !roster.has(event.userId)) roster.set(event.userId, { id: event.userId, name: event.name ?? this.people.get(event.userId)?.name ?? 'Participant' });
    const people: unknown[][] = [];
    for (const [id, member] of roster) {
      const ref = this.ref(id), inVoice = Number(snapshot.members.some(m => m.id === id));
      const previous = this.people.get(id);
      if (!previous || previous.name !== member.name && previous.voice !== inVoice) people.push([ref, member.name, inVoice]);
      else if (previous.name !== member.name) people.push([ref, member.name]);
      else if (previous.voice !== inVoice) people.push([ref, inVoice]);
      this.people.set(id, { name: member.name, voice: inVoice });
    }
    for (const [id, value] of this.people) if (!roster.has(id) && value.voice === 1) {
      people.push([this.ref(id), 0]); this.people.set(id, { ...value, voice: 0 });
    }
    if (people.length) update.p = people;
    const states: unknown[][] = [];
    for (const state of snapshot.states ?? []) {
      const value = { s: state.status === 'unknown' ? '' : state.status ?? '', a: state.activity ?? '', m: Number(state.muted), d: Number(state.deafened) };
      const previous = this.states.get(state.userId) ?? { s: '', a: '', m: 0, d: 0 };
      const delta = Object.fromEntries(Object.entries(value).filter(([key, current]) => previous[key] !== current));
      if (Object.keys(delta).length) states.push([this.ref(state.userId), delta]);
      this.states.set(state.userId, value);
    }
    if (states.length) update.s = states;
    const encodedEvents = events.filter(e => !['join', 'leave', 'rename'].includes(e.kind)).map(event => {
      // Playback confirms the preceding proposal; don't send its text twice.
      let text: unknown = event.replyTo !== undefined ? '' : event.text;
      // App-authored receipts are objects, not JSON encoded inside another JSON
      // string. This avoids repeating backslash/quote tokens around every result.
      if (event.kind === 'tool') { try { text = JSON.parse(event.text); } catch { /* Preserve malformed synthetic diagnostics as text. */ } }
      const fields: unknown[] = [event.id, event.kind, relative(event.at), event.userId ? this.ref(event.userId) : '', text];
      if (event.end !== undefined || event.playedMs !== undefined || event.replyTo !== undefined) fields.push(event.end === undefined ? 0 : event.end - event.at);
      if (event.playedMs !== undefined || event.replyTo !== undefined) fields.push(event.playedMs ?? 0);
      if (event.replyTo !== undefined) fields.push(event.replyTo);
      return fields;
    });
    if (encodedEvents.length) update.e = encodedEvents;
    if (snapshot.responsePolicy) {
      update.r = snapshot.responsePolicy.triggerEventIds;
      if (this.limit !== snapshot.responsePolicy.maxChars) { update.limit = snapshot.responsePolicy.maxChars; this.limit = snapshot.responsePolicy.maxChars; }
    }
    this.initialized = true;
    return update;
  }
}
