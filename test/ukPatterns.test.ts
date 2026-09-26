import { describe, expect, it } from 'vitest';
import { findPatterns, isValidNhsNumber } from '../src/server/detect/ukPatterns.js';

describe('isValidNhsNumber', () => {
  it('accepts a number with a correct check digit', () => {
    expect(isValidNhsNumber('573 856 3913')).toBe(true);
  });
  it('rejects a wrong check digit', () => {
    expect(isValidNhsNumber('573 856 3914')).toBe(false);
  });
});

describe('findPatterns', () => {
  const found = (text: string) => findPatterns(text).map((h) => `${h.type}:${h.text}`);

  it('finds UK identifiers', () => {
    const hits = found(
      'NHS 573 856 3913, NI AB 12 34 56 C, CF62 7AB, 07700 900123, (01446) 734219, +44 29 2012 3456, jo@example.com, sort code 20-45-77',
    );
    expect(hits).toEqual(
      expect.arrayContaining([
        'ID:573 856 3913',
        'ID:AB 12 34 56 C',
        'ADDRESS:CF62 7AB',
        'PHONE:07700 900123',
        'PHONE:(01446) 734219',
        'PHONE:+44 29 2012 3456',
        'EMAIL:jo@example.com',
        'ID:20-45-77',
      ]),
    );
  });

  it('only treats a date as a date of birth after a cue', () => {
    expect(found('DOB: 14/03/1941. Review on 02/09/2026.')).toEqual(['DATE_OF_BIRTH:14/03/1941']);
    expect(found('Born on 5th August 1936')).toEqual(['DATE_OF_BIRTH:5th August 1936']);
  });

  it('does not take times or short numbers for phone numbers', () => {
    expect(found('Visits at 07:45 and 18:30, 45 minutes, room 14')).toEqual([]);
  });
});
