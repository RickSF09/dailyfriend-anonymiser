// Word (.docx): replace personal details in place, keeping all formatting.
//
// A .docx is a zip of XML parts. Word splits text into "runs" wherever
// formatting, spell-check state or editing history changes, so a single name
// is often spread over several <w:t> elements ("Marg" + "aret Jones"). Each
// paragraph is therefore read as one string with a map back to the elements,
// matched as a whole, and edited element by element: the label goes into the
// first element (keeping its formatting) and the rest of the name is removed
// from the following ones.

import JSZip from 'jszip';
import { DOMParser, XMLSerializer, type Document, type Element, type Node } from '@xmldom/xmldom';
import type { Term } from '../../shared/types.js';
import { findAll } from '../detect/match.js';
import { UserFacingError } from './errors.js';

const NS = {
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  m: 'http://schemas.openxmlformats.org/officeDocument/2006/math',
  c: 'http://schemas.openxmlformats.org/drawingml/2006/chart',
};

const MAX_UNCOMPRESSED = 100 * 1024 * 1024;
const MAX_ENTRIES = 3000;

/** Elements whose text content is document text. */
function isTextElement(el: Element): boolean {
  const ns = el.namespaceURI;
  const n = el.localName;
  if (ns === NS.w) return n === 't' || n === 'delText' || n === 'instrText';
  if (ns === NS.a || ns === NS.m) return n === 't';
  if (ns === NS.c) return n === 'v';
  return false;
}

function isParagraph(el: Element): boolean {
  return el.localName === 'p' && (el.namespaceURI === NS.w || el.namespaceURI === NS.a);
}

interface Segment {
  el: Element;
  start: number;
  end: number;
}

/** A piece of text in the file and where each part of it lives. */
interface TextRun {
  text: string;
  segments: Segment[];
}

/** Attributes that can carry free text: image alt text and titles. */
const TEXT_ATTRIBUTES = ['descr', 'title'];
/** Attributes that name the people who edited or commented. */
const AUTHOR_ATTRIBUTES: Record<string, string> = {
  author: 'Author',
  initials: 'A',
  userId: '',
  providerId: '',
};

interface Part {
  name: string;
  doc: Document;
  declaration: string;
  paragraphs: TextRun[];
  /** Text elements outside any paragraph (chart values, custom XML). */
  loose: TextRun[];
  attributes: { el: Element; name: string }[];
}

function elementChildren(node: Node): Element[] {
  const out: Element[] = [];
  for (let c = node.firstChild; c; c = c.nextSibling) if (c.nodeType === 1) out.push(c as Element);
  return out;
}

function readParagraph(p: Element): TextRun {
  let text = '';
  const segments: Segment[] = [];
  const walk = (node: Element) => {
    for (const el of elementChildren(node)) {
      if (isParagraph(el)) continue; // a text box inside this paragraph; read on its own
      if (isTextElement(el)) {
        const t = el.textContent ?? '';
        segments.push({ el, start: text.length, end: text.length + t.length });
        text += t;
      } else if (el.namespaceURI === NS.w && el.localName === 'tab') {
        text += '\t';
      } else if (el.namespaceURI === NS.w && (el.localName === 'br' || el.localName === 'cr')) {
        text += '\n';
      } else {
        walk(el);
      }
    }
  };
  walk(p);
  return { text, segments };
}

function hasParagraphAncestor(el: Element): boolean {
  for (let n = el.parentNode; n && n.nodeType === 1; n = n.parentNode) {
    if (isParagraph(n as Element)) return true;
  }
  return false;
}

function allElements(doc: Document): Element[] {
  return Array.from(doc.getElementsByTagName('*')) as Element[];
}

function parsePart(name: string, xml: string): Part {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const declaration = /^\s*<\?xml[^>]*\?>/.exec(xml)?.[0] ?? '';
  const part: Part = { name, doc, declaration, paragraphs: [], loose: [], attributes: [] };
  // Parts with no Word structure: every leaf element's text is document text.
  const genericText = name.startsWith('customXml/') || name.startsWith('docProps/');

  for (const el of allElements(doc)) {
    // Nested paragraphs (text boxes) are visited by this loop too, and each
    // one is read with only its own text.
    if (isParagraph(el)) part.paragraphs.push(readParagraph(el));
    else if (isTextElement(el) && !hasParagraphAncestor(el)) {
      const t = el.textContent ?? '';
      part.loose.push({ text: t, segments: [{ el, start: 0, end: t.length }] });
    } else if (genericText && elementChildren(el).length === 0 && el.textContent) {
      const t = el.textContent;
      part.loose.push({ text: t, segments: [{ el, start: 0, end: t.length }] });
    }
    for (const attr of TEXT_ATTRIBUTES) {
      if (el.hasAttribute(attr) && /docPr|cNvPr/.test(el.localName ?? ''))
        part.attributes.push({ el, name: attr });
    }
  }
  return part;
}

function isTextPart(name: string): boolean {
  if (!name.endsWith('.xml')) return false;
  if (name.startsWith('word/') || name.startsWith('customXml/'))
    return !name.startsWith('customXml/itemProps');
  return name === 'docProps/core.xml' || name === 'docProps/custom.xml' || name === 'docProps/app.xml';
}

export interface DocxFile {
  zip: JSZip;
  parts: Part[];
  rels: { name: string; xml: string }[];
  notices: string[];
}

