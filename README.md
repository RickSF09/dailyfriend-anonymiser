# Document anonymiser

A free tool from DailyFriend for UK care providers. Upload a PDF, Word document or photo of a document;
it finds names, addresses, phone numbers, NHS numbers and other identifying details; you check the
list; you get **the same file back**, in the same format and layout, with those details removed.

- **PDFs and images:** black boxes, with the text underneath deleted. Covering alone is not enough:
  an AI tool reads a PDF's text layer, not its pixels.
- **Word:** consistent labels (`[Person 1]`, `[Address 1]`), so the text still reads and an AI can
  follow who is who. Formatting, tables, headers and footers are kept.

## How it works

```
Browser (keeps the file)                     Server (Fly.io, London)
  1. POST /api/detect   file          →  read text (+ OCR for scans) → Mistral finds details
                                      ←  list of findings, grouped by person/place/number
  2. user unticks / adds items
  3. POST /api/redact   file + list   →  remove → re-read the output → refuse if anything is left
                                      ←  the anonymised file
```

The server is stateless. The file is sent with each request, held in memory, and gone when the
request ends. There is no database and no disk storage.

| Step | Where | Code |
| --- | --- | --- |
| Read text with positions | MuPDF (PDF), Tesseract OCR (scans, photos), XML (Word) | `src/server/formats/` |
| Find fixed-shape identifiers | NHS (checksum), NI, postcode, phone, email, sort code, DOB | `src/server/detect/ukPatterns.ts` |
| Find everything else | Mistral Medium, EU API, JSON mode, plus a second "what's left?" pass | `src/server/detect/index.ts`, `src/server/prompts/detect.ts` |
| Keep only what's really there | Every model answer must be found verbatim in the document | `src/server/detect/index.ts` |
| Group forms of one person | "Margaret Jones", "Mrs Jones", "Maggie" → `[Person 1]` | `groupCandidates` |
| Remove | MuPDF redaction, Word run editing, image repaint | `src/server/formats/` |
| Post-check | Read the finished file again (OCR for scans); fail rather than return a leak | `leftovers*` in each format |

Everything is matched by one function (`src/server/detect/match.ts`), so detection, counting,
removal and the post-check agree on what counts as a match.

## Privacy and security

- **Data location.** Server in London (Fly.io `lhr`). Document text goes to Mistral's EU API
  (Paris) for detection; the address is hard-coded in `src/server/config.ts`. OCR runs on our own
  server. Nothing else leaves the machine.
- **Mistral account.** Use a paid workspace (the free tier may use data for training) and request
  Zero Data Retention in the Mistral console. Set a monthly spending limit there too.
- **Nothing kept.** Uploads use memory storage only. Logs record type, page count, timings and
  counts, never text or file names.
- **What gets cleaned besides the visible text.** PDF: document properties, XMP metadata,
  bookmarks, form data, comments, attachments, JavaScript, tagged-PDF alt text, page thumbnails,
  and old revisions (the file is rewritten from scratch). Word: headers, footers, comments,
  tracked changes, text boxes, image alt text, author names, document properties, custom XML,
  hyperlink targets. Images: EXIF (camera, time, location). The download's file name is cleaned as well.
- **Abuse and cost limits** (`src/server/limits.ts`): 15 documents per hour and 40 per day per
  connection, a daily page budget across everyone (default 3,000), 2 documents processed at once
  with a short queue, 20 MB and 50 pages per file, and a zip-bomb guard for Word files.
- **Browser.** Strict Content Security Policy (own scripts and styles only), HSTS, no cookies,
  no analytics, no third-party scripts.

## Quality

`npm run eval` runs 10 synthetic UK care documents (care plan, referral letter with comments and
tracked changes, incident report, scanned GP letter, phone photo of a form, visit notes, discharge
summary, family email, safeguarding concern, a policy with no personal data) through the real
pipeline. It then reads the **output** back and checks that every identifying string is gone and
that the care details survived. The launch gate is 98% of names, addresses and ID numbers.

Results on 26 September 2026:

| Setup | Identifiers removed | Care details kept | Cost per document |
| --- | --- | --- | --- |
| Mistral Small, recall pass | 98.3% (missed a first name and a town) | 98.1% | ~$0.0003 |
| **Mistral Medium, recall pass (default)** | **100%** | **100%** | **~$0.0017** |
| Mistral Medium, no recall pass | 100% | 100% | ~$0.0012 |

The recall pass stays on as a safety margin. The set is small and was written alongside the
prompt, so re-run it against real (anonymised) documents before trusting these numbers, and add
any miss you find to `eval/fixtures.ts`.

## Costs

- Fly.io: `shared-cpu-1x`, 1 GB, suspends when idle. Roughly £1–4 a month at low use.
- Mistral: about 0.15p per document. 1,000 documents a month is under £2.
- OCR: free (runs locally).

## Run it locally

```bash
npm install
cp .env.example .env   # add MISTRAL_API_KEY
npm run dev            # web on http://localhost:5174, API on :8080
```

| Script | Does |
| --- | --- |
| `npm run dev` | API (tsx watch) and web (Vite) together |
| `npm test` | Unit tests; no model calls |
| `npm run eval` | End-to-end quality check; calls Mistral (costs a few pence) |
| `npm run fixtures` | Rebuild the eval documents from `eval/fixtures.ts` |
| `npm run lint` / `typecheck` / `build` | As named |

## Deploy (Fly.io)

```bash
fly launch --copy-config --no-deploy --name <app-name> --region lhr
fly secrets set MISTRAL_API_KEY=...
fly deploy --ha=false
```

Check `https://<app>.fly.dev/api/health` (process up) and `/api/ready` (Mistral key works).
Mistral keys have an expiry date: when `/api/ready` returns 503 with `credential_rejected`, the
key needs replacing.

Optional settings are listed in `.env.example`.

## Limitations

- Faces, signatures and handwriting are not detected. The page says so.
- Pictures inside Word files are not checked. The review screen says so when a file has them.
- Context can still identify someone ("the only resident with a guide dog"). The user is asked to
  read the result.
- `.doc`, HEIC photos, spreadsheets and password-protected PDFs are not supported yet.

## Licence

AGPL-3.0 (see `LICENSE`), because PDF redaction uses MuPDF, which is AGPL. If you run a modified
version as a service, publish your changes.
