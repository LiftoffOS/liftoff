// A vendor refused a call on rate, and what to do about it.
//
// Read STRUCTURALLY — off the `statusCode` every vendor error class in this
// directory carries — rather than by naming the classes. There are thirteen of
// them; `router.isRateLimited` named three, and `classifyWebToolError` named
// none, so a Perplexity 429 reached the model as `internal_error` with the
// recovery text "Repeating the identical call is not expected to help". The
// vendor had said `retry-after: 1`.
//
// Enumerating classes is what failed. Any error that reports a status says
// whether the vendor refused on rate, and a vendor that refused on rate did no
// work — which is the same fact the refund path needs and the same fact the
// model needs.

import type { RateLimitSnapshot } from './credential-pool';

/** What the vendor asked us to wait when it said nothing. One second: the
 *  shortest window any of these vendors meters on, so it is the smallest wait
 *  that can change the answer. */
const UNSTATED_RETRY_AFTER_MS = 1_000;

/** Believing a vendor past this point sets a tool aside for longer than a run
 *  will wait, so the call is reported as refused with the real figure rather
 *  than held. Matches credential-pool's ceiling on an honoured retry-after. */
const MAX_REPORTED_RETRY_AFTER_MS = 60_000;

interface StatusCarrying {
  statusCode?: unknown;
  retryAfterMs?: unknown;
}

/**
 * The vendor refused this call on rate.
 *
 * Returns how long to wait, or null when the error is not a rate refusal.
 * `retryAfterMs` prefers the vendor's own number when the client captured one.
 */
export function vendorRateLimit(err: unknown): { retryAfterMs: number } | null {
  if (typeof err !== 'object' || err === null) return null;
  const e = err as StatusCarrying;
  if (e.statusCode !== 429) return null;
  const stated = typeof e.retryAfterMs === 'number' && Number.isFinite(e.retryAfterMs) && e.retryAfterMs > 0
    ? e.retryAfterMs
    : UNSTATED_RETRY_AFTER_MS;
  return { retryAfterMs: Math.min(stated, MAX_REPORTED_RETRY_AFTER_MS) };
}

/** The wait a vendor's response asked for, for a client to stamp on its error.
 *  Null when the response said nothing about it, which the caller keeps as
 *  "not stated" rather than turning into a guess of its own. */
export function retryAfterFromSnapshot(snapshot: RateLimitSnapshot): number | undefined {
  const ms = snapshot.retryAfterMs;
  return typeof ms === 'number' && ms > 0 ? ms : undefined;
}
