import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { selectLocale, resolveConfig, ROOT } from '../src/config';
import { currentLocale, t, translate, withLocale } from '../src/locale';
import { ruMessages } from '../src/locales/messages';
import { roomInstructions, reviewInstructions } from '../src/prompts';
import { roomCommands } from '../src/discord';
import { setupForm } from '../src/setup-form';
import { OpenAIError } from '../src/auth';
import { PlusBrain } from '../src/llm';
import type { PlanAuth } from '../src/auth';
import { visiblePresence } from '../src/presence';
import { ActivityType } from 'discord.js';
import { speechIntent } from '../src/conversation';

const snapshot = { sessionId: 'locale-fixture', botName: 'Companion', members: [], events: [], now: 1, capabilities: ['report', 'members', 'search'] };

test('new configuration defaults to English and legacy speech settings retain Russian', () => {
  expect(resolveConfig({})).toMatchObject({ locale: 'en', speechLanguage: 'en', sttEngine: 'whisper', voice: 'en_0' });
  expect(resolveConfig({ sttEngine: 'gigaam', voice: 'eugene' })).toMatchObject({ locale: 'ru', speechLanguage: 'ru', voice: 'eugene' });
  expect(resolveConfig({ locale: 'ru' })).toMatchObject({ locale: 'ru', speechLanguage: 'ru', sttEngine: 'gigaam', responseLanguage: 'auto' });
  expect(resolveConfig({ locale: 'ru', sttEngine: 'whisper', voice: 'baya' })).toMatchObject({ sttEngine: 'whisper', voice: 'baya' });
  expect(resolveConfig({ locale: 'de' })).toMatchObject({ locale: 'de', speechLanguage: 'en' });
  expect(resolveConfig({ locale: 'ru' }).pronunciations).toMatchObject({ Discord: 'Дискорд' });
  const customized = resolveConfig({ locale: 'ru', pronunciations: { Discord: 'Дискорд', Alex: 'Ал+екс' } });
  expect(selectLocale(customized, 'en').pronunciations).toEqual({ Alex: 'Ал+екс' });
});

test('only the selected instruction locale reaches the room and background reviewer', () => {
  const english = roomInstructions(resolveConfig({ locale: 'en' }), snapshot);
  const russian = roomInstructions(resolveConfig({ locale: 'ru' }), snapshot);
  expect(english).toContain('You are Companion');
  expect(english).not.toMatch(/[А-Яа-яЁё]/);
  expect(english).not.toMatch(/Russian|stress mark|transcription/i);
  expect(russian).toContain('Ты — Companion');
  expect(russian).toContain('русскими падежами');
  expect(russian).toContain('Не заменяй ё на е');
  expect(russian).toContain('связь');
  expect(russian).toContain('Внутренний report');
  expect(russian).not.toContain('You are');
  expect(russian).not.toContain('Internal report');
  expect(reviewInstructions(resolveConfig({ locale: 'ru' }))).toContain('Разбери один');
  expect(reviewInstructions(resolveConfig({ locale: 'en' }))).toContain('You review one');
  expect(roomInstructions(resolveConfig({ locale: 'fr' }), snapshot)).toBe(english);
});

test('chat retrieval instructions are localized, describe read-only continuations and retain the deployment timezone', () => {
  const en = roomInstructions(resolveConfig({ chatTools: true, chatTimezone: 'Europe/Moscow' }), snapshot);
  const ru = roomInstructions(resolveConfig({ locale: 'ru', chatTools: true, chatTimezone: 'Europe/Moscow' }), snapshot);
  expect(en).toContain('op:"history"'); expect(ru).toContain('op:"history"');
  expect(en).toContain('Europe/Moscow'); expect(ru).toContain('Europe/Moscow');
  expect(en).toContain('Tokens cannot change filters/channel or authorize writes');
  expect(ru).toContain('Нельзя менять фильтры/канал');
  expect(en).not.toMatch(/[А-Яа-яЁё]/); expect(ru).not.toContain('If cap contains chat');
  expect(roomInstructions(resolveConfig({ chatTools: false }), snapshot)).not.toContain('op:"history"');
  expect(() => resolveConfig({ chatTimezone: 'Invalid/Zone' })).toThrow('chatTimezone');
});

