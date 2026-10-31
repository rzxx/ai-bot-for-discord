import type { Member } from './llm';

export interface SpeechIntent {
  kind: 'backchannel' | 'elsewhere' | 'correction' | 'question' | 'request' | 'comment';
  addressed: boolean;
  complete: boolean;
  detailed: boolean;
  stop: boolean;
  localReply?: string;
  normalized: string;
}

export function normalizeSpeech(text: string): string {
  return text.toLowerCase().replaceAll('ё', 'е').replaceAll('+', '').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

/** Conservative local hints, not a replacement for the model's understanding.
 * Only whole acknowledgments and explicit addresses to somebody else are filtered.
 * Ambiguous ordinary conversation still reaches the text model. */
export function speechIntent(text: string, botName: string, members: Iterable<Member> = [], language = 'ru'): SpeechIntent {
  if (language.split('-')[0] !== 'ru') return genericSpeechIntent(text, botName, members, language);
  const normalized = normalizeSpeech(text), bot = normalizeSpeech(botName);
  const words = normalized.split(' ');
  const addressed = !!bot && (` ${normalized} `).includes(` ${bot} `);
  const body = addressed ? normalized.replace(bot, '').replace(/\s+/g, ' ').trim() : normalized;
  const semantic = body.replace(/^(?:ага|угу|да|окей|ок|ну) /, '');
  const result: SpeechIntent = { kind: 'comment', addressed, complete: false, detailed: false, stop: false, normalized };
  if (!normalized) return { ...result, kind: 'backchannel' };
  result.stop = addressed && /^(?:стоп|стоп пожалуйста|замолчи|замолчи пожалуйста|хватит|перестань говорить)$/.test(body);
  result.detailed = /(?:подробн\p{L}*|поподробнее|развернут\p{L}*|длинн\p{L}* (?:истори\p{L}*|рассказ\p{L}*)|шаг за шагом)/u.test(body);
  if (!addressed && (/^(?:(?:ну |а |да )?(?:да|ага|угу|мгм|мм|хм|ок|окей|ладно|понятно|ясно|спасибо|согласен|согласна|точно|верно|хорошо))(?: (?:да|ага|угу|спасибо|понятно|хорошо))*$/.test(body)
    || /^(?:(?:ха|ах|хе|хаха|ахах|хехе) ?)+$/.test(body))) {
    return { ...result, kind: 'backchannel', complete: true };
  }
  if (!addressed) for (const member of members) {
    const name = normalizeSpeech(member.name);
    if (name && name !== bot && (normalized.startsWith(`${name} `) || normalized.endsWith(` ${name}`))) return { ...result, kind: 'elsewhere' };
  }
  const correction = /^(?:нет (?:я|мы|не|ты)|не так|не то|я (?:имел|имела|имею) в виду|точнее|поправка|погоди|подожди|дай (?:мне )?сказать|послушай|перестань|замолчи|стоп)(?:\s|$)/.test(semantic);
  const question = /\?/.test(text) || /^(?:(?:а|ну|и) )?(?:что|как|почему|зачем|когда|где|куда|откуда|кто|кому|кого|чем|сколько|како\p{L}*|котор\p{L}*|разве)(?:\s|$)/u.test(semantic)
    || /(?:^| )(?:ты|вы) .*?(?:слышишь|слышите|думаешь|считаешь|знаешь|помнишь)(?: |$)/.test(semantic)
    || /(?:^| )(?:ты тут|ты здесь|меня слышно|меня слышишь|слышишь меня|связь|прием|алло)$/.test(semantic);
  const request = /^(?:а )?(?:потом )?(?:расскажи|объясни|скажи|подскажи|посоветуй|помоги|повтори|поздоровайся|поприветствуй|ответь|напомни|посчитай|сравни|проверь|давай|можешь|можете|не мог бы|пожалуйста)(?:\s|$)/.test(semantic);
  result.kind = correction ? 'correction' : question ? 'question' : request ? 'request' : 'comment';
  // A short pause after an unfinished modal, conjunction or preposition isn't a turn.
  const unfinished = /(?:^| )(?:и|или|но|а|что|чтобы|если|когда|потому|как|про|о|об|в|на|с|со|к|для|из|по|за|у|это|можешь|можете|могу|хочу|надо|нужно|будет|будем|давай|расскажи|объясни|скажи|подскажи|помоги|пожалуйста|сказать|рассказать|объяснить|подсказать|помочь|сделать|проверить|посчитать|сравнить|узнать|плюс|минус|умножить|разделить)$/.test(body)
    || /^(?:как ты думаешь|что ты думаешь)$/.test(body);
  result.complete = result.stop || (!unfinished && (question || request) && words.length >= 3);
  if (addressed && /^(?:связь|прием|алло|ты тут|ты здесь|ты меня слышишь|ты слышишь меня|меня слышишь|слышишь меня|ты меня слышишь хорошо|как слышно)$/.test(body)) {
    result.localReply = 'Да, я здесь, слышу тебя.';
    result.complete = true;
  }
  return result;
}

/** Unknown languages use conservative hints and leave ordinary interpretation to the model. */
function genericSpeechIntent(text: string, botName: string, members: Iterable<Member>, language: string): SpeechIntent {
  const normalized = normalizeSpeech(text), bot = normalizeSpeech(botName);
  const addressed = !!bot && ` ${normalized} `.includes(` ${bot} `);
  const body = addressed ? normalized.replace(bot, '').trim() : normalized;
  const result: SpeechIntent = { kind: 'comment', addressed, complete: false, detailed: false, stop: false, normalized };
  if (!body && !addressed) return { ...result, kind: 'backchannel' };
  if (!addressed) for (const member of members) {
    const name = normalizeSpeech(member.name);
    if (name && name !== bot && (normalized.startsWith(`${name} `) || normalized.endsWith(` ${name}`))) return { ...result, kind: 'elsewhere' };
  }
  if (language.split('-')[0] !== 'en') return { ...result, kind: text.includes('?') ? 'question' : 'comment' };
  result.stop = addressed && /^(?:stop|stop please|please stop|stop talking|be quiet)$/.test(body);
  result.detailed = /\b(?:in detail|step by step|long story|explain fully)\b/.test(body);
  if (!addressed && /^(?:yes|yeah|yep|okay|ok|thanks|thank you|right|hmm|ha ha)$/.test(body)) return { ...result, kind: 'backchannel', complete: true };
  result.kind = /^(?:no i mean|i meant|actually|wait|hold on)\b/.test(body) ? 'correction'
    : text.includes('?') || /^(?:what|how|why|when|where|who|which|can you|could you|do you|are you)\b/.test(body) ? 'question'
    : /^(?:please |tell me|explain|remind|say|help|check|search|send|write)\b/.test(body) ? 'request' : 'comment';
  const unfinished = /\b(?:and|or|but|about|with|to|for|plus|minus|can you|could you|would you|tell me|remind me|please|tell|explain|say|help|check|search|send|write)$/.test(body);
  result.complete = result.stop || (['question', 'request'].includes(result.kind) && body.split(' ').length >= 3 && !unfinished);
  if (addressed && /^(?:can you hear me|are you there|hello|sound check)$/.test(body)) {
    result.localReply = 'Yes, I am here and can hear you.';
    result.complete = true;
  }
  return result;
}

export function thinkingCueText(language: string): string {
  return language.split('-')[0] === 'ru' ? 'Хм.' : language.split('-')[0] === 'en' ? 'Hmm.' : '';
}
