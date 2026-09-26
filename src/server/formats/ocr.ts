// Local OCR (Tesseract, Apache-2.0) for scanned pages and photos.
//
// Runs inside this process with the English model shipped in the image: no
// network call, no cost. It is used instead of Mistral OCR because redaction
// needs the position of every word, and Mistral OCR only returns positions per
// paragraph.

import { createRequire } from 'node:module';
import path from 'node:path';
import { createWorker, type Worker } from 'tesseract.js';
import type { Rect } from './geometry.js';

const require = createRequire(import.meta.url);
const LANG_PATH = path.join(
  path.dirname(require.resolve('@tesseract.js-data/eng/package.json')),
  '4.0.0_best_int',
);

export interface OcrText {
  text: string;
  /** One entry per character of `text`: the box of the word it belongs to. */
  boxes: (Rect | null)[];
}

let workerPromise: Promise<Worker> | null = null;
let queue: Promise<unknown> = Promise.resolve();

function getWorker(): Promise<Worker> {
  workerPromise ??= createWorker('eng', 1, { langPath: LANG_PATH, cacheMethod: 'none', gzip: true });
  return workerPromise;
}

/**
 * OCR one image. `scale` converts image pixels back to the caller's
 * coordinates (e.g. PDF points). Calls are serialised: one Tesseract worker
 * keeps memory bounded on a small machine.
 */
export function ocrImage(png: Buffer | Uint8Array, scale = 1): Promise<OcrText> {
  const run = queue.then(async () => {
    const worker = await getWorker();
    const { data } = await worker.recognize(Buffer.from(png), {}, { blocks: true, text: false });
    let text = '';
    const boxes: (Rect | null)[] = [];
    const push = (s: string, box: Rect | null) => {
      text += s;
      for (let i = 0; i < s.length; i++) boxes.push(box);
    };
    for (const block of data.blocks ?? []) {
      for (const para of block.paragraphs) {
        for (const line of para.lines) {
          line.words.forEach((w, i) => {
            if (i > 0) push(' ', null);
            const b = w.bbox;
            push(w.text, [b.x0 / scale, b.y0 / scale, b.x1 / scale, b.y1 / scale]);
          });
          push('\n', null);
        }
        push('\n', null);
      }
    }
    return { text, boxes };
  });
  queue = run.catch(() => undefined);
  return run;
}

export async function shutdownOcr(): Promise<void> {
  if (workerPromise) await (await workerPromise).terminate();
  workerPromise = null;
}