test('concurrent locale scopes do not leak and unknown entries fall back to English', async () => {
  const before = currentLocale();
  const replies = await Promise.all(['ru', 'en', 'de'].map(locale => withLocale(locale, async () => {
    await Bun.sleep(1);
    return t('Reply stopped.');
  })));
  expect(replies).toEqual(['Ответ остановлен.', 'Reply stopped.', 'Reply stopped.']);
  expect(currentLocale()).toBe(before);
  expect(translate('ru', 'Missing translation: {0}', 'value {0}')).toBe('Missing translation: value {0}');
  expect(translate('ru', 'toString')).toBe('toString');
  expect(translate('ru', 'Value: {0}', null)).toBe('Value: null');
  expect(withLocale('ru', () => new OpenAIError(429, 'subscription_sharing_usage_limit_exceeded', 'fallback').message)).toContain('Достигнут лимит');
});

test('setup and command catalogs include Russian without replacing English defaults', () => {
  const config = resolveConfig({ locale: 'ru' });
  const ru = withLocale('ru', () => setupForm(config, 'fixture', true));
  const en = withLocale('en', () => setupForm(resolveConfig({ locale: 'en' }), 'fixture', true));
  expect(ru).toContain('Сохранить и открыть Discord');
  expect(ru).toContain('Настройки беседы и сети');
  expect(ru).not.toContain('Recognition language');
  expect(en).toContain('Save and open Discord');
  const commands = withLocale('ru', () => roomCommands(config));
  expect(commands[0]).toMatchObject({ name: 'join', description: 'Join your voice channel', name_localizations: { ru: 'войти' }, description_localizations: { ru: 'Присоединить бота к вашему голосовому каналу' } });
  expect(commands.find(c => c.name === 'name')!.options?.[0]?.description_localizations?.ru).toBe('Ваше имя');
});

test('provider input includes only one localized prompt and keeps append-only prefixes', async () => {
  const calls: any[] = [];
  const brain = new PlusBrain({ token: async () => 'fixture' } as unknown as PlanAuth, resolveConfig({ locale: 'ru', model: 'fixture' }), async (_url, init) => {
    calls.push(JSON.parse(String(init.body)));
    return new Response('data: {"type":"response.output_text.delta","delta":"{\\"speak\\":false,\\"text\\":\\"\\"}"}\n\ndata: {"type":"response.completed"}\n\n');
  });
  try {
    await brain.reply(snapshot, new AbortController().signal);
    await brain.reply({ ...snapshot, now: 2 }, new AbortController().signal);
    const instructions = String(calls[0].input[0].content);
    expect(instructions).toContain('Ты — Companion');
    expect(instructions).not.toContain('You are Companion');
    expect(calls[1].input.slice(0, calls[0].input.length)).toEqual(calls[0].input);
  } finally { brain.release(snapshot.sessionId); }
});

test('locale hints and presence labels preserve participant-supplied content', () => {
  expect(speechIntent('Companion, can you hear me?', 'Companion', [], 'en').localReply).toContain('Yes');
  expect(speechIntent('Companion, can you tell me', 'Companion', [], 'en').complete).toBe(false);
  expect(speechIntent('Лёва, ты меня слышишь', 'Лёва', [], 'ru').localReply).toBe('Да, я здесь, слышу тебя.');
  expect(speechIntent('Лёва, можешь сказать', 'Лёва', [], 'ru').complete).toBe(false);
  const presence = { status: 'online', activities: [{ type: ActivityType.Streaming, name: 'Untranslated game' }] };
  expect(withLocale('ru', () => visiblePresence(presence).activity)).toBe('стримит: Untranslated game');
  expect(withLocale('en', () => visiblePresence(presence).activity)).toBe('streaming: Untranslated game');
});

test('Russian catalog preserves placeholders and covers every declared product message', () => {
  const placeholders = (value: string) => [...new Set(value.match(/\{\d+\}/g) ?? [])].sort();
  for (const [key, value] of Object.entries(ruMessages)) expect(placeholders(value), key).toEqual(placeholders(key));
  function scan(dir: string) {
    for (const file of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, file.name);
      if (file.isDirectory()) { if (file.name !== 'locales') scan(path); continue; }
      if (!file.name.endsWith('.ts')) continue;
      const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
      function visit(node: ts.Node) {
        if (ts.isCallExpression(node) && /(?:^|\.)(?:t|field)$/.test(node.expression.getText(source))) {
          const args = node.expression.getText(source) === 'field' ? [node.arguments[0], node.arguments[2]] : [node.arguments[0]];
          for (const arg of args) if (arg && ts.isStringLiteral(arg) && arg.text) expect(Object.hasOwn(ruMessages, arg.text), arg.text).toBe(true);
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
  }
  scan(resolve(ROOT, 'src'));
  scan(resolve(ROOT, 'scripts'));
});
