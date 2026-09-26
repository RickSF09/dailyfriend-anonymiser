// End-to-end quality check on the synthetic documents in eval/fixtures.
//
//   npm run eval                          default model, recall pass on
//   npm run eval -- --model=mistral-medium-latest
//   npm run eval -- --no-recall --only=care-plan
//
// Each document goes through the real pipeline (detect → approve everything
// → anonymise), then the OUTPUT is read back the way a machine would read it
// (text layer, or OCR for scans and photos) and scored:
//   leaked  = an identifying string from `remove` still readable in the output
//   lost    = a care detail from `keep` no longer readable (over-removal)
// The launch gate is ≥98% of names, addresses and ID numbers removed.

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import type { EntityType } from '../src/shared/types.js';
import { findOccurrences, normalise } from '../src/server/detect/match.js';
import { docxTexts, openDocx } from '../src/server/formats/docx.js';
import { readImage } from '../src/server/formats/image.js';
import { shutdownOcr } from '../src/server/formats/ocr.js';
import { readPdf } from '../src/server/formats/pdf.js';
import { tokenUsage } from '../src/server/mistral.js';
import { analyse, anonymise } from '../src/server/pipeline.js';
import { FIXTURES, type Fixture } from './fixtures.js';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? 'true'];
  }),
);
const model = args.model ?? process.env.MISTRAL_MODEL ?? 'mistral-medium-latest';
const recallPass = args['no-recall'] !== 'true';
const only = args.only?.split(',');

// USD per million tokens (input, output), for a rough cost figure only.
const PRICES: Record<string, [number, number]> = {
  'mistral-small-latest': [0.1, 0.3],
  'mistral-medium-latest': [0.4, 2.0],
  'mistral-large-latest': [0.5, 1.5],
};

const DIR = path.resolve(import.meta.dirname, 'fixtures');
const OUT = path.resolve(import.meta.dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });

// Words that appear inside identifying strings but identify nobody alone.
const GENERIC = new Set(
  'street road place terrace close lane avenue high the and of care home hospital ward medical practice surgery residential inn flat room church school dr mr mrs ms nurse university sant y st'.split(
    ' ',
  ),
);

/** Is any identifying part of `s` still readable in `text`? */
export function leaked(text: string, s: string): boolean {
  const digits = s.replace(/\D/g, '');
  if (digits.length >= 6) return findOccurrences(text, s).length > 0;
  const tokens = s.split(/[^\p{L}\p{N}]+/u).filter((t) => t && !GENERIC.has(t.toLowerCase()));
  const meaningful = tokens.length > 1 ? tokens.filter((t) => t.length >= 3) : tokens;
  if (!meaningful.length) return findOccurrences(text, s).length > 0;
  return meaningful.some((t) => findOccurrences(text, t).length > 0);
}

function kept(text: string, s: string): boolean {
  return normalise(text).includes(normalise(s));
}

async function outputText(f: Fixture, output: Uint8Array): Promise<string> {
  if (f.format === 'docx') {
    const file = await openDocx(output);
    return docxTexts(file).join('\n');
  }
  if (f.format === 'photo') {
    const meta = await sharp(output).metadata();
    if (meta.exif) console.log('    ! EXIF data survived');
    return (await readImage(output)).text;
  }
  return (await readPdf(output)).map((p) => p.text).join('\n');
}

interface Row {
  id: string;
  found: number;
  leaks: string[];
  lost: string[];
  ms: number;
}

const perType = new Map<EntityType, { total: number; leaked: number }>();
const rows: Row[] = [];

for (const f of FIXTURES) {
  if (only && !only.includes(f.id)) continue;
  const buf = new Uint8Array(fs.readFileSync(path.join(DIR, f.fileName)));
  const t0 = Date.now();
  const { findings } = await analyse(buf, {
    filename: f.fileName,
    progress: () => {},
    chargePages: () => {},
    model,
    recallPass,
  });
  const terms = findings.flatMap((g) => g.texts.map((text) => ({ text, label: g.label })));
  const result = await anonymise(buf, terms, f.fileName, () => {});
  fs.writeFileSync(path.join(OUT, result.name), result.output);
  const text = await outputText(f, result.output);

  const leaks: string[] = [];
  for (const [s, type] of f.remove) {
    const stat = perType.get(type) ?? { total: 0, leaked: 0 };
    stat.total++;
    if (leaked(text, s)) {
      stat.leaked++;
      leaks.push(s);
    }
    perType.set(type, stat);
  }
  const lost = f.keep.filter((s) => !kept(text, s));
  if (leaked(result.name, f.remove[0]?.[0] ?? '\u0000')) leaks.push(`(file name: ${result.name})`);
  rows.push({ id: f.id, found: findings.length, leaks, lost, ms: Date.now() - t0 });

  console.log(
    `${f.id.padEnd(20)} ${String(findings.length).padStart(3)} groups  ${((Date.now() - t0) / 1000).toFixed(1)}s`,
  );
  for (const l of leaks) console.log(`    LEAKED  ${l}`);
  for (const l of lost) console.log(`    LOST    ${l}`);
  if (args.verbose) for (const g of findings) console.log(`    ${g.label} ${JSON.stringify(g.texts)}`);
}
await shutdownOcr();

const total = [...perType.values()].reduce(
  (a, b) => ({ total: a.total + b.total, leaked: a.leaked + b.leaked }),
  {
    total: 0,
    leaked: 0,
  },
);
const keepTotal = FIXTURES.filter((f) => !only || only.includes(f.id)).reduce((n, f) => n + f.keep.length, 0);
const lostTotal = rows.reduce((n, r) => n + r.lost.length, 0);
const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : 'n/a');

console.log(`\nModel ${model}, recall pass ${recallPass ? 'on' : 'off'}`);
console.log('Removed, by type:');
for (const [type, s] of [...perType.entries()].sort()) {
  console.log(
    `  ${type.padEnd(14)} ${pct(s.total - s.leaked, s.total).padStart(6)}  (${s.total - s.leaked}/${s.total})`,
  );
}
console.log(
  `  ${'ALL'.padEnd(14)} ${pct(total.total - total.leaked, total.total).padStart(6)}  (${total.total - total.leaked}/${total.total})`,
);
console.log(
  `Care details kept: ${pct(keepTotal - lostTotal, keepTotal)} (${keepTotal - lostTotal}/${keepTotal})`,
);

const gateTypes: EntityType[] = ['PERSON', 'ADDRESS', 'ID'];
const gate = gateTypes.reduce(
  (acc, t) => {
    const s = perType.get(t);
    return s ? { total: acc.total + s.total, leaked: acc.leaked + s.leaked } : acc;
  },
  { total: 0, leaked: 0 },
);
const gateRate = gate.total ? (gate.total - gate.leaked) / gate.total : 1;
const [pin, pout] = PRICES[model] ?? [0, 0];
const usd = (tokenUsage.prompt * pin + tokenUsage.completion * pout) / 1e6;
console.log(
  `Tokens: ${tokenUsage.prompt} in, ${tokenUsage.completion} out, ${tokenUsage.calls} calls; ~$${usd.toFixed(4)} for ${rows.length} documents`,
);
console.log(
  `Gate (names, addresses, IDs ≥ 98%): ${(gateRate * 100).toFixed(1)}% → ${gateRate >= 0.98 ? 'PASS' : 'FAIL'}`,
);
process.exitCode = gateRate >= 0.98 ? 0 : 1;
