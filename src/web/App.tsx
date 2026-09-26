import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import {
  LIMITS,
  type DocMeta,
  type EntityType,
  type Finding,
  type Stage,
  type StreamEvent,
} from '../shared/types';
import { base64ToBlob, detect, redact } from './client';
import logoUrl from './assets/logo.svg';

type Phase =
  | { name: 'idle' }
  | {
      name: 'working';
      step: 'detect' | 'redact';
      stage?: Stage;
      done?: number;
      total?: number;
      queued?: number;
    }
  | { name: 'review'; findings: Finding[]; meta: DocMeta }
  | { name: 'done'; url: string; fileName: string; removed: number }
  | { name: 'error'; message: string };

const SOURCE_URL = 'https://github.com/RickSF09/dailyfriend-anonymiser';
const ACCEPT = '.pdf,.docx,.png,.jpg,.jpeg,.webp';

const TYPE_NAMES: Record<EntityType, string> = {
  PERSON: 'People',
  ADDRESS: 'Addresses and postcodes',
  PLACE: 'Places',
  ORGANISATION: 'Organisations and services',
  PHONE: 'Phone numbers',
  EMAIL: 'Email addresses',
  ID: 'ID and reference numbers',
  DATE_OF_BIRTH: 'Dates of birth',
  OTHER: 'Other identifying details',
};

const STAGE_TEXT: Record<Stage, string> = {
  reading: 'Reading your document',
  detecting: 'Looking for personal details',
  applying: 'Removing the details you chose',
  checking: 'Double-checking the result',
};

export function App() {
  const [phase, setPhase] = useState<Phase>({ name: 'idle' });
  const [file, setFile] = useState<File | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [added, setAdded] = useState<string[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  function reset() {
    abortRef.current?.abort();
    if (phase.name === 'done') URL.revokeObjectURL(phase.url);
    setPhase({ name: 'idle' });
    setFile(null);
    setSelected(new Set());
    setAdded([]);
  }

  function onEvent(step: 'detect' | 'redact') {
    return (e: StreamEvent) => {
      if (e.type === 'queued') setPhase({ name: 'working', step, queued: e.position });
      else if (e.type === 'progress') {
        setPhase({ name: 'working', step, stage: e.stage, done: e.done, total: e.total });
      } else if (e.type === 'error') setPhase({ name: 'error', message: e.message });
      else if (e.type === 'findings') {
        setSelected(new Set(e.findings.map((f) => f.label)));
        setPhase({ name: 'review', findings: e.findings, meta: e.meta });
      } else if (e.type === 'file') {
        const url = URL.createObjectURL(base64ToBlob(e.base64, e.mime));
        setPhase({ name: 'done', url, fileName: e.name, removed: e.removed });
        triggerDownload(url, e.name);
      }
    };
  }

  async function run(step: 'detect' | 'redact', job: (signal: AbortSignal) => Promise<void>) {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setPhase({ name: 'working', step });
    try {
      await job(ctrl.signal);
      // A stream that ends without a result or an error was cut off.
      setPhase((p) =>
        p.name === 'working'
          ? { name: 'error', message: 'The connection was interrupted. Please try again.' }
          : p,
      );
    } catch (e) {
      if (ctrl.signal.aborted) return;
      setPhase({ name: 'error', message: e instanceof Error ? e.message : 'Something went wrong.' });
    }
  }

  function choose(f: File) {
    if (f.size > LIMITS.maxBytes) {
      setPhase({ name: 'error', message: `That file is larger than ${LIMITS.maxBytes / 1024 / 1024} MB.` });
      return;
    }
    setFile(f);
    void run('detect', (signal) => detect(f, onEvent('detect'), signal));
  }

  function apply(findings: Finding[]) {
    if (!file) return;
    const terms = [
      ...findings
        .filter((f) => selected.has(f.label))
        .flatMap((f) => f.texts.map((text) => ({ text, label: f.label }))),
      ...added.map((text) => ({ text, label: '[Redacted]' })),
    ];
    void run('redact', (signal) => redact(file, terms, onEvent('redact'), signal));
  }

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-line bg-white">
        <div className="mx-auto max-w-3xl px-4 py-3 flex items-center gap-3">
          <img src={logoUrl} alt="DailyFriend" className="h-7 w-auto" />
          <span className="text-sm font-semibold text-muted border-l border-line pl-3">
            Document anonymiser
          </span>
        </div>
      </header>

      <main className="flex-1 mx-auto w-full max-w-3xl px-4 py-8 sm:py-12">
        {phase.name === 'idle' && <Intro onFile={choose} />}
        {phase.name === 'working' && <Working phase={phase} fileName={file?.name} onCancel={reset} />}
        {phase.name === 'review' && (
          <Review
            findings={phase.findings}
            meta={phase.meta}
            selected={selected}
            setSelected={setSelected}
            added={added}
            setAdded={setAdded}
            onApply={() => apply(phase.findings)}
            onCancel={reset}
          />
        )}
        {phase.name === 'done' && <Done phase={phase} onAgain={reset} />}
        {phase.name === 'error' && <ErrorPanel message={phase.message} onAgain={reset} />}
      </main>

      <footer className="border-t border-line bg-white">
        <div className="mx-auto max-w-3xl px-4 py-5 text-xs text-muted flex flex-wrap gap-x-4 gap-y-1">
          <span>A free tool from DailyFriend</span>
          <span>Nothing you upload is stored</span>
          <a className="underline hover:text-ink" href={SOURCE_URL} target="_blank" rel="noreferrer">
            Source code (AGPL-3.0)
          </a>
        </div>
      </footer>
    </div>
  );
}

