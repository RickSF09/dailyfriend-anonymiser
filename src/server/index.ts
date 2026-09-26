// HTTP server: the two document endpoints, health checks, and the web page.
//
// Privacy rules for this file:
//  - uploads are held in memory only (multer memoryStorage), never on disk;
//  - nothing about a document's content or its file name is ever logged;
//  - responses are streamed and the buffers go out of scope when they end.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import multer from 'multer';
import { LIMITS, type StreamEvent, type Term } from '../shared/types.js';
import { config } from './config.js';
import { UserFacingError } from './formats/errors.js';
import { acquireSlot, BudgetError, BusyError, chargePages, detectLimiters, redactLimiter } from './limits.js';
import { MistralError } from './mistral.js';
import { analyse, anonymise, LeakError } from './pipeline.js';
import { readiness, startReadinessMonitor } from './readiness.js';

const app = express();
app.disable('x-powered-by');
// Fly's proxy sets X-Forwarded-For; without this every visitor looks like one
// client to the rate limiter.
app.set('trust proxy', 1);

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: [],
      },
    },
    strictTransportSecurity: { maxAge: 31_536_000, includeSubDomains: true },
    referrerPolicy: { policy: 'no-referrer' },
  }),
);
app.use((_req, res, next) => {
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()');
  next();
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: LIMITS.maxBytes, files: 1, fields: 2, fieldSize: 256 * 1024, parts: 4 },
  defParamCharset: 'utf8',
});

class AbortedError extends Error {}

function publicMessage(e: unknown): string {
  if (e instanceof UserFacingError) return e.message;
  if (e instanceof BudgetError)
    return 'The anonymiser has reached its limit for today. Please try again tomorrow.';
  if (e instanceof BusyError) return 'The anonymiser is busy right now. Please try again in a minute.';
  if (e instanceof LeakError) {
    return 'We could not confirm that everything was removed from this file, so we have not returned it. Please try again, or contact us.';
  }
  if (e instanceof MistralError && e.transient) {
    return 'The service that finds personal details is busy. Please try again in a minute.';
  }
  return 'Something went wrong while processing your document. Please try again.';
}

/**
 * Runs a job and streams its events as NDJSON, one JSON object per line.
 * The final line is either the result or an error.
 */
async function streamJob(
  res: Response,
  evt: string,
  job: (emit: (e: StreamEvent) => void, checkAborted: () => void) => Promise<Record<string, unknown>>,
) {
  res.status(200);
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.flushHeaders();

  let aborted = false;
  res.on('close', () => {
    if (!res.writableFinished) aborted = true;
  });
  const emit = (e: StreamEvent) => {
    if (!aborted) res.write(`${JSON.stringify(e)}\n`);
  };
  const checkAborted = () => {
    if (aborted) throw new AbortedError();
  };

  const started = Date.now();
  let release: (() => void) | null = null;
  try {
    release = await acquireSlot((position) => emit({ type: 'queued', position }));
    checkAborted();
    const stats = await job(emit, checkAborted);
    console.log(JSON.stringify({ evt, outcome: 'ok', ms: Date.now() - started, ...stats }));
  } catch (e) {
    if (!(e instanceof AbortedError)) {
      emit({ type: 'error', message: publicMessage(e) });
    }
    console.log(
      JSON.stringify({
        evt,
        outcome: e instanceof AbortedError ? 'aborted' : 'error',
        error: e instanceof Error ? e.name : 'unknown',
        // Upstream status only; a MistralError body can echo the request.
        status: e instanceof MistralError ? e.status : undefined,
        ms: Date.now() - started,
      }),
    );
  } finally {
    release?.();
    res.end();
  }
}

function requireFile(req: Request): Buffer {
  if (!req.file?.buffer?.length) throw new UserFacingError('No file was uploaded.');
  return req.file.buffer;
}

const LABEL = /^\[[A-Za-z][A-Za-z ]{0,30}(?: \d{1,4})?\]$/;

function parseTerms(raw: unknown): Term[] {
  let list: unknown;
  try {
    list = JSON.parse(String(raw ?? '[]'));
  } catch {
    throw new UserFacingError('The list of items to remove was not readable.');
  }
  if (!Array.isArray(list)) throw new UserFacingError('The list of items to remove was not readable.');
  const seen = new Set<string>();
  const terms: Term[] = [];
  for (const item of list.slice(0, LIMITS.maxTerms)) {
    const text = typeof item?.text === 'string' ? item.text.trim() : '';
    if (!text || text.length > LIMITS.maxTermLength || seen.has(text)) continue;
    seen.add(text);
    const label = typeof item?.label === 'string' && LABEL.test(item.label) ? item.label : '[Redacted]';
    terms.push({ text, label });
  }
  return terms;
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/ready', async (_req, res) => {
  const r = await readiness();
  res.status(r.ok ? 200 : 503).json(r);
});

app.post('/api/detect', ...detectLimiters, upload.single('file'), (req, res) => {
  void streamJob(res, 'detect', async (emit, checkAborted) => {
    const buf = requireFile(req);
    const { findings, meta } = await analyse(new Uint8Array(buf), {
      filename: req.file?.originalname ?? '',
      chargePages,
      progress: (stage, done, total) => {
        checkAborted();
        emit({ type: 'progress', stage, done, total });
      },
    });
    emit({ type: 'findings', findings, meta });
    return { kind: meta.kind, pages: meta.pages, ocrPages: meta.ocrPages, groups: findings.length };
  });
});

app.post('/api/redact', redactLimiter, upload.single('file'), (req, res) => {
  void streamJob(res, 'redact', async (emit, checkAborted) => {
    const buf = requireFile(req);
    const terms = parseTerms(req.body?.terms);
    const result = await anonymise(
      new Uint8Array(buf),
      terms,
      req.file?.originalname ?? '',
      (stage, done, total) => {
        checkAborted();
        emit({ type: 'progress', stage, done, total });
      },
    );
    emit({
      type: 'file',
      name: result.name,
      mime: result.mime,
      base64: Buffer.from(result.output).toString('base64'),
      removed: result.removed,
    });
    return { terms: terms.length, removed: result.removed, bytes: result.output.length };
  });
});

// Upload errors (too big, wrong field) arrive here before any streaming starts.
app.use('/api', (err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (err instanceof multer.MulterError) {
    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? `That file is larger than ${LIMITS.maxBytes / 1024 / 1024} MB.`
        : 'The upload was not in the expected format.';
    res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: message });
    return;
  }
  next(err);
});

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// The built web page. In development Vite serves it and proxies /api here.
const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web');
app.use(
  express.static(webDir, {
    index: 'index.html',
    maxAge: '1y',
    immutable: true,
    // Asset names carry a content hash; the page itself must never be stale.
    setHeaders: (res, file) => {
      if (file.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    },
  }),
);
app.get(/.*/, (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(webDir, 'index.html'));
});

app.listen(config.port, () => {
  console.log(JSON.stringify({ evt: 'listening', port: config.port, model: config.mistral.model }));
  startReadinessMonitor();
});
