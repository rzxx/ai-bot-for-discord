import { parseHTML } from 'linkedom';
import { safeText } from './tool-safety';
import type { SearchResult } from './web-search';

const stops = new Set('the a an of to in for on and or is are what when how does do latest news official please find search мне как что где когда это или для про при из по на и в с за о об во от до ли бы же найти поищи пожалуйста'.split(' '));
const dateQuestion = (query: string) => /(?:date|when|дат|когда)/i.test(query);
const datePattern = /(?:\d{4}[-/]\d{2}[-/]\d{2}|\b\d{1,2}[./]\d{1,2}[./]\d{4}\b|\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:,?\s+\d{4})?|\d{1,2}\s+(?:январ\p{L}*|феврал\p{L}*|март\p{L}*|апрел\p{L}*|мая|июн\p{L}*|июл\p{L}*|август\p{L}*|сентябр\p{L}*|октябр\p{L}*|ноябр\p{L}*|декабр\p{L}*)(?:\s+\d{4})?)/giu;
const dates = (text: string) => text.toLowerCase().match(datePattern) ?? [];
const hasDate = (text: string) => dates(text).length > 0;
function words(text: string) { return text.toLowerCase().replaceAll('ё', 'е').match(/[\p{L}\p{N}]+(?:[.-][\p{L}\p{N}]+)*/gu) ?? []; }
function terms(query: string) { return [...new Set(words(query).filter(w => !stops.has(w)))]; }
export function canonicalUrl(value: string) {
  const url = new URL(value); url.hash = '';
  for (const key of [...url.searchParams.keys()]) if (/^(?:utm_.+|fbclid|gclid|msclkid)$/i.test(key)) url.searchParams.delete(key);
  return url.toString();
}
export function relevance(query: string, text: string) {
  const body = words(text), wanted = terms(query);
  let score = wanted.reduce((n, term) => n + (body.some(w => w === term || term.length > 5 && w.startsWith(term.slice(0, -2))) ? /\d/.test(term) ? 3 : 1 : 0), 0);
  if (dateQuestion(query) && hasDate(text)) score += 2;
  return score;
}

export function extractPage(query: string, html: string, plain = false): { snippet: string; published?: string } {
  let blocks: string[], published: string | undefined;
  if (plain) blocks = html.split(/\n\s*\n/);
  else {
    const { document } = parseHTML(html);
    const date = document.querySelector('meta[property="article:published_time"],meta[itemprop="datePublished"],meta[name="date"]')?.getAttribute('content');
    published = date?.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
    document.querySelectorAll('script,style,noscript,template,nav,footer,aside,form,svg,button,.noexcerpt,.navigation-not-searchable,.references,.reflist,sup.reference,[hidden],[aria-hidden="true"],[style*="display:none"],[style*="display: none"],[role="navigation"],[role="banner"],[class*="cookie"],[id*="cookie"]').forEach(n => n.remove());
    const root = document.querySelector('article,.mw-parser-output,main,[role="main"]') ?? document.body ?? document.documentElement;
    const nodes = [...root.querySelectorAll('p,li,pre,blockquote,tr,time')];
    blocks = nodes.filter(n => !n.querySelector('p,li,pre,blockquote,tr')).map(n => n.textContent ?? '');
    if (!blocks.length) blocks = String('innerText' in root ? root.innerText : root.textContent ?? '').split(/\n+/);
  }
  const cleaned = blocks.slice(0, 2000).map(b => safeText(b, 4000)).filter(b => b.length >= 25);
  // Rank complete sentences/windows, rather than a prefix of the page. Keep
  // adjacent sentences together so qualifiers and negations survive extraction.
  const passages = cleaned.flatMap((block, order) => {
    const wantsDate = dateQuestion(query);
    if (block.length <= 650 && !wantsDate) return [{ text: block, score: relevance(query, block), order }];
    const sentences = block.split(/(?<=[.!?。！？])\s+(?=[^\d])/u);
    return sentences.flatMap((sentence, i) => {
      const text = sentence.trim();
      if (text.length < 25) return [];
      let passage = text;
      if (passage.length > 650) {
        const match = terms(query).map(t => passage.toLowerCase().indexOf(t)).filter(n => n >= 0).sort((a, b) => a - b)[0] ?? 0;
        const start = Math.max(0, match - 120), end = Math.min(passage.length, start + 600);
        const selected = passage.slice(start, end).replace(/^\S*\s/, '').replace(/\s\S*$/, '');
        passage = `${start ? '… ' : ''}${selected}${end < passage.length ? ' …' : ''}`;
      } else if (sentences[i + 1] && passage.length + sentences[i + 1]!.length <= 550
        && (!wantsDate || /^(?:but|however|only|unless|except|но|однако|только|кроме|если)\b/i.test(sentences[i + 1]!.trim()))) passage += ' ' + sentences[i + 1]!.trim();
      return [{ text: passage, score: relevance(query, passage) + Number(wantsDate && hasDate(passage)) * 5, order }];
    });
  }).filter(p => p.score > 0).sort((a, b) => b.score - a.score || a.order - b.order);
  return { snippet: passages[0]?.text ?? '', ...(published ? { published } : {}) };
}

