import { expect, test } from 'bun:test';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { LOCAL, ROOT, resolveConfig } from '../src/config';

/** Run the real CLI against disposable configuration and stubbed external boundaries. */
async function runCLI(command: string, locale = 'en', workingProvider = false) {
  await mkdir(LOCAL, { recursive: true });
  const directory = await mkdtemp(join(LOCAL, 'cli-fixture-'));
  if (!directory.startsWith(resolve(LOCAL) + sep)) throw new Error('Fixture outside local workspace');
  try {
    await cp(join(ROOT, 'src'), join(directory, 'src'), { recursive: true });
    await writeFile(join(directory, 'config.json'), JSON.stringify({ ...resolveConfig({ locale, model: 'fixture' }), inferenceAdapter: workingProvider ? './provider.ts' : './missing-provider.ts' }));
    await writeFile(join(directory, 'src/setup.ts'), 'export async function configure() { console.log("fixture-configure-reached"); }');
    await writeFile(join(directory, 'src/speech.ts'), `
      export class SpeechRuntime {
        client = {};
        constructor(config, failure) { globalThis.fixtureSpeechFailure = failure; }
        async start() { if (process.argv[2] === 'speech') throw new Error('fixture-speech-reached'); }
        async stop() {}
      }
    `);
    await writeFile(join(directory, 'src/discord.ts'), `
      export class DiscordBot {
        async start() {
          globalThis.fixtureSpeechFailure(new Error('fixture-worker-failure'));
          throw new Error('fixture-stop');
        }
        pauseAll(text) { console.log(text); }
        async stop() {}
      }
    `);
    if (workingProvider) await writeFile(join(directory, 'provider.ts'), `
      export function createInferenceProvider() {
        return {
          models: async () => [{ slug: 'fixture', display_name: 'Fixture' }],
          createBrain: () => ({ reply: async snapshot => {
            console.log(JSON.stringify({ fixtureInput: snapshot.events[0].text, fixtureName: snapshot.members[0].name }));
            return { speak: false, text: '' };
          } }),
        };
      }
    `);
    const child = Bun.spawn([process.execPath, join(directory, 'src/cli.ts'), command], {
      cwd: directory, env: { ...process.env, DISCORD_TOKEN: 'test-fixture-only' },
      stdout: 'pipe', stderr: 'pipe', signal: AbortSignal.timeout(10000),
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, code };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('configuration opens even when the selected inference adapter is missing', async () => {
  const result = await runCLI('configure');
  expect(result.code).toBe(0);
  expect(result.stdout).toContain('fixture-configure-reached');
  expect(result.stderr).not.toContain('missing-provider');
}, 15000);

test('local speech startup does not load the inference adapter', async () => {
  const result = await runCLI('speech');
  expect(result.code).toBe(1);
  expect(result.stderr).toContain('fixture-speech-reached');
  expect(result.stderr).not.toContain('missing-provider');
}, 15000);

test('Russian CLI chat sends a localized probe and prints a localized silence result', async () => {
  const result = await runCLI('chat', 'ru', true);
  expect(result.code).toBe(0);
  const input = JSON.parse(result.stdout.split('\n').find(line => line.startsWith('{'))!);
  expect(input).toEqual({ fixtureInput: 'Привет! Ты меня слышишь?', fixtureName: 'Пользователь' });
  expect(result.stdout).toContain('(решил промолчать)');
}, 15000);

test('Russian speech-service failures reach Discord in the configured locale', async () => {
  const result = await runCLI('start', 'ru', true);
  expect(result.code).toBe(1);
  expect(result.stdout).toContain('Один из сервисов речи остановился. Ответы приостановлены. Перезапустите бота.');
  expect(result.stderr).toContain('fixture-stop');
}, 15000);
