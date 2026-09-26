// Abuse and cost control for a public tool with no accounts.
//
// Three layers:
//  - per-connection limits, so one script cannot run up the Mistral bill;
//  - a daily page budget across everyone, a hard ceiling on spend (the
//    Mistral console's own spending limit is the backstop behind it);
//  - a small work queue, so a burst of large scans cannot exhaust memory.
//
// The per-IP limiters key on the client IP, which on Fly arrives in
// X-Forwarded-For: `app.set('trust proxy', 1)` in index.ts is required.

import rateLimit from 'express-rate-limit';
import { config } from './config.js';

const tooMany = {
  error: 'You have checked a lot of documents in a short time. Please wait a while and try again.',
};

// Checking a document costs model calls; these are the expensive requests.
export const detectLimiters = [
  rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: config.limits.perIpHour,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: tooMany,
  }),
  rateLimit({
    windowMs: 24 * 60 * 60 * 1000,
    limit: config.limits.perIpDay,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: tooMany,
  }),
];

// Applying approved removals is local work only, but still CPU and memory.
export const redactLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: config.limits.perIpHour * 4,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: tooMany,
});

export class BudgetError extends Error {}
export class BusyError extends Error {}

let budgetDay = '';
let pagesToday = 0;

/** Reserve pages from today's budget. Resets at midnight UTC and on restart. */
export function chargePages(pages: number): void {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== budgetDay) {
    budgetDay = today;
    pagesToday = 0;
  }
  if (pagesToday + pages > config.limits.dailyPageBudget) throw new BudgetError();
  pagesToday += pages;
}

let running = 0;
const waiting: (() => void)[] = [];

/**
 * Wait for a work slot. `onQueued` reports the position while waiting.
 * Returns the function that frees the slot.
 */
export async function acquireSlot(onQueued: (position: number) => void): Promise<() => void> {
  if (running >= config.limits.concurrency) {
    if (waiting.length >= config.limits.maxQueue) throw new BusyError();
    onQueued(waiting.length + 1);
    await new Promise<void>((resolve) => waiting.push(resolve));
  } else {
    running++;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = waiting.shift();
    if (next) next();
    else running--;
  };
}
