import { TokenCounter } from './token-accounting-core';
const counter = new TokenCounter();
const sessions = new Map<string, number>();
self.onmessage = ({ data }: MessageEvent<{ id: number; session: string; body?: string; release?: boolean; output?: boolean }>) => {
  if (data.release) { sessions.delete(data.session); return; }
  try {
    const began = performance.now(), input = JSON.parse(data.body!).input;
    const from = data.output ? 0 : Math.min(sessions.get(data.session) ?? 0, input.length);
    const measurement = counter.measure(input, from);
    if (!data.output) sessions.set(data.session, input.length);
    if (sessions.size > 32) sessions.delete(sessions.keys().next().value!);
    self.postMessage({ id: data.id, measurement, elapsedMs: Math.round(performance.now() - began) });
  } catch { self.postMessage({ id: data.id, failed: true }); }
};
