import { t } from './locale';
/** A small abortable handoff between synthesis, encoding and playback. */
export class AsyncBuffer<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private ended = false;
  private error: unknown;
  private waiters = new Set<() => void>();
  private readonly abort = () => this.fail(this.signal.reason ?? new DOMException('Aborted', 'AbortError'));
  constructor(private capacity: number, private signal: AbortSignal) {
    signal.addEventListener('abort', this.abort, { once: true });
    if (signal.aborted) this.abort();
  }
  private wake() { for (const wake of this.waiters) wake(); this.waiters.clear(); }
  private changed() { return new Promise<void>(resolve => this.waiters.add(resolve)); }
  async put(value: T) {
    while (!this.ended && this.values.length >= this.capacity) await this.changed();
    if (this.error) throw this.error;
    if (this.ended) throw new Error(t("Audio stream is closed."));
    this.values.push(value); this.wake();
  }
  close() { this.ended = true; this.signal.removeEventListener('abort', this.abort); this.wake(); }
  fail(error: unknown) { this.error = error ?? new Error(t("Audio stream failed.")); this.values = []; this.close(); }
  async *[Symbol.asyncIterator]() {
    for (;;) {
      if (this.error) throw this.error;
      if (this.values.length) { const value = this.values.shift()!; this.wake(); yield value; }
      else if (this.ended) return;
      else await this.changed();
    }
  }
}

export function nextOrAbort<T>(iterator: AsyncIterator<T>, signal: AbortSignal): Promise<IteratorResult<T>> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    iterator.next().then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
    if (signal.aborted) abort();
  });
}
