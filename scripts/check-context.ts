import { t, setLocale } from '../src/locale';
import { configureNetwork } from '../src/network';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadConfig, LOCAL, safeError } from '../src/config';
import { PlanAuth } from '../src/auth';
import { CredentialStore, acquireLock } from '../src/platform';
import { PlusBrain, type HTTPTransport, type TurnEvent, type RoomSnapshot } from '../src/llm';

// Synthetic conversation only. Uses the signed-in Plus allowance; no Discord,
// microphone, speech worker, private call audio or durable conversation storage.
const release = await acquireLock('context-check');
const config = await loadConfig();
setLocale(config.locale);
configureNetwork(config.networkMode);
const options = { ...config };
const requests: { input: any[] }[] = [];
const report: any[] = [];
const transport: HTTPTransport = async (url, init) => {
  const body = JSON.parse(init.body as string);
  requests.push({ input: body.input });
  return fetch(url, init);
};
const brain = new PlusBrain(new PlanAuth(new CredentialStore()), options, transport);
const sessionId = crypto.randomUUID();
const began = Date.now();
const events: TurnEvent[] = Array.from({ length: 150 }, (_, n) => ({
  id: n + 1, at: began + n * 2000, end: began + n * 2000 + 1000, kind: 'speech',
  userId: n % 2 ? 'fixture-b' : 'fixture-a', name: n % 2 ? 'Лёша' : 'Алёна',
  text: n === 0 ? 'Для нашей тестовой игры пароль — сиреневый барсук. Запомни его до конца этого звонка.'
    : `Служебная тестовая реплика номер ${n}: обсуждаем вечернюю игру, сначала проверим микрофоны, выберем карту и распределим команды. Это разговор друг с другом, от Лёвы ответа пока не требуется.`,
}));
const snapshot: RoomSnapshot = { sessionId, botName: config.botName, members: [{ id: 'fixture-a', name: 'Алёна' }, { id: 'fixture-b', name: 'Лёша' }], events, now: began + 301000,
  timeline: { sessionStartedAt: began, quietForMs: 2000, sinceLastBotSpeechMs: null } };
let prefixPreserved = true;
try {
  for (let turn = 0; turn < 5; turn++) {
    if (turn) {
      const id = events.at(-1)!.id + 1;
      events.push({ id, at: snapshot.now + 1000, end: snapshot.now + 2000, kind: 'speech', userId: 'fixture-a', name: 'Алёна',
        text: turn >= 3 ? `${config.botName}, какой пароль для нашей тестовой игры? Назови только пароль.` : 'Мы продолжаем обсуждать карту друг с другом. Ответ пока не нужен.' });
      snapshot.now += 5000;
    }
    const before = requests.length, started = performance.now();
    const reply = await brain.reply(snapshot, AbortSignal.timeout(120000));
    const emitted = requests.slice(before);
    if (turn) {
      const previous = requests[before - 1]!.input;
      prefixPreserved &&= JSON.stringify(emitted[0]!.input.slice(0, previous.length)) === JSON.stringify(previous);
      if (!prefixPreserved) throw new Error(t("A request rewrote the prefix"));
      if (turn >= 3 && !/сиренев\p{L}*\s+барсук/iu.test(reply.text)) throw new Error(t("The session lost the synthetic password"));
    }
    const metrics = { ...brain.contextMetrics(sessionId)! };
    const result = { turn, elapsedMs: Math.round(performance.now() - started), requests: emitted.length, reply, metrics };
    report.push(result); console.log(JSON.stringify(result));
  }
  const path = resolve(LOCAL, 'context-check.json'); await mkdir(LOCAL, { recursive: true });
  await writeFile(path, JSON.stringify({ at: new Date().toISOString(), model: config.model, prefixPreserved, report }, null, 2));
  console.log(t("Report: {0}", path));
} catch (error) { console.error(safeError(error)); process.exitCode = 1; }
finally { brain.release(sessionId); await release(); }
