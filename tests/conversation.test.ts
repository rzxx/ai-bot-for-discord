import { expect, test } from 'bun:test';
import { speechIntent } from '../src/conversation';
import { trimSpeechPadding } from '../src/speech-cadence';
import { PCM_FRAME_BYTES } from '../src/audio';

test('local hints distinguish acknowledgments, actual questions and other people being addressed', () => {
  const members = [{ id: '1', name: 'Лёша' }];
  for (const text of ['Ага.', 'Угу, спасибо!', 'Ха-ха']) expect(speechIntent(text, 'Виталий', members).kind).toBe('backchannel');
  expect(speechIntent('Ага, а сколько это стоит?', 'Виталий').kind).toBe('question');
  expect(speechIntent('Лёша, ты уже дома?', 'Виталий', members).kind).toBe('elsewhere');
  expect(speechIntent('Виталий, а Лёша уже дома?', 'Виталий', members).kind).toBe('question');
  expect(speechIntent('Я сказал ему стоп.', 'Виталий').stop).toBe(false);
  expect(speechIntent('Виталий, стоп, пожалуйста!', 'Виталий').stop).toBe(true);
  expect(speechIntent('Нет, я имел в виду вторник.', 'Виталий').kind).toBe('correction');
});

test('early endpoint hints reject incomplete clauses, while explicit connection checks stay local', () => {
  for (const text of ['Виталий, можешь', 'Виталий, можешь сказать', 'Расскажи мне про', 'Сколько будет два плюс', 'Как ты думаешь']) {
    expect(speechIntent(text, 'Виталий').complete).toBe(false);
  }
  expect(speechIntent('Виталий, сколько будет два плюс два', 'Виталий').complete).toBe(true);
  expect(speechIntent('Виталий, ты меня слышишь', 'Виталий').localReply).toBe('Да, я здесь, слышу тебя.');
  expect(speechIntent('Ты меня слышишь', 'Виталий').localReply).toBeUndefined();
  expect(speechIntent('Виталий, ты меня слышишь и что думаешь о плане', 'Виталий').localReply).toBeUndefined();
  expect(speechIntent('Расскажи подробно про новый план', 'Виталий').detailed).toBe(true);
});

test('speech padding trimming preserves quiet speech and the silence inside a chunk', () => {
  const silence = Buffer.alloc(PCM_FRAME_BYTES * 20);
  const voice = Buffer.alloc(PCM_FRAME_BYTES * 10);
  for (let i = 0; i < voice.length; i += 2) voice.writeInt16LE(100, i);
  const interior = Buffer.alloc(PCM_FRAME_BYTES * 6);
  const trimmed = trimSpeechPadding(Buffer.concat([silence, voice, interior, voice, silence]));
  expect(trimmed.length).toBe((2 + 10 + 6 + 10 + 3) * PCM_FRAME_BYTES);
  expect(trimmed.subarray(12 * PCM_FRAME_BYTES, 18 * PCM_FRAME_BYTES)).toEqual(interior);
  expect(trimSpeechPadding(silence)).toEqual(silence);
});
