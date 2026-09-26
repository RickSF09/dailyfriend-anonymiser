// Runtime settings. Everything here is either non-secret or read from the
// environment (Fly secrets in production, a local .env in development).

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
  return n;
}

export const config = {
  port: int('PORT', 8080),
  mistral: {
    // Hard-pinned, deliberately NOT read from the environment. Documents are
    // UK health and care records; the only place their text may go is
    // Mistral's EU API (Paris). A stray env var must not be able to send them
    // to another endpoint.
    baseUrl: 'https://api.mistral.ai',
    apiKey: process.env.MISTRAL_API_KEY ?? '',
    // Medium, not Small: on the eval set Small missed a first name and a town
    // that Medium caught, for about 0.1p more per document (see README).
    model: process.env.MISTRAL_MODEL ?? 'mistral-medium-latest',
    // A second call that looks at the text with everything already found
    // masked out, and asks what is still identifying. Off only for evals.
    recallPass: process.env.MISTRAL_RECALL_PASS !== 'false',
    timeoutMs: 90_000,
  },
  limits: {
    /** Documents one connection can check per hour / per day. */
    perIpHour: int('LIMIT_PER_IP_HOUR', 15),
    perIpDay: int('LIMIT_PER_IP_DAY', 40),
    /** Pages sent to Mistral across everyone per UTC day: the cost ceiling. */
    dailyPageBudget: int('DAILY_PAGE_BUDGET', 3000),
    /** Documents processed at the same time; the rest wait in a queue. */
    concurrency: int('CONCURRENCY', 2),
    maxQueue: int('MAX_QUEUE', 12),
  },
};

export function requireMistralKey(): string {
  if (!config.mistral.apiKey) {
    throw new Error('MISTRAL_API_KEY is not set');
  }
  return config.mistral.apiKey;
}
