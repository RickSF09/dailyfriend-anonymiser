// Finding every place a term appears in a piece of text.
//
// Detection produces strings ("Margaret Jones"); every file format then asks
// this module where those strings occur, so PDFs, Word files and images all
// agree on what counts as a match.

export interface Span {
  start: number;
  end: number;
}

export interface LabelledSpan extends Span {
  label: string;
}

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Letters and digits only, lower-cased: for comparing terms loosely. */
export function normalise(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function isNumberLike(term: string): boolean {
  const digits = term.replace(/\D/g, '').length;
  return digits >= 6 && digits / term.replace(/\s/g, '').length >= 0.6;
}

function buildPattern(term: string): string {
  const t = term.normalize('NFKC').trim();
  if (isNumberLike(t)) {
    // "943 476 5919", "9434765919" and "943-476-5919" are the same number.
    // Keep any leading "+" and letters in place; let digits float on separators.
    return [...t.replace(/[\s\-.]/g, '')].map((c) => (/\d/.test(c) ? c : escapeRegex(c))).join('[\\s\\-.]?');
  }
  // Any run of whitespace in the term matches any run of whitespace in the text,
  // so a name broken across a line still matches.
  return t.split(/\s+/).map(escapeRegex).join('\\s+');
}

/**
 * Case rule. Multi-word terms, numbers and emails match in any case, so a name
 * in a CAPITALS heading is still caught. A single ordinary word must start
 * with a capital where it appears, so the name "Hope" does not also remove the
 * word "hope".
 */
function needsCapital(term: string): boolean {
  const t = term.trim();
  return !/\s/.test(t) && /^\p{Lu}/u.test(t) && !/[\d@]/.test(t);
}

export function findOccurrences(text: string, term: string): Span[] {
  const t = term.trim();
  if (!t) return [];
  const re = new RegExp(buildPattern(t), 'giu');
  const capital = needsCapital(t);
  const out: Span[] = [];
  for (const m of text.matchAll(re)) {
    const start = m.index;
    const end = start + m[0].length;
    // Whole words only: "Jo" must not match inside "Jones".
    const before = text[start - 1];
    const after = text[end];
    const startsWord = LETTER_OR_DIGIT.test(t[0] ?? '');
    const endsWord = LETTER_OR_DIGIT.test(t[t.length - 1] ?? '');
    if (startsWord && before && LETTER_OR_DIGIT.test(before)) continue;
    if (endsWord && after && LETTER_OR_DIGIT.test(after)) continue;
    if (capital && !/^\p{Lu}/u.test(m[0])) continue;
    out.push({ start, end });
  }
  return out;
}

/**
 * All matches of all terms, with overlaps merged. Where two terms overlap
 * ("Margaret Jones" and "Jones"), the merged span keeps the longer term's
 * label.
 */
export function findAll(text: string, terms: { text: string; label: string }[]): LabelledSpan[] {
  const hits: (LabelledSpan & { len: number })[] = [];
  for (const term of terms) {
    for (const s of findOccurrences(text, term.text)) {
      hits.push({ ...s, label: term.label, len: s.end - s.start });
    }
  }
  hits.sort((a, b) => a.start - b.start || b.len - a.len);
  const merged: (LabelledSpan & { len: number })[] = [];
  for (const h of hits) {
    const last = merged[merged.length - 1];
    if (last && h.start < last.end) {
      if (h.len > last.len) {
        last.label = h.label;
        last.len = h.len;
      }
      last.end = Math.max(last.end, h.end);
    } else {
      merged.push({ ...h });
    }
  }
  return merged.map(({ start, end, label }) => ({ start, end, label }));
}
