// The two jobs the API offers: find personal details, then remove the ones
// the user approved. Both are stateless: the file arrives with each request
// and is gone when the request ends.

import type { DocKind, DocMeta, Finding, Stage, Term } from '../shared/types.js';
import { detect, type TextUnit } from './detect/index.js';
import { findAll } from './detect/match.js';
import { docxTexts, leftoversDocx, openDocx, redactDocx } from './formats/docx.js';
import { UserFacingError } from './formats/errors.js';
import { type ImageFormat, leftoversImage, readImage, redactImage } from './formats/image.js';
import { leftoversPdf, readPdf, redactPdf } from './formats/pdf.js';

export type Progress = (stage: Stage, done?: number, total?: number) => void;

interface Sniffed {
  kind: DocKind;
  mime: string;
  ext: string;
  imageFormat?: ImageFormat;
}

/** Decide the type from the file's bytes, never from its name. */
export function sniff(buf: Uint8Array): Sniffed {
  const head = Buffer.from(buf.subarray(0, 1024));
  const ascii = head.toString('latin1');
  if (ascii.includes('%PDF-')) return { kind: 'pdf', mime: 'application/pdf', ext: 'pdf' };
  if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) {
    return {
      kind: 'docx',
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ext: 'docx',
    };
  }
  if (head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0) {
    throw new UserFacingError('Older Word files (.doc) are not supported. Save it as .docx and try again.');
  }
  if (head[0] === 0x89 && ascii.slice(1, 4) === 'PNG') {
    return { kind: 'image', mime: 'image/png', ext: 'png', imageFormat: 'png' };
  }
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return { kind: 'image', mime: 'image/jpeg', ext: 'jpg', imageFormat: 'jpeg' };
  }
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') {
    return { kind: 'image', mime: 'image/webp', ext: 'webp', imageFormat: 'webp' };
  }
  if (/ftyp(heic|heix|mif1|hevc)/.test(ascii.slice(4, 16))) {
    throw new UserFacingError(
      'iPhone photos (HEIC) are not supported yet. Share or export the photo as JPG.',
    );
  }
  throw new UserFacingError('Please upload a PDF, a Word document (.docx), or a PNG or JPG image.');
}

/** The file name without its extension: it often contains the person's name. */
function baseName(filename: string): string {
  const leaf = filename.split(/[/\\]/).pop() ?? '';
  return leaf.replace(/\.[A-Za-z0-9]{1,5}$/, '').slice(0, 150);
}

interface Extracted {
  units: TextUnit[];
  meta: DocMeta;
}

async function extract(buf: Uint8Array, s: Sniffed, progress: Progress): Promise<Extracted> {
  progress('reading');
  if (s.kind === 'pdf') {
    const pages = await readPdf(buf, (d, t) => progress('reading', d, t));
    return {
      units: pages.map((p) => ({ text: p.text, page: p.page })),
      meta: {
        kind: 'pdf',
        pages: pages.length,
        ocrPages: pages.filter((p) => p.ocr).length,
        notices: pages.some((p) => p.ocr)
          ? [
              'Some pages were scanned images and were read automatically. Check handwriting and faint text yourself.',
            ]
          : [],
      },
    };
  }
  if (s.kind === 'docx') {
    const file = await openDocx(buf);
    return {
      units: docxTexts(file).map((text) => ({ text, page: null })),
      meta: { kind: 'docx', pages: 1, ocrPages: 0, notices: file.notices },
    };
  }
  const text = await readImage(buf);
  return {
    units: [{ text: text.text, page: 1 }],
    meta: {
      kind: 'image',
      pages: 1,
      ocrPages: 1,
      notices: ['Photos of faces, signatures and handwriting are not detected. Check the image yourself.'],
    },
  };
}

export interface AnalyseOptions {
  filename: string;
  progress: Progress;
  /** Called with the page count before any model call; throws to refuse. */
  chargePages: (pages: number) => void;
  model?: string;
  recallPass?: boolean;
}

export async function analyse(
  buf: Uint8Array,
  opts: AnalyseOptions,
): Promise<{ findings: Finding[]; meta: DocMeta }> {
  const s = sniff(buf);
  const { units, meta } = await extract(buf, s, opts.progress);
  if (!units.some((u) => u.text.trim())) {
    throw new UserFacingError('No text was found in this file, so there is nothing to remove.');
  }
  opts.chargePages(meta.pages);
  const name = baseName(opts.filename);
  if (name) units.push({ text: name, page: null });
  opts.progress('detecting', 0);
  const findings = await detect(units, {
    model: opts.model,
    recallPass: opts.recallPass,
    onProgress: (d, t) => opts.progress('detecting', d, t),
  });
  return { findings, meta };
}

/** Raised when the finished file still contains an approved term. Never shipped. */
export class LeakError extends Error {
  constructor(readonly count: number) {
    super(`Post-check found ${count} approved term(s) still in the output`);
    this.name = 'LeakError';
  }
}

export interface AnonymiseResult {
  output: Uint8Array;
  mime: string;
  name: string;
  removed: number;
}

export async function anonymise(
  buf: Uint8Array,
  terms: Term[],
  filename: string,
  progress: Progress,
): Promise<AnonymiseResult> {
  const s = sniff(buf);
  progress('applying');

  let output: Uint8Array;
  let removed: number;
  let leftovers: string[];
  if (s.kind === 'pdf') {
    const r = await redactPdf(buf, terms, (d, t) => progress('applying', d, t));
    progress('checking');
    output = r.output;
    removed = r.removed;
    leftovers = await leftoversPdf(output, terms, r.ocrPages);
  } else if (s.kind === 'docx') {
    const r = await redactDocx(buf, terms);
    progress('checking');
    output = r.output;
    removed = r.removed;
    leftovers = await leftoversDocx(output, terms);
  } else {
    const r = await redactImage(buf, terms, s.imageFormat ?? 'png');
    progress('checking');
    output = r.output;
    removed = r.removed;
    leftovers = await leftoversImage(output, terms);
  }
  if (leftovers.length) throw new LeakError(leftovers.length);

  return { output, mime: s.mime, name: outputName(filename, terms, s.ext), removed };
}

/** "Margaret Jones care plan.pdf" → "Person 1 care plan - anonymised.pdf". */
export function outputName(filename: string, terms: Term[], ext: string): string {
  let name = baseName(filename);
  for (const span of findAll(name, terms).reverse()) {
    name = name.slice(0, span.start) + span.label.replace(/[[\]]/g, '') + name.slice(span.end);
  }
  name =
    name
      .replace(/[^\p{L}\p{N} ._()-]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim() || 'document';
  return `${name} - anonymised.${ext}`;
}
