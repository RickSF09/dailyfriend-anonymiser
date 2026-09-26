// Deterministic detectors for identifiers with a fixed shape. These run
// alongside the model and catch what a model can miss on a long page: a
// phone number in a table, an NHS number in a footer.

import type { EntityType } from '../../shared/types.js';

export interface PatternHit {
  text: string;
  type: EntityType;
}

/** NHS numbers carry a modulus 11 check digit; a random 10-digit run rarely passes. */
export function isValidNhsNumber(raw: string): boolean {
  const d = raw.replace(/\D/g, '');
  if (d.length !== 10) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(d[i]) * (10 - i);
  const check = 11 - (sum % 11);
  if (check === 10) return false;
  return (check === 11 ? 0 : check) === Number(d[9]);
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

// UK numbers: 07700 900123, 01446 123456, (01446) 123456, +44 7700 900123,
// +44 (0)29 2012 3456. Anchored on digits so dates and times do not qualify.
const PHONE =
  /(?<![\d\w])(?:(?:\+44\s?(?:\(0\)\s?)?\d|0\d)(?:[\s-]?\d){8,9}|\(0\d{2,4}\)\s?\d{3,4}[\s-]?\d{3,4})(?!\d)/g;

const TEN_DIGITS = /(?<!\d)\d{3}[\s-]?\d{3}[\s-]?\d{4}(?!\d)/g;

// National Insurance number, e.g. AB 12 34 56 C.
const NI_NUMBER = /\b[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z]\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]\b/gi;

// Royal Mail postcode format, e.g. CF62 7AB, SW1A 1AA.
const POSTCODE =
  /\b(?:[A-PR-UWYZ](?:\d{1,2}|[A-HK-Y]\d{1,2}|\d[A-HJKPSTUW]|[A-HK-Y]\d[ABEHMNPRV-Y])\s?\d[ABD-HJLNP-UW-Z]{2})\b/gi;

// Sort code, e.g. 20-45-77.
const SORT_CODE = /(?<![\d-])\d{2}-\d{2}-\d{2}(?![\d-])/g;

// A date written right after a "date of birth" cue. Other dates (visits,
// reviews) are left alone: they matter for care and rarely identify anyone.
const DOB =
  /(?:\bD\.?\s?O\.?\s?B\.?|\bdate of birth|\bborn(?:\s+on)?)\s*[:\-–]?\s*(\d{1,2}[/.\- ]\d{1,2}[/.\- ]\d{2,4}|\d{1,2}(?:st|nd|rd|th)?\s+[A-Z][a-z]+\.?,?\s+\d{4})/gi;

export function findPatterns(text: string): PatternHit[] {
  const hits: PatternHit[] = [];
  const nhsLike = new Set<string>();

  for (const m of text.matchAll(TEN_DIGITS)) {
    if (isValidNhsNumber(m[0]) && !m[0].startsWith('0')) {
      hits.push({ text: m[0], type: 'ID' });
      nhsLike.add(m[0]);
    }
  }
  for (const m of text.matchAll(PHONE)) {
    if (!nhsLike.has(m[0])) hits.push({ text: m[0].trim(), type: 'PHONE' });
  }
  for (const m of text.matchAll(EMAIL)) hits.push({ text: m[0], type: 'EMAIL' });
  for (const m of text.matchAll(NI_NUMBER)) hits.push({ text: m[0], type: 'ID' });
  for (const m of text.matchAll(POSTCODE)) {
    // Case-insensitive matching finds "cf62 7ab" but also words like "an 1be";
    // require the letters to be capitals as written in the document.
    if (m[0] === m[0].toUpperCase()) hits.push({ text: m[0], type: 'ADDRESS' });
  }
  for (const m of text.matchAll(SORT_CODE)) hits.push({ text: m[0], type: 'ID' });
  for (const m of text.matchAll(DOB)) {
    if (m[1]) hits.push({ text: m[1], type: 'DATE_OF_BIRTH' });
  }
  return hits;
}