function triggerDownload(url: string, name: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function Intro({ onFile }: { onFile: (f: File) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  return (
    <div>
      <h1 className="text-3xl sm:text-4xl font-bold tracking-tight">
        Remove personal details from a document
      </h1>
      <p className="mt-3 text-lg text-muted max-w-2xl">
        Upload a care plan, letter or form. We find names, addresses, phone numbers, NHS numbers and other
        identifying details, you check the list, and you get the same file back with those details removed.
      </p>

      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          const f = e.dataTransfer.files[0];
          if (f) onFile(f);
        }}
        className={`mt-8 w-full rounded-2xl border-2 border-dashed px-6 py-12 text-center transition-colors ${
          over
            ? 'border-brand bg-brand-soft'
            : 'border-line bg-white hover:border-brand hover:bg-brand-soft/50'
        }`}
      >
        <span className="block text-lg font-semibold text-brand">Choose a file</span>
        <span className="mt-1 block text-muted">or drag it here</span>
        <span className="mt-4 block text-sm text-muted">
          PDF, Word (.docx) or a photo (PNG, JPG) · up to {LIMITS.maxBytes / 1024 / 1024} MB and{' '}
          {LIMITS.maxPages} pages
        </span>
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        className="sr-only"
        aria-label="Choose a file to anonymise"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) onFile(f);
        }}
      />

      <ul className="mt-8 grid gap-3 sm:grid-cols-3 text-sm">
        <Point title="Same file back">
          Your layout stays as it was. PDFs and images get black boxes; Word files get labels like [Person 1].
        </Point>
        <Point title="Really removed">
          The text under each black box is deleted, so an AI tool cannot read it either.
        </Point>
        <Point title="Nothing kept">
          Your file is processed in memory and never saved. It is not used to train AI.
        </Point>
      </ul>

      <HowItWorks />
    </div>
  );
}

function Point({ title, children }: { title: string; children: ReactNode }) {
  return (
    <li className="rounded-xl bg-white border border-line p-4">
      <span className="block font-semibold text-ink">{title}</span>
      <span className="mt-1 block text-muted">{children}</span>
    </li>
  );
}

function HowItWorks() {
  return (
    <details className="mt-8 rounded-xl bg-white border border-line p-4 text-sm group">
      <summary className="cursor-pointer font-semibold">How your document is handled</summary>
      <div className="mt-3 space-y-2 text-muted">
        <p>
          Your file is sent over an encrypted connection to our server in London. It is held in memory while
          it is processed and discarded straight after. Nothing is written to disk or kept in a database.
        </p>
        <p>
          To find personal details, the text of your document is checked by Mistral AI in the EU (Paris).
          Mistral does not use it to train its models. Scanned pages and photos are read on our own server.
        </p>
        <p>
          You then choose what to remove. We remove it, check the finished file again, and only hand it back
          if nothing you chose is left in it.
        </p>
        <p>
          No tool catches everything. Faces, signatures, handwriting and details that identify someone through
          context (for example, &ldquo;the only resident with a guide dog&rdquo;) can slip through. Always
          read the result before you use it.
        </p>
      </div>
    </details>
  );
}

