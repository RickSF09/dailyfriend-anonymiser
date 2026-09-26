// Images (a photo or scan of a letter or form): OCR, then paint over matches.
//
// The painted pixels replace the originals in a newly encoded file, so there
// is nothing underneath to recover. Re-encoding also drops EXIF data (camera,
// time, GPS location).

import sharp from 'sharp';
import type { Term } from '../../shared/types.js';
import { findAll } from '../detect/match.js';
import { UserFacingError } from './errors.js';
import { spanRects } from './geometry.js';
import { ocrImage, type OcrText } from './ocr.js';

const MAX_PIXELS = 40_000_000;

export type ImageFormat = 'png' | 'jpeg' | 'webp';

async function normalise(buf: Uint8Array): Promise<{ png: Buffer; width: number; height: number }> {
  try {
    // rotate() with no angle applies the EXIF orientation, so a phone photo
    // is OCR'd and painted the way up it is shown.
    const { data, info } = await sharp(buf, { limitInputPixels: MAX_PIXELS })
      .rotate()
      .png()
      .toBuffer({ resolveWithObject: true });
    return { png: data, width: info.width, height: info.height };
  } catch {
    throw new UserFacingError('This image could not be opened. Try a PNG or JPG.');
  }
}

export async function readImage(buf: Uint8Array): Promise<OcrText> {
  const { png } = await normalise(buf);
  return ocrImage(png);
}

export async function redactImage(
  buf: Uint8Array,
  terms: Term[],
  format: ImageFormat,
): Promise<{ output: Uint8Array; removed: number }> {
  const { png, width, height } = await normalise(buf);
  const text = await ocrImage(png);
  const spans = findAll(text.text, terms);
  const rects = spans.flatMap((s) => spanRects(text.boxes, s, 2, 2));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${rects
    .map(([x0, y0, x1, y1]) => {
      const x = Math.max(0, Math.floor(x0));
      const y = Math.max(0, Math.floor(y0));
      return `<rect x="${x}" y="${y}" width="${Math.ceil(x1) - x}" height="${Math.ceil(y1) - y}" fill="#000"/>`;
    })
    .join('')}</svg>`;

  let img = sharp(png).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]);
  img =
    format === 'jpeg' ? img.jpeg({ quality: 92 }) : format === 'webp' ? img.webp({ quality: 92 }) : img.png();
  const output = await img.toBuffer();
  return { output: new Uint8Array(output), removed: spans.length };
}

export async function leftoversImage(output: Uint8Array, terms: Term[]): Promise<string[]> {
  const text = await readImage(output);
  return terms.filter((t) => findAll(text.text, [t]).length > 0).map((t) => t.text);
}
