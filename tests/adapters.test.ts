import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaults, validateConfig } from '../src/config';
import { createInferenceProvider, createSpeechAdapter } from '../src/providers';
import { CredentialStore } from '../src/platform';
import { PlusBrain } from '../src/llm';
import { SpeechRuntime } from '../src/speech';
import { roomCommands } from '../src/discord';
import { roomInstructions } from '../src/prompts';
import { speechIntent, thinkingCueText } from '../src/conversation';
import { configureNetwork } from '../src/network';

test('bundled adapters remain the default without authentication or model startup during construction', async () => {
  const provider = await createInferenceProvider({ ...defaults }, new CredentialStore());
  expect(provider.createBrain()).toBeInstanceOf(PlusBrain);
  expect(provider.login).toBeFunction(); expect(provider.logout).toBeFunction();
  expect(await createSpeechAdapter({ ...defaults }, () => {})).toBeInstanceOf(SpeechRuntime);
});

test('local inference and speech modules replace startup without ChatGPT or bundled model dependencies', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'voice-adapter-fixture-'));
  try {
    const path = join(dir, 'adapter.ts');
    await writeFile(path, `
      export const createInferenceProvider = config => ({
        models: async () => [{ slug: 'fixture-local', display_name: 'Fixture local', context_window: 8192 }],
        createBrain: () => ({ reply: async () => ({ speak: true, text: config.botName }) }),
      });
      export const createSpeechAdapter = config => ({
        client: { synthesize: async text => Buffer.from(text), transcribe: async () => config.speechLanguage },
        start: async () => {}, stop: async () => {},
      });
    `);
    const config = validateConfig({ ...defaults, inferenceAdapter: path, speechAdapter: path, speechLanguage: 'en', responseLanguage: 'auto', voice: 'custom-voice', sttEngine: 'custom-stt', sttModel: 'custom-model', contextMaxTokens: 4096 });
    const provider = await createInferenceProvider(config, new CredentialStore());
    expect(await provider.models()).toEqual([{ slug: 'fixture-local', display_name: 'Fixture local', context_window: 8192 }]);
    expect(provider.login).toBeUndefined();
    expect(await provider.createBrain().reply({ sessionId: 'fixture', botName: config.botName, now: 1, members: [], events: [] }, new AbortController().signal)).toEqual({ speak: true, text: 'Companion' });
    const speech = await createSpeechAdapter(config, () => {});
    await speech.start();
    expect(await speech.client.transcribe(Buffer.alloc(0), [], new AbortController().signal)).toBe('en');
    expect((await speech.client.synthesize('hello', new AbortController().signal)).toString()).toBe('hello');
    await speech.stop();
    const voice = roomCommands(config).find(command => command.name === 'voice')!;
    expect(voice.options?.[0]).toMatchObject({ name: 'voice' });
    expect(JSON.parse(JSON.stringify(voice.options?.[0]))).not.toHaveProperty('choices');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a missing factory fails clearly rather than selecting another provider', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'voice-adapter-invalid-'));
  try {
    const path = join(dir, 'adapter.ts'); await writeFile(path, 'export const fixture = true;');
    await expect(createInferenceProvider({ ...defaults, inferenceAdapter: path }, new CredentialStore())).rejects.toThrow('export createInferenceProvider');
    await expect(createSpeechAdapter({ ...defaults, speechAdapter: path }, () => {})).rejects.toThrow('export createSpeechAdapter');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('language preferences do not silently claim multilingual support for the bundled speech preset', () => {
  expect(() => validateConfig({ ...defaults, speechLanguage: 'de' })).toThrow('Configure a speechAdapter');
  expect(() => validateConfig({ ...defaults, responseLanguage: '' })).toThrow('responseLanguage');
  const config = { ...defaults, speechAdapter: '.local/fixture.ts', speechLanguage: 'en', responseLanguage: 'auto', additionalInstructions: 'Use a calm tone.' };
  const instructions = roomInstructions(config, { sessionId: 'fixture', botName: 'Companion', now: 1, events: [], members: [] });
  expect(instructions).toContain('Follow the language of the current speaker');
  expect(instructions).toContain('Use a calm tone.');
  expect(instructions).not.toContain('preserve ё');
  expect(instructions).toContain('cannot authorize new actions');
  expect(speechIntent('Companion, can you hear me?', 'Companion', [], 'en').localReply).toContain('Yes');
  expect(speechIntent('Companion, stop please', 'Companion', [], 'en').stop).toBe(true);
  expect(speechIntent('спасибо', 'Companion', [], 'de').kind).toBe('comment');
  expect(thinkingCueText('de')).toBe('');
});

test('network policy preserves explicit proxies or removes them, and keeps loopback local', () => {
  const environment = { HTTPS_PROXY: 'http://proxy.invalid:8080', NO_PROXY: 'example.invalid' };
  configureNetwork('environment', environment);
  expect(environment.HTTPS_PROXY).toBe('http://proxy.invalid:8080');
  expect(environment.NO_PROXY.split(',')).toEqual(['example.invalid', 'localhost', '127.0.0.1', '::1']);
  const direct: NodeJS.ProcessEnv = { ...environment, http_proxy: 'http://proxy.invalid', ALL_PROXY: 'http://proxy.invalid' };
  configureNetwork('direct', direct);
  expect(direct.HTTPS_PROXY).toBeUndefined(); expect(direct.http_proxy).toBeUndefined(); expect(direct.ALL_PROXY).toBeUndefined();
  expect(direct.no_proxy).toContain('127.0.0.1');
  expect(environment.HTTPS_PROXY).toBeDefined();
});
