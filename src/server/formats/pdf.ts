// PDFs: read text with positions, then truly remove matches.
//
// "Truly" matters. Drawing a black box over a name leaves the name in the
// PDF's text layer, which is exactly what an AI tool reads when the file is
// uploaded. MuPDF's redaction deletes the characters (and any image pixels)
// under each box, and the file is then rewritten from scratch so nothing
// survives in old revisions, metadata, bookmarks or form data.

import * as mupdf from 'mupdf';
import { LIMITS, type Term } from '../../shared/types.js';
import { findAll } from '../detect/match.js';
import { type Rect, spanRects } from './geometry.js';
import { ocrImage } from './ocr.js';
import { UserFacingError } from './errors.js';

export interface PageText {
  page: number;
  text: string;
  boxes: (Rect | null)[];
  ocr: boolean;
}

// Render scale for OCR: 3 × 72 dpi = 216 dpi, enough for Tesseract on
// ordinary scans without a huge bitmap per page.
const OCR_SCALE = 3;

function open(buf: Uint8Array): mupdf.PDFDocument {
  let doc: mupdf.Document;
  try {
    doc = mupdf.Document.openDocument(buf, 'application/pdf');
  } catch {
    throw new UserFacingError('This PDF could not be opened. It may be damaged.');
  }
  if (doc.needsPassword()) {
    throw new UserFacingError('This PDF is password-protected. Remove the password and try again.');
  }
  const pdf = doc.asPDF();
  if (!pdf) throw new UserFacingError('This file is not a PDF.');
  if (pdf.countPages() > LIMITS.maxPages) {
    throw new UserFacingError(`This PDF has more than ${LIMITS.maxPages} pages. Split it and try again.`);
  }
  // Comments, sticky notes and filled-in form fields become ordinary page
  // content, so the same detection and redaction applies to them.
  pdf.bake(true, true);
  return pdf;
}

export function pdfPageCount(buf: Uint8Array): number {
  return open(buf).countPages();
}

function textLayer(page: mupdf.Page): { text: string; boxes: (Rect | null)[] } {
  let text = '';
  const boxes: (Rect | null)[] = [];
  page.toStructuredText('preserve-whitespace').walk({
    onChar(c, _origin, _font, _size, q) {
      const xs = [q[0], q[2], q[4], q[6]];
      const ys = [q[1], q[3], q[5], q[7]];
      text += c;
      const box: Rect = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
      for (let i = 0; i < c.length; i++) boxes.push(box);
    },
    endLine() {
      text += '\n';
      boxes.push(null);
    },
    endTextBlock() {
      text += '\n';
      boxes.push(null);
    },
  });
  return { text, boxes };
}

/**
 * A page needs OCR when it has (almost) no text layer, i.e. a scan, or when
 * its text layer is unreadable (fonts with no character map come out as
 * U+FFFD). In both cases what people see is not what a machine reads, so we
 * read what people see.
 */
function needsOcr(text: string): boolean {
  const visible = text.replace(/\s/g, '');
  if (visible.length < 25) return true;
  const broken = (visible.match(/\u{FFFD}/gu) ?? []).length;
  return broken / visible.length > 0.1;
}

async function readPage(page: mupdf.Page, index: number, forceOcr?: boolean): Promise<PageText> {
  const layer = textLayer(page);
  const ocr = forceOcr ?? needsOcr(layer.text);
  if (!ocr) return { page: index + 1, ...layer, ocr: false };
  const pix = page.toPixmap(
    mupdf.Matrix.scale(OCR_SCALE, OCR_SCALE),
    mupdf.ColorSpace.DeviceGray,
    false,
    true,
  );
  const result = await ocrImage(pix.asPNG(), OCR_SCALE);
  return { page: index + 1, ...result, ocr: true };
}

