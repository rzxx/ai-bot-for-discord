import { t } from './locale';
import type { Reply } from './llm';

// Decode only the unambiguous JSON string prefix. Incomplete escapes and Unicode
// surrogate pairs stay buffered, including when a provider splits inside \uXXXX.
function stringPrefix(raw: string): { text: string; closed: boolean } {
  let result = '', closed = false;
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i]!;
    if (char === '"') { closed = true; break; }
    if (char !== '\\') { result += char; continue; }
    const escape = raw[++i];
    if (!escape) break;
    if (escape === 'u') {
      const digits = raw.slice(i + 1, i + 5);
      if (!/^[\da-f]{4}$/i.test(digits)) break;
      result += String.fromCharCode(parseInt(digits, 16)); i += 4;
    } else {
      const value = ({ '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' } as Record<string, string>)[escape];
      if (value === undefined) break;
      result += value;
    }
  }
  return { text: result.replace(/[\uD800-\uDBFF]$/, ''), closed };
}

/** Only the requested speak-first JSON shape is eligible for early speech.
 * Other valid key orders fall back to speaking after validation at completion. */
export class ReplySentences {
  private sent = '';
  constructor(private maxChars: number, private emit: (sentence: string) => void) {}
  feed(raw: string) {
    const match = /^\s*(?:```json\s*)?\{\s*"speak"\s*:\s*true\s*,\s*"text"\s*:\s*"/.exec(raw);
    if (!match) return;
    const decoded = stringPrefix(raw.slice(match[0].length));
    // A trailing unfinished tag could otherwise change an already emitted prefix.
    const text = decoded.text.replace(/<[^>]*$|<[^>]*>/g, '').replace(/[`*_#]/g, '').trimStart();
    if (!text.startsWith(this.sent)) throw new Error(t("Streaming reply changed an emitted prefix."));
    const tail = text.slice(this.sent.length) + (decoded.closed ? ' ' : '');
    const endings = /[.!?…]+[»”"')]*(?=\s)/g;
    // A long first sentence needn't hold up all audio: release a substantial
    // complete clause once. Later chunks retain sentence-level prosody.
    if (!this.sent && !endings.test(tail) && text.length >= 90) {
      const clause = /[,;:](?=\s)/g;
      let boundary: RegExpExecArray | null;
      while ((boundary = clause.exec(text))) {
        const through = boundary.index + 1;
        if (through >= 55 && through <= Math.min(140, this.maxChars)) {
          this.sent = text.slice(0, through); this.emit(this.sent.trim()); return;
        }
      }
    }
    endings.lastIndex = 0;
    let end: RegExpExecArray | null;
    while ((end = endings.exec(tail))) {
      let through = this.sent.length + end.index + end[0].length;
      if (through > this.maxChars) break;
      // Do not split a decimal such as 3.14 or common single-letter initials.
      if (end[0] === '.' && /(?:^|\s)\p{L}$/u.test(tail.slice(0, end.index))) continue;
      // When both are already available, don't synthesize a tiny opener and its
      // continuation as two independent utterances. No extra buffering deadline.
      if (text.slice(this.sent.length, through).trim().length < 32) {
        const rest = text.slice(through) + (decoded.closed ? ' ' : '');
        const next = /[.!?…]+[»”"')]*(?=\s)/.exec(rest);
        if (next && through + next.index + next[0].length <= Math.min(this.maxChars, this.sent.length + 220)) through += next.index + next[0].length;
      }
      const sentence = text.slice(this.sent.length, through).trim();
      if (sentence) this.emit(sentence);
      this.sent = text.slice(0, through);
      // The next delta is reparsed from the full prefix; emit at most one here.
      // Recursion handles providers that deliver multiple sentences in one delta.
      this.feed(raw); return;
    }
    // A closed text field is already a complete speech unit even without final
    // punctuation. Keep reading the provider stream for validation/errors, but
    // don't hold this final fragment solely for response.completed.
    const completeText = text.trimEnd();
    if (decoded.closed && completeText.length <= this.maxChars) {
      const remaining = completeText.slice(this.sent.length).trim();
      if (remaining) this.emit(remaining);
      this.sent = completeText;
    }
  }
  finish(reply: Reply) {
    if (this.sent && (!reply.speak || !reply.text.startsWith(this.sent))) throw new Error(t("Completed reply differs from speech already streamed."));
    const tail = reply.text.slice(this.sent.length).trim();
    if (reply.speak && tail) this.emit(tail);
    this.sent = reply.text;
  }
}
