// Liveness vs readiness (the same split as CareMatch).
//
// /api/health answers "is the process up?" and never depends on anything
// external, so a Mistral outage cannot get a healthy machine restarted.
// /api/ready answers "can we check a document right now?" by making a cheap
// authenticated call to Mistral. Mistral keys carry an expiry date; this is
// how an expired key shows up in monitoring before a visitor finds it.

import { listModels } from './mistral.js';

export type Readiness =
  { ok: true } | { ok: false; reason: 'no_key' | 'credential_rejected' | 'upstream_busy' | 'unreachable' };

const CACHE_MS = 60_000;
let cached: { at: number; value: Readiness } | null = null;
let inFlight: Promise<Readiness> | null = null;

async function probe(): Promise<Readiness> {
  if (!process.env.MISTRAL_API_KEY) return { ok: false, reason: 'no_key' };
  try {
    const res = await listModels();
    if (res.ok) return { ok: true };
    const detail = (await res.text()).slice(0, 200);
    console.error(JSON.stringify({ evt: 'mistral_not_ready', status: res.status, detail }));
    return {
      ok: false,
      reason: res.status === 401 || res.status === 403 ? 'credential_rejected' : 'upstream_busy',
    };
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
}

/** Cached and single-flighted: the endpoint is public and must not amplify traffic. */
export async function readiness(): Promise<Readiness> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  inFlight ??= probe().finally(() => {
    inFlight = null;
  });
  const value = await inFlight;
  cached = { at: Date.now(), value };
  return value;
}

export function startReadinessMonitor(): void {
  const check = () =>
    void readiness().then((r) => {
      if (!r.ok) console.error(JSON.stringify({ evt: 'not_ready', reason: r.reason }));
    });
  check();
  setInterval(check, 5 * 60_000).unref();
}
