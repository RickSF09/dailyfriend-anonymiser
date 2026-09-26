// Minimal client for Mistral's chat completions API, EU host only.
// Adapted from the DailyFriend POC portfolio (api/_lib/mistral.ts).

import { config, requireMistralKey } from './config.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** An upstream failure. `transient` separates "try again" from a real fault. */
export class MistralError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`Mistral API error ${status}`);
    this.name = 'MistralError';
  }
  get transient(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Retries 429 and 5xx with backoff, honouring Retry-After. Mistral's rate
// limits are per workspace, so a short burst of 429s is expected under load.
async function withRetry(doFetch: () => Promise<Response>): Promise<Response> {
  const maxAttempts = 4;
  let res!: Response;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      res = await doFetch();
    } catch {
      // Network failure or timeout (fetch throws rather than returning a
      // status). Treated like a 503: retried, then reported as "busy".
      if (attempt === maxAttempts) throw new MistralError(503, 'network error');
      await sleep(1000 * 2 ** (attempt - 1));
      continue;
    }
    if (res.ok) break;
    const retriable = res.status === 429 || res.status >= 500;
    if (!retriable || attempt === maxAttempts) break;
    const retryAfter = Number(res.headers.get('retry-after'));
    await sleep(retryAfter > 0 ? retryAfter * 1000 : Math.min(1000 * 2 ** (attempt - 1), 8000));
  }
  return res;
}

/** Running token totals, for logs and the eval's cost estimate. */
export const tokenUsage = { prompt: 0, completion: 0, calls: 0 };

export interface JsonCallOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

/**
 * JSON-mode completion. The prompt must describe the schema and contain the
 * word "json" (a Mistral requirement). Returns the parsed object.
 */
export async function jsonCall<T>(messages: ChatMessage[], opts: JsonCallOptions = {}): Promise<T> {
  const apiKey = requireMistralKey();
  const res = await withRetry(() =>
    fetch(`${config.mistral.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: opts.model ?? config.mistral.model,
        messages,
        temperature: opts.temperature ?? 0,
        max_tokens: opts.maxTokens ?? 4000,
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(config.mistral.timeoutMs),
    }),
  );
  if (!res.ok) throw new MistralError(res.status, await res.text());

  const data = (await res.json()) as {
    choices?: { finish_reason?: string; message?: { content?: string | null } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  tokenUsage.calls++;
  tokenUsage.prompt += data.usage?.prompt_tokens ?? 0;
  tokenUsage.completion += data.usage?.completion_tokens ?? 0;
  const choice = data.choices?.[0];
  const content = choice?.message?.content ?? '';
  if (choice?.finish_reason === 'length') {
    throw new Error('The model ran out of output tokens before finishing its list.');
  }
  try {
    return JSON.parse(content) as T;
  } catch {
    throw new Error('The model returned malformed JSON.');
  }
}

/** Cheap authenticated call (no tokens) used by the readiness check. */
export async function listModels(): Promise<Response> {
  return fetch(`${config.mistral.baseUrl}/v1/models`, {
    headers: { Authorization: `Bearer ${requireMistralKey()}` },
    signal: AbortSignal.timeout(10_000),
  });
}
