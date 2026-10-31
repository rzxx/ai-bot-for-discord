import { AsyncLocalStorage } from 'node:async_hooks';
import { ruMessages } from './locales/messages';

const scope = new AsyncLocalStorage<string>();
let defaultLocale = 'en';

export function languageOf(locale: string): 'en' | 'ru' {
  return locale.toLowerCase().split('-')[0] === 'ru' ? 'ru' : 'en';
}
export function setLocale(locale: string) { defaultLocale = locale; }
export function currentLocale() { return scope.getStore() ?? defaultLocale; }
export function withLocale<T>(locale: string, work: () => T): T { return scope.run(locale, work); }

/** English source messages are the fallback. Only host-owned strings use this API. */
export function translate(locale: string, message: string, ...values: unknown[]): string {
  const template = languageOf(locale) === 'ru' && Object.hasOwn(ruMessages, message) ? ruMessages[message]! : message;
  return template.replace(/\{(\d+)\}/g, (placeholder, index: string) => Number(index) < values.length ? String(values[Number(index)]) : placeholder);
}
export function t(message: string, ...values: unknown[]): string { return translate(currentLocale(), message, ...values); }
