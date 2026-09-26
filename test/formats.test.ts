// Redaction per format with a fixed list of terms: no model calls.

import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import * as mupdf from 'mupdf';
import sharp from 'sharp';
import { afterAll, describe, expect, it } from 'vitest';
import { docxTexts, leftoversDocx, openDocx, redactDocx } from '../src/server/formats/docx.js';
import { leftoversImage, redactImage } from '../src/server/formats/image.js';
import { shutdownOcr } from '../src/server/formats/ocr.js';
import { leftoversPdf, readPdf, redactPdf } from '../src/server/formats/pdf.js';
import { outputName, sniff } from '../src/server/pipeline.js';

const fixture = (name: string) =>
  new Uint8Array(fs.readFileSync(path.resolve(import.meta.dirname, '../eval/fixtures', name)));

afterAll(() => shutdownOcr());

describe('PDF', () => {
  const terms = [
    { text: 'Margaret Jones', label: '[Person 1]' },
    { text: 'Maggie', label: '[Person 1]' },
    { text: '573 856 3913', label: '[ID number 1]' },
  ];

  it('removes the text itself, not just its appearance', async () => {
    const { output, removed } = await redactPdf(fixture('Care plan - Margaret Jones.pdf'), terms);
    expect(removed).toBeGreaterThanOrEqual(5);
    const text = (await readPdf(output)).map((p) => p.text).join('\n');
    expect(text).not.toMatch(/Margaret Jones|Maggie|573 856 3913/);
    expect(text).toContain('Metformin 500mg');
    expect(await leftoversPdf(output, terms, new Set())).toEqual([]);
  });

  it('drops document properties', async () => {
    const { output } = await redactPdf(fixture('Care plan - Margaret Jones.pdf'), terms);
    const doc = mupdf.Document.openDocument(output, 'application/pdf');
    expect(doc.getMetaData('info:Author') ?? '').toBe('');
    expect(doc.getMetaData('info:Title') ?? '').toBe('');
  });

  it('reads and redacts scanned pages with OCR', async () => {
    const scanTerms = [{ text: 'Kenneth Bowen', label: '[Person 1]' }];
    const { output, ocrPages } = await redactPdf(fixture('scan0042.pdf'), scanTerms);
    expect(ocrPages.size).toBe(1);
    expect(await leftoversPdf(output, scanTerms, ocrPages)).toEqual([]);
  });
});

describe('Word', () => {
  const terms = [
    { text: 'Dafydd Pritchard', label: '[Person 1]' },
    { text: 'Owain Lloyd', label: '[Person 2]' },
    { text: 'Eirlys', label: '[Person 3]' },
    { text: 'Bethan', label: '[Person 4]' },
  ];

  it('replaces a name split across runs with one label', async () => {
    const { output } = await redactDocx(fixture('Referral D Pritchard.docx'), terms);
    const all = docxTexts(await openDocx(output)).join('\n');
    expect(all).toContain('Mr [Person 1] (DOB');
    expect(all).not.toMatch(/Dafydd Pri|tchard \(DOB/);
  });

  it('cleans headers, footers, comments and authors', async () => {
    const { output } = await redactDocx(fixture('Referral D Pritchard.docx'), terms);
    const zip = await JSZip.loadAsync(output);
    const footer = Object.keys(zip.files).find((n) => /footer\d*\.xml$/.test(n))!;
    expect(await zip.file(footer)!.async('string')).toContain('[Person 2]');
    const comments = await zip.file('word/comments.xml')!.async('string');
    expect(comments).toContain('[Person 4]');
    expect(comments).not.toContain('w:author="Owain Lloyd"');
    const core = await zip.file('docProps/core.xml')!.async('string');
    expect(core).not.toContain('Owain Lloyd');
    expect(await leftoversDocx(output, terms)).toEqual([]);
  });
});

describe('Images', () => {
  it('paints over matches and drops EXIF', async () => {
    const terms = [{ text: 'Beryl Thomas', label: '[Person 1]' }];
    const { output } = await redactImage(fixture('IMG_4471.jpg'), terms, 'jpeg');
    expect((await sharp(output).metadata()).exif).toBeUndefined();
    expect(await leftoversImage(output, terms)).toEqual([]);
  });
});

describe('file handling', () => {
  it('identifies files by content, not name', () => {
    expect(sniff(fixture('scan0042.pdf')).kind).toBe('pdf');
    expect(sniff(fixture('IMG_4471.jpg')).kind).toBe('image');
    expect(() => sniff(new TextEncoder().encode('hello'))).toThrow(/PDF, a Word document/);
  });

  it('takes names out of the download file name', () => {
    expect(
      outputName('Care plan - Margaret Jones.pdf', [{ text: 'Margaret Jones', label: '[Person 1]' }], 'pdf'),
    ).toBe('Care plan - Person 1 - anonymised.pdf');
  });
});