export async function openDocx(buf: Uint8Array): Promise<DocxFile> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buf);
  } catch {
    throw new UserFacingError('This Word file could not be opened. It may be damaged.');
  }
  const entries = Object.values(zip.files);
  if (entries.length > MAX_ENTRIES) throw new UserFacingError('This Word file is too complex to process.');
  // JSZip exposes sizes only on its internal record; this guards against a
  // small upload that expands to gigabytes (a "zip bomb").
  const total = entries.reduce(
    (sum, f) =>
      sum + ((f as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0),
    0,
  );
  if (total > MAX_UNCOMPRESSED) throw new UserFacingError('This Word file is too large once unpacked.');

  const types = await zip.file('[Content_Types].xml')?.async('string');
  if (!types?.includes('wordprocessingml.document.main+xml')) {
    throw new UserFacingError('This is not a Word .docx file. Save it as .docx and try again.');
  }

  const parts: Part[] = [];
  const rels: { name: string; xml: string }[] = [];
  for (const f of entries) {
    if (f.dir) continue;
    if (isTextPart(f.name)) parts.push(parsePart(f.name, await f.async('string')));
    else if (f.name.endsWith('.rels')) rels.push({ name: f.name, xml: await f.async('string') });
  }

  const notices: string[] = [];
  if (entries.some((f) => /^word\/media\//.test(f.name))) {
    notices.push(
      'Pictures inside this Word file were not checked. Remove any photos, signatures or scanned pages yourself.',
    );
  }
  if (entries.some((f) => /^word\/embeddings\//.test(f.name))) {
    notices.push('Files embedded in this Word document (such as spreadsheets) were not checked.');
  }
  return { zip, parts, rels, notices };
}

/** Every piece of text in the file, for detection. */
export function docxTexts(file: DocxFile): string[] {
  const out: string[] = [];
  for (const p of file.parts) {
    for (const r of p.paragraphs) if (r.text.trim()) out.push(r.text);
    for (const r of p.loose) if (r.text.trim()) out.push(r.text);
    for (const a of p.attributes) {
      const v = a.el.getAttribute(a.name);
      if (v?.trim()) out.push(v);
    }
  }
  return out;
}

function setText(el: Element, text: string): void {
  while (el.firstChild) el.removeChild(el.firstChild);
  el.appendChild(el.ownerDocument!.createTextNode(text));
  if (el.namespaceURI === NS.w) el.setAttribute('xml:space', 'preserve');
}

function replaceInRun(run: TextRun, terms: Term[]): number {
  const spans = findAll(run.text, terms);
  // Back to front, so earlier offsets stay valid while later text changes.
  for (const span of [...spans].reverse()) {
    let first = true;
    for (const seg of run.segments) {
      if (seg.end <= span.start || seg.start >= span.end) continue;
      const cur = seg.el.textContent ?? '';
      const ls = Math.max(span.start, seg.start) - seg.start;
      const le = Math.min(span.end, seg.end) - seg.start;
      setText(seg.el, cur.slice(0, ls) + (first ? span.label : '') + cur.slice(le));
      first = false;
    }
  }
  return spans.length;
}

function replaceInString(value: string, terms: Term[]): { value: string; count: number } {
  const spans = findAll(value, terms);
  let out = value;
  for (const s of [...spans].reverse()) out = out.slice(0, s.start) + s.label + out.slice(s.end);
  return { value: out, count: spans.length };
}

function scrubAuthors(part: Part): void {
  for (const el of allElements(part.doc)) {
    for (const [attr, value] of Object.entries(AUTHOR_ATTRIBUTES)) {
      for (const a of Array.from(el.attributes)) {
        if (a.localName === attr) el.setAttribute(a.name, value);
      }
    }
    // Who created and last saved the file, and the company it came from.
    const n = el.localName;
    if (
      (part.name === 'docProps/core.xml' && (n === 'creator' || n === 'lastModifiedBy')) ||
      (part.name === 'docProps/app.xml' && (n === 'Company' || n === 'Manager'))
    ) {
      setText(el, '');
      el.removeAttribute('xml:space');
    }
  }
}

export async function redactDocx(
  buf: Uint8Array,
  terms: Term[],
): Promise<{ output: Uint8Array; removed: number }> {
  const file = await openDocx(buf);
  let removed = 0;
  const serializer = new XMLSerializer();

  for (const part of file.parts) {
    for (const run of part.paragraphs) removed += replaceInRun(run, terms);
    for (const run of part.loose) removed += replaceInRun(run, terms);
    for (const a of part.attributes) {
      const r = replaceInString(a.el.getAttribute(a.name) ?? '', terms);
      if (r.count) a.el.setAttribute(a.name, r.value);
      removed += r.count;
    }
    scrubAuthors(part);
    let xml = serializer.serializeToString(part.doc);
    if (part.declaration && !xml.startsWith('<?xml')) xml = `${part.declaration}\n${xml}`;
    file.zip.file(part.name, xml);
  }

  // Hyperlink targets live in relationship files: "mailto:margaret@..."
  for (const rel of file.rels) {
    const doc = new DOMParser().parseFromString(rel.xml, 'application/xml');
    let changed = false;
    for (const el of allElements(doc)) {
      const target = el.getAttribute('Target');
      if (target && el.getAttribute('TargetMode') === 'External') {
        const r = replaceInString(decodeURIComponentSafe(target), terms);
        if (r.count) {
          el.setAttribute('Target', r.value.startsWith('mailto:') ? 'mailto:' : r.value);
          changed = true;
        }
      }
    }
    if (changed) file.zip.file(rel.name, serializer.serializeToString(doc));
  }

  const output = await file.zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  return { output, removed };
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Approved terms still present anywhere in the finished file. */
export async function leftoversDocx(output: Uint8Array, terms: Term[]): Promise<string[]> {
  const file = await openDocx(output);
  const texts = docxTexts(file);
  for (const rel of file.rels) texts.push(decodeURIComponentSafe(rel.xml));
  const left = new Set<string>();
  for (const t of terms) {
    if (texts.some((s) => findAll(s, [t]).length > 0)) left.add(t.text);
  }
  return [...left];
}
