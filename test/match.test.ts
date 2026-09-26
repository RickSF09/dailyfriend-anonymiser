import { describe, expect, it } from 'vitest';
import { findAll, findOccurrences } from '../src/server/detect/match.js';

describe('findOccurrences', () => {
  it('matches whole words only', () => {
    expect(findOccurrences('Jo and Jones', 'Jo')).toEqual([{ start: 0, end: 2 }]);
  });

  it('needs a capital for a single ordinary word', () => {
    // "Hope" the name must not remove "hope" the word.
    expect(findOccurrences('We hope Hope is well', 'Hope')).toEqual([{ start: 8, end: 12 }]);
  });

  it('matches multi-word names in any case and across line breaks', () => {
    expect(findOccurrences('MARGARET JONES\nand Margaret\nJones', 'Margaret Jones')).toHaveLength(2);
  });

  it('matches numbers whatever the spacing', () => {
    const text = 'NHS 5738563913 or 573-856-3913 or 573 856 3913';
    expect(findOccurrences(text, '573 856 3913')).toHaveLength(3);
  });

  it('keeps possessives and punctuation outside the match', () => {
    const text = "Maggie's cat (Maggie).";
    expect(findOccurrences(text, 'Maggie').map((s) => text.slice(s.start, s.end))).toEqual([
      'Maggie',
      'Maggie',
    ]);
  });
});

describe('findAll', () => {
  it('merges overlaps and keeps the longer label', () => {
    const spans = findAll('Margaret Jones saw Jones', [
      { text: 'Jones', label: '[Person 9]' },
      { text: 'Margaret Jones', label: '[Person 1]' },
    ]);
    expect(spans).toEqual([
      { start: 0, end: 14, label: '[Person 1]' },
      { start: 19, end: 24, label: '[Person 9]' },
    ]);
  });
});