function Working({
  phase,
  fileName,
  onCancel,
}: {
  phase: Extract<Phase, { name: 'working' }>;
  fileName?: string;
  onCancel: () => void;
}) {
  const pct = phase.total ? Math.round(((phase.done ?? 0) / phase.total) * 100) : null;
  const label = phase.queued
    ? `Waiting for a free slot (${phase.queued} ahead of you)`
    : phase.stage
      ? STAGE_TEXT[phase.stage]
      : phase.step === 'detect'
        ? 'Uploading'
        : 'Starting';
  const detail =
    phase.stage === 'reading' && phase.total
      ? `Page ${phase.done} of ${phase.total}`
      : pct !== null
        ? `${pct}%`
        : '';

  return (
    <div className="rounded-2xl bg-white border border-line p-6 sm:p-8">
      {fileName && <p className="text-sm text-muted truncate">{fileName}</p>}
      <p className="mt-1 text-xl font-semibold" aria-live="polite">
        {label}…
      </p>
      <div className="mt-5 h-2 rounded-full bg-brand-soft overflow-hidden" aria-hidden="true">
        <div
          className={`h-full rounded-full bg-brand transition-all duration-500 ${pct === null ? 'w-1/3 animate-pulse' : ''}`}
          style={pct === null ? undefined : { width: `${Math.max(pct, 4)}%` }}
        />
      </div>
      <p className="mt-2 text-sm text-muted h-5">{detail}</p>
      <button type="button" onClick={onCancel} className="mt-4 text-sm text-muted underline hover:text-ink">
        Cancel
      </button>
    </div>
  );
}

