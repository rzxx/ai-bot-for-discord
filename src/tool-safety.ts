import { t } from './locale';
/** Text only: no links, Discord markup, mass mentions, code or hidden controls. */
export function safeText(value: string, limit: number): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, ' ')
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/!?\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/(?:https?:\/\/|www\.)\S+/gi, ' ')
    .replace(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:[/:?#]\S*)?/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/@(?:everyone|here)\b/gi, ' ')
    .replace(/@/g, '＠')
    .replace(/(?:sk-[a-zA-Z0-9_-]{12,}|eyJ[a-zA-Z0-9_.-]{30,})/g, '[redacted]')
    .replace(/[`*_#|~]/g, '')
    .replace(/\s+/g, ' ').trim().slice(0, limit);
}
export function safeName(value: string) { return safeText(value, 40) || t('Participant'); }

export function publicResultUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443' || value.length > 700
      || !host.includes('.') || /^[\d.]+$/.test(host) || host.includes(':')
      || /(?:^|\.)(?:localhost|local|internal|test|invalid|example|onion)$/.test(host)) return;
    url.hash = '';
    return url.toString();
  } catch { return; }
}