export async function readPdf(
  buf: Uint8Array,
  onPage?: (done: number, total: number) => void,
): Promise<PageText[]> {
  const pdf = open(buf);
  const total = pdf.countPages();
  const pages: PageText[] = [];
  for (let i = 0; i < total; i++) {
    pages.push(await readPage(pdf.loadPage(i), i));
    onPage?.(i + 1, total);
  }
  return pages;
}

const ROOT_KEYS_TO_DROP = [
  'Metadata', // XMP: author, title, editing history
  'Outlines', // bookmarks, often "Margaret Jones – assessment"
  'Names', // embedded files, JavaScript, named destinations
  'AcroForm', // form field values survive baking in the field tree
  'OpenAction',
  'AA',
  'StructTreeRoot', // tagged-PDF alt text and ActualText
  'MarkInfo',
  'PieceInfo',
  'SpiderInfo',
  'Threads',
  'URI',
  'Collection',
  'Perms',
  'Legal',
];

const PAGE_KEYS_TO_DROP = ['Thumb', 'PieceInfo', 'Metadata', 'AA', 'Annots'];

function stripHiddenData(pdf: mupdf.PDFDocument): void {
  const trailer = pdf.getTrailer();
  trailer.delete('Info');
  const root = trailer.get('Root');
  for (const key of ROOT_KEYS_TO_DROP) root.delete(key);
  for (let i = 0; i < pdf.countPages(); i++) {
    const obj = pdf.loadPage(i).getObject();
    for (const key of PAGE_KEYS_TO_DROP) obj.delete(key);
  }
}

export interface PdfRedaction {
  output: Uint8Array;
  removed: number;
  ocrPages: Set<number>;
}

export async function redactPdf(
  buf: Uint8Array,
  terms: Term[],
  onPage?: (done: number, total: number) => void,
): Promise<PdfRedaction> {
  const pdf = open(buf);
  const total = pdf.countPages();
  const ocrPages = new Set<number>();
  let removed = 0;

  for (let i = 0; i < total; i++) {
    const page = pdf.loadPage(i);
    const text = await readPage(page, i);
    if (text.ocr) ocrPages.add(i + 1);
    const spans = findAll(text.text, terms);
    removed += spans.length;
    for (const span of spans) {
      for (const rect of spanRects(text.boxes, span)) {
        page.createAnnotation('Redact').setRect(rect);
      }
    }
    if (spans.length) {
      page.applyRedactions(
        true,
        mupdf.PDFPage.REDACT_IMAGE_PIXELS,
        mupdf.PDFPage.REDACT_LINE_ART_NONE,
        mupdf.PDFPage.REDACT_TEXT_REMOVE,
      );
    }
    onPage?.(i + 1, total);
  }

  stripHiddenData(pdf);
  // A full rewrite with garbage collection: unreferenced objects (the removed
  // text, earlier revisions from incremental saves) are not carried over.
  const output = pdf.saveToBuffer('garbage=deduplicate,compress').asUint8Array();
  return { output: new Uint8Array(output), removed, ocrPages };
}

/**
 * Re-read the finished file exactly as a machine would (OCR for the pages
 * that needed it) and list any approved term that is still there.
 */
export async function leftoversPdf(
  output: Uint8Array,
  terms: Term[],
  ocrPages: Set<number>,
): Promise<string[]> {
  const doc = mupdf.Document.openDocument(output, 'application/pdf');
  const pdf = doc.asPDF();
  if (!pdf) return ['(output is not a PDF)'];
  const left = new Set<string>();
  for (let i = 0; i < pdf.countPages(); i++) {
    const page = await readPage(pdf.loadPage(i), i, ocrPages.has(i + 1) || undefined);
    for (const t of terms) {
      if (findAll(page.text, [t]).length) left.add(t.text);
    }
  }
  const trailer = pdf.getTrailer();
  if (!trailer.get('Info').isNull()) left.add('(document properties)');
  const root = trailer.get('Root');
  for (const key of ['Metadata', 'Outlines', 'AcroForm']) {
    if (!root.get(key).isNull()) left.add(`(${key})`);
  }
  return [...left];
}
