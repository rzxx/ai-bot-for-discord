import { t } from './locale';
/** One loaded STT model, bounded waiting work, and no concurrent inference oversubscription. */
export class TaskQueue {
  private waiting: { run: () => Promise<void>; reject: (reason: Error) => void }[] = [];
  private running = false;
  constructor(private maxWaiting: number) {}
  get length() { return this.waiting.length + Number(this.running); }
  submit<T>(task: () => Promise<T>): Promise<T> {
    if (this.waiting.length >= this.maxWaiting) return Promise.reject(new Error(t("STT queue is full; recognition cannot keep up.")));
    return new Promise<T>((resolve, reject) => {
      this.waiting.push({ run: async () => { try { resolve(await task()); } catch (error) { reject(error); } }, reject });
      void this.drain();
    });
  }
  private async drain() {
    if (this.running) return;
    this.running = true;
    try { while (this.waiting.length) await this.waiting.shift()!.run(); }
    finally { this.running = false; }
  }
}
