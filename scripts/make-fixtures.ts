// Builds the eval documents in eval/fixtures/ from eval/fixtures.ts.
//   npm run fixtures
//
// PDFs are laid out from HTML by MuPDF; "scans" are those pages rasterised
// and rebuilt as image-only PDFs; "photos" are a rendered page, slightly
// rotated, blurred and saved as a JPEG with EXIF data (to prove it is
// stripped); Word files are built with the docx library, including runs split
// mid-name, a comment, a tracked deletion, a header and a footer.

import fs from 'node:fs';
import path from 'node:path';
import {
  CommentRangeEnd,
  CommentRangeStart,
  CommentReference,
  DeletedTextRun,
  Document,
  Footer,
  Header,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import * as mupdf from 'mupdf';
import sharp from 'sharp';
import { type Block, FIXTURES, type Fixture } from '../eval/fixtures.js';

const OUT = path.resolve(import.meta.dirname, '../eval/fixtures');
fs.mkdirSync(OUT, { recursive: true });

const plain = (s: string) => s.replace(/\|/g, '').replace(/~~/g, '');
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function html(blocks: Block[]): string {
  const body = blocks
    .map((b) => {
      if ('h' in b) return `<h2>${esc(plain(b.h))}</h2>`;
      if ('p' in b) return `<p>${esc(plain(b.p))}</p>`;
      return `<table border="1" cellpadding="4" cellspacing="0">${b.table
        .map((row) => `<tr>${row.map((c) => `<td>${esc(plain(c))}</td>`).join('')}</tr>`)
        .join('')}</table>`;
    })
    .join('\n');
  return `<html><body style="font-family:sans-serif;font-size:11pt;line-height:1.35">${body}</body></html>`;
}

function htmlToPdf(markup: string): mupdf.PDFDocument {
  const doc = mupdf.Document.openDocument(Buffer.from(markup), 'text/html');
  doc.layout(595, 842, 11);
  const buf = new mupdf.Buffer();
  const writer = new mupdf.DocumentWriter(buf, 'pdf', '');
  for (let i = 0; i < doc.countPages(); i++) {
    const page = doc.loadPage(i);
    const dev = writer.beginPage(page.getBounds());
    page.run(dev, mupdf.Matrix.identity);
    writer.endPage();
  }
  writer.close();
  return mupdf.Document.openDocument(buf.asUint8Array(), 'application/pdf').asPDF()!;
}

function typedPdf(f: Fixture): Uint8Array {
  const pdf = htmlToPdf(html(f.blocks));
  if (f.author) pdf.setMetaData('info:Author', f.author);
  pdf.setMetaData('info:Title', plain(f.fileName));
  return pdf.saveToBuffer('compress').asUint8Array();
}

function scannedPdf(f: Fixture): Uint8Array {
  const src = htmlToPdf(html(f.blocks));
  const out = new mupdf.PDFDocument();
  const scale = 150 / 72;
  for (let i = 0; i < src.countPages(); i++) {
    const page = src.loadPage(i);
    const [x0, y0, x1, y1] = page.getBounds();
    const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceGray, false);
    const img = out.addImage(new mupdf.Image(pix));
    const w = x1 - x0;
    const h = y1 - y0;
    const res = out.addObject({ XObject: { Im0: img } });
    const pageObj = out.addPage([0, 0, w, h], 0, res, `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`);
    out.insertPage(-1, pageObj);
  }
  return out.saveToBuffer('compress').asUint8Array();
}

async function photo(f: Fixture): Promise<Uint8Array> {
  const pdf = htmlToPdf(html(f.blocks));
  const png = pdf.loadPage(0).toPixmap(mupdf.Matrix.scale(2, 2), mupdf.ColorSpace.DeviceRGB, false).asPNG();
  const out = await sharp(png)
    .extract({ left: 0, top: 0, width: 1190, height: 900 })
    .rotate(1.2, { background: '#f4f1ea' })
    .blur(0.5)
    .modulate({ brightness: 0.96 })
    .jpeg({ quality: 75 })
    .withExif({ IFD0: { Artist: 'Leanne Price', ImageDescription: 'Beryl Thomas assessment' } })
    .toBuffer();
  return new Uint8Array(out);
}

function runs(text: string): (TextRun | DeletedTextRun)[] {
  // "~~deleted~~" becomes a tracked deletion; "|" splits runs.
  return text.split(/(~~[^~]+~~)/).flatMap((piece, i) => {
    if (piece.startsWith('~~')) {
      return [
        new DeletedTextRun({
          text: piece.slice(2, -2),
          id: 100 + i,
          author: 'Owain Lloyd',
          date: '2026-09-20T10:00:00Z',
        }),
      ];
    }
    return piece
      .split('|')
      .filter(Boolean)
      .map((t) => new TextRun(t));
  });
}

async function docx(f: Fixture): Promise<Uint8Array> {
  const comments: { id: number; author: string; date: Date; children: Paragraph[] }[] = [];
  const children = f.blocks.map((b) => {
    if ('h' in b) return new Paragraph({ text: plain(b.h), heading: HeadingLevel.HEADING_1 });
    if ('p' in b) {
      if (b.comment) {
        const id = comments.length;
        comments.push({
          id,
          author: b.comment.author,
          date: new Date('2026-09-20'),
          children: [new Paragraph(b.comment.text)],
        });
        return new Paragraph({
          children: [
            new CommentRangeStart(id),
            ...runs(b.p),
            new CommentRangeEnd(id),
            new TextRun({ children: [new CommentReference(id)] }),
          ],
        });
      }
      return new Paragraph({ children: runs(b.p) });
    }
    return new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: b.table.map(
        (row) =>
          new TableRow({
            children: row.map((c) => new TableCell({ children: [new Paragraph({ children: runs(c) })] })),
          }),
      ),
    });
  });
  const doc = new Document({
    creator: f.author ?? 'Unknown',
    lastModifiedBy: f.author ?? 'Unknown',
    title: plain(f.fileName),
    comments: { children: comments },
    sections: [
      {
        headers: f.header ? { default: new Header({ children: [new Paragraph(f.header)] }) } : undefined,
        footers: f.footer ? { default: new Footer({ children: [new Paragraph(f.footer)] }) } : undefined,
        children,
      },
    ],
  });
  return new Uint8Array(await Packer.toBuffer(doc));
}

for (const f of FIXTURES) {
  const bytes =
    f.format === 'pdf'
      ? typedPdf(f)
      : f.format === 'scan'
        ? scannedPdf(f)
        : f.format === 'photo'
          ? await photo(f)
          : await docx(f);
  fs.writeFileSync(path.join(OUT, f.fileName), bytes);
  console.log(`${f.fileName}  ${(bytes.length / 1024).toFixed(0)} KB`);
}
