import type { StreamEvent, Term } from '../shared/types';

/**
 * POST a file (and optional fields) and hand each NDJSON event to `onEvent`
 * as it arrives. Rejects with a readable message on HTTP or network failure.
 */
export async function streamRequest(
  url: string,
  file: File,
  fields: Record<string, string>,
  onEvent: (e: StreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.append(k, v);
  body.append('file', file);

  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', body, signal });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new Error('Could not reach the anonymiser. Check your connection and try again.', { cause: e });
  }
  if (!res.ok || !res.body) {
    let message = 'Something went wrong. Please try again.';
    try {
      const data = (await res.json()) as { error?: string };
      if (data.error) message = data.error;
    } catch {
      /* not JSON */
    }
    throw new Error(message);
  }

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buffer += value;
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) onEvent(JSON.parse(line) as StreamEvent);
    }
    if (done) break;
  }
}

export function detect(file: File, onEvent: (e: StreamEvent) => void, signal?: AbortSignal) {
  return streamRequest('/api/detect', file, {}, onEvent, signal);
}

export function redact(file: File, terms: Term[], onEvent: (e: StreamEvent) => void, signal?: AbortSignal) {
  return streamRequest('/api/redact', file, { terms: JSON.stringify(terms) }, onEvent, signal);
}

export function base64ToBlob(base64: string, mime: string): Blob {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}
