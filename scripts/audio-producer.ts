import { parentPort, workerData } from 'node:worker_threads';
import { createSocket } from 'node:dgram';
import { performance } from 'node:perf_hooks';

// An independent sender keeps producing audio even if the bot's event loop stalls.
const { inputPort, speakers, frames, packets: bytes } = workerData as { inputPort: number; speakers: number; frames: number; packets: Uint8Array[] };
const packets = bytes.map(value => Buffer.from(value));
const socket = createSocket('udp4');
let lastOutput = -1, outputPackets = 0, sequenceGaps = 0;
const gaps: number[] = [];
const outputTimes: number[] = [];
socket.on('message', message => {
  const sequence = message.readUInt32LE(0), now = performance.now();
  if (sequence !== lastOutput + 1) sequenceGaps++;
  lastOutput = sequence; outputPackets++;
  if (outputTimes.length) gaps.push(now - outputTimes.at(-1)!);
  outputTimes.push(now);
});
let timer: ReturnType<typeof setTimeout> | undefined;
let sentFrames = 0, began = 0;
function send() {
  const packet = packets[sentFrames % packets.length]!;
  for (let user = 0; user < speakers; user++) {
    const message = Buffer.allocUnsafe(13 + packet.length);
    message.writeUInt8(user, 0); message.writeUInt32LE(sentFrames, 1); message.writeDoubleLE(Date.now(), 5); packet.copy(message, 13);
    socket.send(message, inputPort, '127.0.0.1');
  }
  sentFrames++;
  if (sentFrames < frames) timer = setTimeout(send, Math.max(0, began + sentFrames * 20 - performance.now()));
  else parentPort!.postMessage({ type: 'inputs-finished' });
}
parentPort!.on('message', message => {
  if (message === 'start') { began = performance.now(); send(); }
  if (message === 'stop') {
    clearTimeout(timer);
    const sorted = [...gaps].sort((a, b) => a - b);
    const timeWindows = Array.from({ length: Math.ceil(frames * 20 / 20000) }, (_, n) => n * 20000).map(start => {
      const count = outputTimes.filter(at => at >= (outputTimes[0] ?? 0) + start && at < (outputTimes[0] ?? 0) + start + 20000).length;
      return { fromSeconds: start / 1000, packets: count };
    });
    parentPort!.postMessage({ type: 'report', outputPackets, sequenceGaps, maxOutputGapMs: Math.max(0, ...gaps),
      p99OutputGapMs: sorted[Math.floor(sorted.length * 0.99)] ?? 0,
      outputSpanMs: outputTimes.length > 1 ? outputTimes.at(-1)! - outputTimes[0]! : 0, timeWindows, sentFrames });
    socket.close(); parentPort!.close();
  }
});
socket.bind(0, '127.0.0.1', () => parentPort!.postMessage({ type: 'ready', outputPort: (socket.address() as { port: number }).port }));
