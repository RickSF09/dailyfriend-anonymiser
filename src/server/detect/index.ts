// Detection: model + patterns → grouped, labelled findings.
//
// Nothing the model says is trusted blindly. Every item must be found
// verbatim in the document (the same search the redaction step uses), or it
// is dropped: an item that cannot be located cannot be removed, and showing
// it to the user would be a false reassurance.

import { ENTITY_TYPES, type EntityType, type Finding } from '../../shared/types.js';
import { config } from '../config.js';
import { jsonCall } from '../mistral.js';
import { DETECT_SYSTEM, RECALL_USER_PREFIX } from '../prompts/detect.js';
import { findAll, findOccurrences, normalise } from './match.js';
import { findPatterns } from './ukPatterns.js';

export interface TextUnit {
  text: string;
  /** 1-based page, or null for formats without pages (Word). */
  page: number | null;
}

interface Candidate {
  text: string;
  type: EntityType;
  refersTo: string;
}

interface Group {
  type: EntityType;
  label: string;
  texts: string[];
}

export interface DetectOptions {
  model?: string;
  recallPass?: boolean;
  onProgress?: (done: number, total: number) => void;
}

const CHUNK_CHARS = 12_000;
const PARALLEL_CALLS = 3;

const LABEL_NAMES: Record<EntityType, string> = {
  PERSON: 'Person',
  ADDRESS: 'Address',
  PLACE: 'Place',
  ORGANISATION: 'Organisation',
  PHONE: 'Phone number',
  EMAIL: 'Email',
  ID: 'ID number',
  DATE_OF_BIRTH: 'Date of birth',
  OTHER: 'Detail',
};

const TITLES = new Set([
  'mr',
  'mrs',
  'ms',
  'miss',
  'mx',
  'dr',
  'prof',
  'professor',
  'nurse',
  'sister',
  'rev',
  'reverend',
  'sir',
  'lady',
  'lord',
  'cllr',
  'councillor',
  'auntie',
  'aunty',
  'uncle',
  'nan',
  'nanna',
  'grandma',
  'grandad',
]);

// Family words used in place of a name ("Dad is staying with us"). They
// identify nobody, and blanking them makes a document harder to follow.
const FAMILY_WORDS = new Set([
  'mum',
  'mam',
  'mom',
  'mother',
  'dad',
  'father',
  'nan',
  'nana',
  'nanna',
  'gran',
  'granny',
  'grandma',
  'grandad',
  'grandpa',
  'grandad',
  'nain',
  'taid',
  'mamgu',
  'tadcu',
  'auntie',
  'aunty',
  'uncle',
]);

// Capitalised words that are not names, so a person "Care Jones" (unlikely) is
// the price of never blanking "Care" across a care plan.
const NOT_NAMES = new Set([
  'the',
  'and',
  'care',
  'plan',
  'mum',
  'dad',
  'son',
  'daughter',
  'wife',
  'husband',
  'brother',
  'sister',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
  'january',
  'february',
  'march',
  'april',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
]);

