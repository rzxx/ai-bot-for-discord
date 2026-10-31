import { languageOf } from './locale';

export const speechPresets = {
  en: { speechLanguage: 'en', responseLanguage: 'auto', sttEngine: 'whisper', voice: 'en_0', ttsModel: 'silero-v3_en.pt', modelId: 'v3_en', modelUrl: 'https://models.silero.ai/models/tts/en/v3_en.pt' },
  ru: { speechLanguage: 'ru', responseLanguage: 'auto', sttEngine: 'gigaam', voice: 'eugene', ttsModel: 'silero-v5_5_ru.pt', modelId: 'v5_5_ru', modelUrl: 'https://models.silero.ai/models/tts/ru/v5_5_ru.pt' },
} as const;

export function speechPreset(locale: string) { return speechPresets[languageOf(locale)]; }
export function voicesFor(language: string): string[] {
  return languageOf(language) === 'ru' ? ['aidar', 'baya', 'kseniya', 'xenia', 'eugene'] : Array.from({ length: 118 }, (_, i) => `en_${i}`);
}