function duplicate(a: string, b: string) {
  const left = new Set(words(a)), right = new Set(words(b));
  const qualifiers = /^(?:no|not|never|cannot|without|only|unless|except|however|expected|rumor|не|нет|нельзя|без|только|кроме|однако|ожидается)$/;
  if ([...left].filter(w => qualifiers.test(w)).sort().join() !== [...right].filter(w => qualifiers.test(w)).sort().join()) return false;
  const aDates = dates(a), bDates = dates(b);
  if (aDates.length && bDates.length && aDates.join() !== bDates.join()) return false;
  // A replaced number can mean disagreement. Extra numbers in an otherwise
  // repeated passage need not prevent deduplication of the shorter passage.
  const aNumbers = [...left].filter(w => /\d/.test(w)), bNumbers = [...right].filter(w => /\d/.test(w));
  if (!aNumbers.every(w => right.has(w)) && !bNumbers.every(w => left.has(w))) return false;
  const shared = [...left].filter(w => right.has(w)).length;
  return shared / Math.max(1, Math.min(left.size, right.size)) >= 0.8;
}
export function rankResults(query: string, results: SearchResult[], excluded: string[] = []) {
  const seen = new Set(excluded.map(canonicalUrl));
  return results.map((r, order) => ({ ...r, url: canonicalUrl(r.url), order }))
    .filter(r => { if (r.url.length > 350 || seen.has(r.url)) return false; seen.add(r.url); return true; })
    // A title match and the engine's original rank outweigh keyword-stuffed
    // snippets. Still promote a late result when early hits miss the subject.
    .sort((a, b) => (relevance(query, b.title) * 2 + Math.min(4, relevance(query, b.snippet)) - b.order * 0.5 + Number(b.via === 'page') * 0.25)
      - (relevance(query, a.title) * 2 + Math.min(4, relevance(query, a.snippet)) - a.order * 0.5 + Number(a.via === 'page') * 0.25));
}

/** count() is an actual tokenizer, supplied by the search worker. No char/token
 * approximation; titles, URLs and provenance all share the result budget. */
export function compactResults(query: string, results: SearchResult[], count: (text: string) => number, budget = 360, previous: SearchResult[] = []): SearchResult[] {
  const selected: SearchResult[] = [];
  const maxSources = dateQuestion(query) && !/(?:compare|versus|\bvs\b|сравн|разниц)/i.test(query) ? 2 : 3;
  const focused = results.map(r => r.via === 'page' ? r : { ...r, snippet: extractPage(query, r.snippet, true).snippet || r.snippet });
  for (const candidate of rankResults(query, focused)) {
    if (selected.length === maxSources) break;
    if ([...previous, ...selected].some(r => duplicate(r.snippet, candidate.snippet))) continue;
    const result: SearchResult = { title: safeText(candidate.title, 80), url: candidate.url, snippet: safeText(candidate.snippet, 650), via: candidate.via ?? 'snippet',
      ...(candidate.published ? { published: candidate.published } : {}) };
    // Shorten by sentence first; a final marked word boundary is allowed only
    // when a single passage exceeds the remaining budget.
    while (result.snippet.length >= 35 && count(JSON.stringify([...selected, result])) > budget) {
      const before = result.snippet.replace(/\s*…$/, '');
      const boundary = before.slice(0, -1).search(/[.!?]\s+[^.!?]*$/);
      result.snippet = boundary >= 60 ? before.slice(0, boundary + 1) : before.slice(0, -25).replace(/\s+\S*$/, '') + ' …';
    }
    if (result.snippet.length >= 12 && count(JSON.stringify([...selected, result])) <= budget) selected.push(result);
  }
  return selected;
}
