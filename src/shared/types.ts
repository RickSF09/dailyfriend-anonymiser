// Shapes that cross the API boundary. The browser and the server both import
// this file, so it must stay free of Node- and DOM-specific types.

export const ENTITY_TYPES = [
  'PERSON',
  'ADDRESS',
  'PLACE',
  'ORGANISATION',
  'PHONE',
  'EMAIL',
  'ID',
  'DATE_OF_BIRTH',
  'OTHER',
] as const;

export type EntityType = (typeof ENTITY_TYPES)[number];

export type DocKind = 'pdf' | 'docx' | 'image';

/**
 * One thing to remove, e.g. a person. `texts` holds every way it is written in
 * the document ("Margaret Jones", "Mrs Jones", "Maggie"), and all of them get
 * the same label, so an AI reading the result can still follow who is who.
 */
export interface Finding {
  label: string;
  type: EntityType;
  texts: string[];
  /** How many places in the document this appears. */
  count: number;
  /** 1-based page numbers (PDFs and images only). */
  pages: number[];
}

export interface DocMeta {
  kind: DocKind;
  pages: number;
  /** Pages that had no text layer and were read with OCR. */
  ocrPages: number;
  /** Things the tool does not check in this document, shown to the user. */
  notices: string[];
}

/** A text the user approved for removal, and what replaces it in Word files. */
export interface Term {
  text: string;
  label: string;
}

export type Stage = 'reading' | 'detecting' | 'applying' | 'checking';

/** Each line of the NDJSON stream the API sends back. */
export type StreamEvent =
  | { type: 'progress'; stage: Stage; done?: number; total?: number }
  | { type: 'queued'; position: number }
  | { type: 'findings'; findings: Finding[]; meta: DocMeta }
  | { type: 'file'; name: string; mime: string; base64: string; removed: number }
  | { type: 'error'; message: string };

export const LIMITS = {
  maxBytes: 20 * 1024 * 1024,
  maxPages: 50,
  maxTerms: 500,
  maxTermLength: 200,
} as const;