export function chunkUnits(units: TextUnit[], max = CHUNK_CHARS): string[] {
  const pieces: string[] = [];
  for (const u of units) {
    if (u.text.length <= max) {
      pieces.push(u.text);
      continue;
    }
    // A very long page or paragraph: split on line breaks, then hard-split.
    let buf = '';
    for (const line of u.text.split('\n')) {
      if (buf.length + line.length + 1 > max && buf) {
        pieces.push(buf);
        buf = '';
      }
      if (line.length > max) {
        for (let i = 0; i < line.length; i += max) pieces.push(line.slice(i, i + max));
      } else {
        buf += (buf ? '\n' : '') + line;
      }
    }
    if (buf) pieces.push(buf);
  }
  const chunks: string[] = [];
  let cur = '';
  for (const p of pieces) {
    if (!p.trim()) continue;
    if (cur && cur.length + p.length + 2 > max) {
      chunks.push(cur);
      cur = '';
    }
    cur += (cur ? '\n\n' : '') + p;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * Whether a detected string can safely be searched for and removed
 * everywhere. A bare "24" (someone's age) would also blank "24 hours" and
 * every date containing 24, so short numbers are left for the user to add.
 */
function isSearchable(text: string): boolean {
  if (text.length < 2 || text.length > 200) return false;
  if (/^\[[^\]]*\]$/.test(text)) return false; // one of our own labels echoed back
  if (/^\d{1,3}$/.test(text)) return false;
  return true;
}

/** A "date of birth" in the last two years is a visit or referral date. */
function isRecentDate(text: string): boolean {
  const year = Number(/\b(19|20)\d{2}\b/.exec(text)?.[0]);
  return year >= new Date().getFullYear() - 1;
}

function parseEntities(raw: unknown): Candidate[] {
  const list = (raw as { entities?: unknown })?.entities;
  if (!Array.isArray(list)) return [];
  const out: Candidate[] = [];
  for (const e of list) {
    const text = typeof e?.text === 'string' ? e.text.trim() : '';
    const type = ENTITY_TYPES.includes(e?.type) ? (e.type as EntityType) : 'OTHER';
    const refersTo = typeof e?.refers_to === 'string' && e.refers_to.trim() ? e.refers_to.trim() : text;
    if (!isSearchable(text)) continue;
    if (type === 'DATE_OF_BIRTH' && isRecentDate(text)) continue;
    out.push({ text, type, refersTo });
  }
  return out;
}

async function askModel(userContent: string, model: string | undefined): Promise<Candidate[]> {
  const raw = await jsonCall<unknown>(
    [
      { role: 'system', content: DETECT_SYSTEM },
      { role: 'user', content: userContent },
    ],
    { model, maxTokens: 6000 },
  );
  return parseEntities(raw);
}

function canonical(type: EntityType, s: string): string {
  let n = normalise(s);
  if (type === 'PERSON') {
    n = n
      .split(' ')
      .filter((w) => !TITLES.has(w))
      .join(' ');
  }
  return `${type}:${n}`;
}

const NAME_PARTICLES = new Set([
  'ap',
  'ab',
  'de',
  'van',
  'von',
  'der',
  'la',
  'le',
  'du',
  'da',
  'di',
  'bin',
  'al',
]);

/** "Mr Dafydd Pritchard", "D Pritchard", "O'Neil": capitalised words only. */
function isNameShaped(text: string): boolean {
  const words = text.trim().split(/\s+/);
  return (
    words.length <= 5 &&
    words.every((w) => /^[\p{Lu}]/u.test(w) || NAME_PARTICLES.has(w.toLowerCase())) &&
    !/[,;:()]/.test(text)
  );
}

/** Group candidates so every form of one person shares a label. */
function groupCandidates(cands: Candidate[]): Group[] {
  const groups: (Omit<Group, 'label'> & { canon: string })[] = [];
  const byText = new Map<string, (typeof groups)[number]>();
  const byCanon = new Map<string, (typeof groups)[number]>();

  for (const c of cands) {
    if (c.type === 'PERSON' && FAMILY_WORDS.has(normalise(c.text))) continue;
    const nText = normalise(c.text);
    const canon = canonical(c.type, c.refersTo);
    let g = byText.get(nText) ?? byCanon.get(canon);
    if (!g) {
      g = { type: c.type, texts: [], canon };
      groups.push(g);
    }
    if (!g.texts.some((t) => t === c.text)) g.texts.push(c.text);
    if (!byText.has(nText)) byText.set(nText, g);
    if (!byCanon.has(canon)) byCanon.set(canon, g);
  }

  // "Mr Pritchard" or "D Pritchard" joins "Dafydd Pritchard" when he is the
  // only Pritchard. With two (a man and his grandson), a bare surname stays
  // its own group rather than being pinned on the wrong person.
  const persons = groups.filter((g) => g.type === 'PERSON');
  const nameWords = (g: { texts: string[] }) => {
    const words = new Set<string>();
    const initials = new Set<string>();
    // Only name-shaped texts count: "Eirlys's key worker, Bethan" is two
    // people in a phrase, and must not make Eirlys and Bethan one person.
    for (const t of g.texts.filter(isNameShaped)) {
      for (const w of normalise(t).split(' ')) {
        if (!w || TITLES.has(w)) continue;
        if (w.length === 1) initials.add(w);
        else words.add(w);
      }
    }
    return { words, initials };
  };
  for (const g of persons) {
    const mine = nameWords(g);
    if (!mine.words.size) continue;
    const fits = persons.filter((o) => {
      if (o === g || !o.texts.length) return false;
      const theirs = nameWords(o);
      if (theirs.words.size <= mine.words.size) return false;
      const all = [...theirs.words];
      return (
        [...mine.words].every((w) => theirs.words.has(w)) &&
        [...mine.initials].every((i) => all.some((w) => w.startsWith(i)))
      );
    });
    if (fits.length === 1) {
      const target = fits[0]!;
      for (const t of g.texts) if (!target.texts.includes(t)) target.texts.push(t);
      g.texts = [];
    }
  }

  // Numbered in order of first appearance, per type.
  const counters = new Map<EntityType, number>();
  return groups
    .filter((g) => g.texts.length)
    .map((g) => {
      const n = (counters.get(g.type) ?? 0) + 1;
      counters.set(g.type, n);
      const name = LABEL_NAMES[g.type];
      const label = g.type === 'DATE_OF_BIRTH' && n === 1 ? `[${name}]` : `[${name} ${n}]`;
      return { type: g.type, label, texts: g.texts };
    });
}

function occursAnywhere(units: TextUnit[], text: string): boolean {
  return units.some((u) => findOccurrences(u.text, text).length > 0);
}

/** Replace every current match with its label, as the recall pass sees it. */
function maskText(text: string, groups: Group[]): string {
  const spans = findAll(text, termsOf(groups));
  let out = '';
  let pos = 0;
  for (const s of spans) {
    out += text.slice(pos, s.start) + s.label;
    pos = s.end;
  }
  return out + text.slice(pos);
}

export function termsOf(groups: { label: string; texts: string[] }[]) {
  return groups.flatMap((g) => g.texts.map((text) => ({ text, label: g.label })));
}

/**
 * First and last names on their own. If the model lists "Margaret Jones", a
 * later bare "Jones" is the same person and must go too. A name part is only
 * added where it appears outside the longer forms already covered, and only
 * with a capital, so "May" the name never removes "may" the verb.
 */
function addNameParts(groups: Group[], units: TextUnit[]): void {
  const masked = units.map((u) => ({ ...u, text: maskText(u.text, groups) }));
  for (const g of groups) {
    if (g.type !== 'PERSON') continue;
    const parts = new Set<string>();
    for (const t of g.texts) {
      for (const w of t.split(/[\s,]+/)) {
        const bare = w.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');
        if (bare.length < 3 || !/^\p{Lu}/u.test(bare)) continue;
        if (TITLES.has(bare.toLowerCase()) || NOT_NAMES.has(bare.toLowerCase())) continue;
        parts.add(bare);
      }
    }
    for (const p of parts) {
      if (g.texts.includes(p)) continue;
      if (occursAnywhere(masked, p)) g.texts.push(p);
    }
  }
}

export async function detect(units: TextUnit[], opts: DetectOptions = {}): Promise<Finding[]> {
  const recall = opts.recallPass ?? config.mistral.recallPass;
  const chunks = chunkUnits(units);
  const total = chunks.length * (recall ? 2 : 1);
  let done = 0;
  const tick = () => opts.onProgress?.(++done, total);
  opts.onProgress?.(0, total);

  // 1. Model, per chunk.
  const modelHits = (
    await mapPool(chunks, PARALLEL_CALLS, async (chunk) => {
      const r = await askModel(`TEXT:\n${chunk}`, opts.model);
      tick();
      return r;
    })
  ).flat();

  // 2. Fixed-shape identifiers, from every unit.
  const patternHits: Candidate[] = units.flatMap((u) =>
    findPatterns(u.text).map((h) => ({ text: h.text, type: h.type, refersTo: h.text })),
  );

  // 3. Keep only what can actually be found in the document.
  const verified = (list: Candidate[]) => list.filter((c) => occursAnywhere(units, c.text));
  let groups = groupCandidates([...verified(modelHits), ...verified(patternHits)]);

  // 4. Second look, with everything found so far masked out.
  if (recall) {
    const extra = (
      await mapPool(chunks, PARALLEL_CALLS, async (chunk) => {
        const r = await askModel(RECALL_USER_PREFIX + maskText(chunk, groups), opts.model);
        tick();
        return r;
      })
    ).flat();
    if (extra.length) {
      groups = groupCandidates([...verified(modelHits), ...verified(patternHits), ...verified(extra)]);
    }
  }

  addNameParts(groups, units);
  return summarise(groups, units);
}

/** Counts and pages per group, from the same matcher the redaction uses. */
export function summarise(groups: Group[], units: TextUnit[]): Finding[] {
  const counts = new Map<string, number>();
  const pages = new Map<string, Set<number>>();
  const terms = termsOf(groups);
  for (const u of units) {
    for (const s of findAll(u.text, terms)) {
      counts.set(s.label, (counts.get(s.label) ?? 0) + 1);
      if (u.page !== null) {
        const set = pages.get(s.label) ?? new Set<number>();
        set.add(u.page);
        pages.set(s.label, set);
      }
    }
  }
  return groups
    .filter((g) => (counts.get(g.label) ?? 0) > 0)
    .map((g) => ({
      label: g.label,
      type: g.type,
      texts: g.texts,
      count: counts.get(g.label) ?? 0,
      pages: [...(pages.get(g.label) ?? [])].sort((a, b) => a - b),
    }));
}