function Review({
  findings,
  meta,
  selected,
  setSelected,
  added,
  setAdded,
  onApply,
  onCancel,
}: {
  findings: Finding[];
  meta: DocMeta;
  selected: Set<string>;
  setSelected: (s: Set<string>) => void;
  added: string[];
  setAdded: (a: string[]) => void;
  onApply: () => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState('');
  const byType = useMemo(() => {
    const map = new Map<EntityType, Finding[]>();
    for (const f of findings) map.set(f.type, [...(map.get(f.type) ?? []), f]);
    return [...map.entries()];
  }, [findings]);

  const toggle = (label: string) => {
    const next = new Set(selected);
    if (next.has(label)) next.delete(label);
    else next.add(label);
    setSelected(next);
  };

  const addTerm = () => {
    const t = draft.trim();
    if (t.length < 2 || t.length > LIMITS.maxTermLength || added.includes(t)) return;
    setAdded([...added, t]);
    setDraft('');
  };

  const total = selected.size + added.length;
  const how =
    meta.kind === 'docx'
      ? 'Each one is replaced with its label, like [Person 1], so the text still reads clearly.'
      : 'Each one is covered with a black box and the text underneath is deleted.';

  return (
    <div>
      <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">
        {findings.length
          ? `We found ${findings.length} ${findings.length === 1 ? 'thing' : 'things'} to remove`
          : 'We did not find any personal details'}
      </h1>
      <p className="mt-2 text-muted">
        {findings.length
          ? `Untick anything you want to keep, and add anything we missed. ${how}`
          : 'If you can see something that should go, add it below.'}
      </p>

      {meta.notices.length > 0 && (
        <ul className="mt-4 space-y-2">
          {meta.notices.map((n) => (
            <li
              key={n}
              className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-900"
            >
              {n}
            </li>
          ))}
        </ul>
      )}

      {findings.length > 0 && (
        <div className="mt-4 flex gap-4 text-sm">
          <button
            type="button"
            className="underline text-brand"
            onClick={() => setSelected(new Set(findings.map((f) => f.label)))}
          >
            Select all
          </button>
          <button type="button" className="underline text-brand" onClick={() => setSelected(new Set())}>
            Select none
          </button>
        </div>
      )}

      <div className="mt-4 space-y-6">
        {byType.map(([type, list]) => (
          <section key={type}>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">{TYPE_NAMES[type]}</h2>
            <ul className="mt-2 divide-y divide-line rounded-xl bg-white border border-line">
              {list.map((f) => (
                <li key={f.label}>
                  <label className="flex items-start gap-3 px-4 py-3 cursor-pointer hover:bg-paper">
                    <input
                      type="checkbox"
                      className="mt-1 size-4 accent-brand"
                      checked={selected.has(f.label)}
                      onChange={() => toggle(f.label)}
                    />
                    <span className="flex-1 min-w-0">
                      <span className="font-medium break-words">{f.texts[0]}</span>
                      {f.texts.length > 1 && (
                        <span className="block text-sm text-muted break-words">
                          Also as: {f.texts.slice(1).join(', ')}
                        </span>
                      )}
                    </span>
                    <span className="text-right text-xs text-muted shrink-0">
                      <span className="block font-mono text-brand-dark">
                        {meta.kind === 'docx' ? f.label : ''}
                      </span>
                      {f.count}× {f.pages.length > 0 && meta.pages > 1 ? `· p. ${f.pages.join(', ')}` : ''}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </section>
        ))}

        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Anything we missed?</h2>
          <form
            className="mt-2 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              addTerm();
            }}
          >
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Type it exactly as it appears, e.g. Nana Joan"
              maxLength={LIMITS.maxTermLength}
              aria-label="Add something to remove"
              className="flex-1 min-w-0 rounded-lg border border-line bg-white px-3 py-2"
            />
            <button
              type="submit"
              className="rounded-lg border border-brand text-brand px-4 py-2 font-medium hover:bg-brand-soft"
            >
              Add
            </button>
          </form>
          {added.length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-2">
              {added.map((t) => (
                <li key={t} className="flex items-center gap-2 rounded-full bg-brand-soft px-3 py-1 text-sm">
                  {t}
                  <button
                    type="button"
                    aria-label={`Remove ${t} from the list`}
                    className="text-muted hover:text-ink"
                    onClick={() => setAdded(added.filter((x) => x !== t))}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <div className="mt-8 flex flex-wrap items-center gap-4">
        <button
          type="button"
          onClick={onApply}
          className="rounded-xl bg-brand px-6 py-3 font-semibold text-white hover:bg-brand-dark"
        >
          {total
            ? `Remove ${total} ${total === 1 ? 'item' : 'items'} and download`
            : 'Download a cleaned copy'}
        </button>
        <button type="button" onClick={onCancel} className="text-muted underline hover:text-ink">
          Start again
        </button>
      </div>
      {!total && (
        <p className="mt-2 text-sm text-muted">
          A cleaned copy has hidden details such as the author and document properties removed.
        </p>
      )}
    </div>
  );
}

function Done({ phase, onAgain }: { phase: Extract<Phase, { name: 'done' }>; onAgain: () => void }) {
  return (
    <div className="rounded-2xl bg-white border border-line p-6 sm:p-8">
      <p className="inline-block rounded-full bg-leaf-soft px-3 py-1 text-sm font-medium text-green-800">
        Done
      </p>
      <h1 className="mt-3 text-2xl sm:text-3xl font-bold tracking-tight">Your anonymised file is ready</h1>
      <p className="mt-2 text-muted">
        {phase.removed} {phase.removed === 1 ? 'place was' : 'places were'} changed, and we checked the
        finished file again to make sure nothing you chose was left in it.
      </p>
      <a
        href={phase.url}
        download={phase.fileName}
        className="mt-6 inline-block rounded-xl bg-brand px-6 py-3 font-semibold text-white hover:bg-brand-dark"
      >
        Download {phase.fileName}
      </a>
      <p className="mt-6 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-900">
        Please read it through before you use it with AI. Details can still identify someone through context,
        and photos, signatures and handwriting are not checked.
      </p>
      <button type="button" onClick={onAgain} className="mt-6 text-brand underline">
        Anonymise another document
      </button>
    </div>
  );
}

function ErrorPanel({ message, onAgain }: { message: string; onAgain: () => void }) {
  return (
    <div className="rounded-2xl bg-white border border-line p-6 sm:p-8" role="alert">
      <h1 className="text-xl font-semibold">That did not work</h1>
      <p className="mt-2 text-muted">{message}</p>
      <button
        type="button"
        onClick={onAgain}
        className="mt-6 rounded-xl bg-brand px-6 py-3 font-semibold text-white hover:bg-brand-dark"
      >
        Try again
      </button>
    </div>
  );
}
