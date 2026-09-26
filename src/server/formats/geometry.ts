import type { Span } from '../detect/match.js';

/** [x0, y0, x1, y1], top-left origin. */
export type Rect = [number, number, number, number];

/**
 * The boxes covering a span of text, one per line. Characters are grouped
 * into a line while they sit at the same height and keep moving right; a
 * wrapped name therefore becomes two boxes instead of one tall box that
 * would black out the text between.
 */
export function spanRects(boxes: (Rect | null)[], span: Span, padX = 0, padY = 0.5): Rect[] {
  const rects: Rect[] = [];
  let cur: Rect | null = null;
  for (let i = span.start; i < span.end; i++) {
    const b = boxes[i];
    if (!b) continue;
    if (cur) {
      const curMid = (cur[1] + cur[3]) / 2;
      const bMid = (b[1] + b[3]) / 2;
      const height = Math.max(cur[3] - cur[1], b[3] - b[1], 1);
      const sameLine = Math.abs(curMid - bMid) < height * 0.5 && b[0] >= cur[0] - height;
      if (sameLine) {
        cur = [
          Math.min(cur[0], b[0]),
          Math.min(cur[1], b[1]),
          Math.max(cur[2], b[2]),
          Math.max(cur[3], b[3]),
        ];
        continue;
      }
      rects.push(cur);
    }
    cur = [...b];
  }
  if (cur) rects.push(cur);
  return rects.map(([x0, y0, x1, y1]) => [x0 - padX, y0 - padY, x1 + padX, y1 + padY]);
}
