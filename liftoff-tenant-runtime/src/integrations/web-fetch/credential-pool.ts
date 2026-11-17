// More than one key for the same vendor, and knowing when one is spent.
//
// A tenant that has connected two Firecrawl accounts has told us something
// useful, and until now we ignored it: the credential resolver took the first
// connector it found and stayed on it. When that key hit its rate limit or ran
// out of credit, every run stopped — with the second key sitting right there,
// connected, unused.
//
// So: a pool per (tenant, vendor), ordered, with a cooldown on each credential.
// A key that says "slow down" is set aside for as long as it asked for; a key
// that says "out of credit" is set aside for much longer, because that is not
// a minute-scale problem. The next request takes the next usable key.
//
// Two things this deliberately is NOT:
//
//   * It is not a retry loop. One failover per call. A caller that burns
//     through five keys on one request has found a problem no amount of keys
//     will fix, and would have spent five vendor quotas discovering it.
//   * It is not silent. When the last key goes into cooldown the caller gets
//     the same BYOK error it always did, so the person still hears "your
//     account is out of credit" rather than the run failing mysteriously — the
//     pool changes when they hear it, not whether.
//
// Rate-limit headers feed the cooldown rather than only being logged. Vendors
// already tell us when they will accept traffic again; guessing at a backoff
// while ignoring the number in the response is how a limit turns into an outage.

import { logger } from '../../infrastructure/logging';

/** How long a credential sits out after saying "slow down", when the vendor
 *  gave no number of its own. */
export const DEFAULT_RATE_LIMIT_COOLDOWN_MS = Number(process.env.BYOK_RATE_LIMIT_COOLDOWN_MS ?? 60_000);

/** How long after "out of credit". Deliberately long: topping up an account is
 *  a human act on a human timescale, and retrying every minute in the meantime
 *  is a request that cannot succeed. */
export const EXHAUSTED_COOLDOWN_MS = Number(process.env.BYOK_EXHAUSTED_COOLDOWN_MS ?? 30 * 60_000);

/** How long after the vendor rejected the key outright. Longest of the three —
 *  a revoked key does not come back on its own, and the connector row has
 *  already been flipped to error, so this only stops the pool re-picking it
 *  before that lands. */
export const INVALID_KEY_COOLDOWN_MS = Number(process.env.BYOK_INVALID_KEY_COOLDOWN_MS ?? 60 * 60_000);

/** A vendor asking for an hour is telling us about its own window; a vendor
 *  asking for a day is telling us about a quota. Either way, waiting that long
 *  inside a request is not on the table — the cap only bounds how long we
 *  believe the header. */
const MAX_HONOURED_RETRY_AFTER_MS = 15 * 60_000;

export type CooldownReason = 'rate_limited' | 'exhausted' | 'invalid_key';

export interface PooledCredential {
  /** Connector row id — the pool's identity for a credential. Not the key
   *  itself: keys are secrets and must not be map keys, log fields, or
   *  anything else that outlives the request. */
  connectorId: string;
  apiKey: string;
  extra: Record<string, string>;
}

interface Cooldown {
  until: number;
  reason: CooldownReason;
}

/** Keyed by connector id, so a credential's cooldown survives the credential
 *  cache expiring and being refetched. */
const cooldowns = new Map<string, Cooldown>();

export function _resetCredentialPoolForTesting(): void {
  cooldowns.clear();
}

// ── Rate-limit headers ───────────────────────────────────────────────────────

export interface RateLimitSnapshot {
  /** Calls left in the current window, when the vendor says. */
  remaining: number | null;
  /** Ceiling for the window. */
  limit: number | null;
  /** When the window resets, as epoch milliseconds. */
  resetAt: number | null;
  /** What the vendor asked us to wait, in milliseconds. */
  retryAfterMs: number | null;
}

/**
 * Read whatever the vendor said about its limits.
 *
 * Every vendor spells this differently and several spell it more than one way,
 * so this is deliberately forgiving and returns nulls rather than guesses. A
 * missing header means "not stated", never "zero" — the difference decides
 * whether a credential is set aside.
 *
 * `x-ratelimit-reset` is the worst offender: some vendors send epoch seconds,
 * some epoch milliseconds, some seconds-from-now. All three are handled by
 * magnitude, because a value under a year is not a timestamp.
 */
export function parseRateLimitHeaders(headers: {
  get(name: string): string | null;
}): RateLimitSnapshot {
  const num = (name: string): number | null => {
    const raw = headers.get(name);
    if (raw === null || raw.trim() === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };

  const remaining = num('x-ratelimit-remaining') ?? num('ratelimit-remaining');
  const limit = num('x-ratelimit-limit') ?? num('ratelimit-limit');

  let retryAfterMs: number | null = null;
  const retryAfter = num('retry-after');
  if (retryAfter !== null && retryAfter >= 0) retryAfterMs = retryAfter * 1000;

  let resetAt: number | null = null;
  const reset = num('x-ratelimit-reset') ?? num('ratelimit-reset');
  if (reset !== null && reset > 0) {
    const now = Date.now();
    if (reset > 1e11) resetAt = reset;                 // epoch milliseconds
    else if (reset > 1e9) resetAt = reset * 1000;      // epoch seconds
    else resetAt = now + reset * 1000;                 // seconds from now
    if (retryAfterMs === null) retryAfterMs = Math.max(0, resetAt - now);
  }

  return { remaining, limit, resetAt, retryAfterMs };
}

/**
 * Record what a vendor said about its limits.
 *
 * Logged as a structured line rather than a metric because the useful question
 * is "which tenant, which vendor, how close" and that is a query, not a gauge.
 * The key itself never appears — only the connector id.
 */
export function recordRateLimit(args: {
  tenantId: string;
  vendor: string;
  connectorId: string;
  snapshot: RateLimitSnapshot;
}): void {
  const { snapshot } = args;
  if (snapshot.remaining === null && snapshot.limit === null && snapshot.retryAfterMs === null) return;

  const nearlyOut = snapshot.remaining !== null
    && snapshot.limit !== null
    && snapshot.limit > 0
    && snapshot.remaining / snapshot.limit <= 0.1;

  const fields = {
    event: 'byok_rate_limit',
    tenant_id: args.tenantId,
    vendor: args.vendor,
    connector_id: args.connectorId,
    remaining: snapshot.remaining,
    limit: snapshot.limit,
    reset_at: snapshot.resetAt,
  };

  if (nearlyOut) {
    logger.warn(fields, 'a BYOK vendor key is nearly out of its current window');
    return;
  }
  logger.info(fields, 'byok rate-limit headers');
}

// ── Cooldowns ────────────────────────────────────────────────────────────────

function cooldownFor(reason: CooldownReason, retryAfterMs: number | null): number {
  if (reason === 'exhausted') return EXHAUSTED_COOLDOWN_MS;
  if (reason === 'invalid_key') return INVALID_KEY_COOLDOWN_MS;
  // A vendor's own number beats ours, up to the point where believing it would
  // set the key aside for longer than anybody would wait.
  if (retryAfterMs !== null && retryAfterMs > 0) {
    return Math.min(retryAfterMs, MAX_HONOURED_RETRY_AFTER_MS);
  }
  return DEFAULT_RATE_LIMIT_COOLDOWN_MS;
}

/** Set a credential aside. Returns when it becomes usable again. */
export function markCredentialCooling(args: {
  tenantId: string;
  vendor: string;
  connectorId: string;
  reason: CooldownReason;
  retryAfterMs?: number | null;
}): number {
  const ms = cooldownFor(args.reason, args.retryAfterMs ?? null);
  const until = Date.now() + ms;
  cooldowns.set(args.connectorId, { until, reason: args.reason });
  logger.info(
    {
      event: 'byok_credential_cooling',
      tenant_id: args.tenantId,
      vendor: args.vendor,
      connector_id: args.connectorId,
      reason: args.reason,
      cooldown_ms: ms,
    },
    'a BYOK credential was set aside; the next request uses the next key',
  );
  return until;
}

/** Any success clears the cooldown. A key that works is a key that works, and
 *  leaving it sidelined for the rest of a window it has evidently left would
 *  be a self-inflicted outage. */
export function markCredentialHealthy(connectorId: string): void {
  cooldowns.delete(connectorId);
}

export function isCooling(connectorId: string, now = Date.now()): boolean {
  const c = cooldowns.get(connectorId);
  if (!c) return false;
  if (c.until <= now) {
    cooldowns.delete(connectorId);
    return false;
  }
  return true;
}

export function cooldownReason(connectorId: string): CooldownReason | null {
  const c = cooldowns.get(connectorId);
  return c && c.until > Date.now() ? c.reason : null;
}

// ── Choosing ─────────────────────────────────────────────────────────────────

export interface PoolSelection {
  credential: PooledCredential;
  /** How many usable credentials remain behind this one. Zero means this is the
   *  last key: a caller that fails now has nowhere left to go, and says so. */
  alternativesRemaining: number;
}

/**
 * The first credential that is not cooling.
 *
 * Order is the caller's — the connector list as the tenant sees it — so
 * "which key gets used" is stable and explicable rather than whichever
 * happened to be least recently tried.
 *
 * Returns null when every credential is cooling, which is the caller's cue to
 * raise the same BYOK error it always did. The pool changes WHEN a person hears
 * about a spent account, never whether.
 */
export function selectCredential(
  candidates: PooledCredential[],
  now = Date.now(),
): PoolSelection | null {
  const usable = candidates.filter((c) => !isCooling(c.connectorId, now));
  if (usable.length === 0) return null;
  return { credential: usable[0], alternativesRemaining: usable.length - 1 };
}

/**
 * Map a classified vendor failure onto a cooldown reason.
 *
 * `null` means "not a credential problem" — a 500 from the vendor, a timeout, a
 * malformed response. Failing over on those would rotate through every key a
 * tenant owns because the vendor was having a bad minute, and leave all of them
 * cooling for a fault that was never theirs.
 */
export function cooldownReasonForFailure(args: {
  status?: number | null;
  classified?: 'insufficient_funds' | 'invalid_key' | null;
}): CooldownReason | null {
  if (args.classified === 'insufficient_funds') return 'exhausted';
  if (args.classified === 'invalid_key') return 'invalid_key';
  if (args.status === 429) return 'rate_limited';
  if (args.status === 401 || args.status === 403) return 'invalid_key';
  if (args.status === 402) return 'exhausted';
  return null;
}

/**
 * Read a vendor response for what it says about limits, and act on it.
 *
 * Called on EVERY response, not only failures — a vendor that says "3 calls
 * left" has told us something worth knowing before the fourth call fails, and
 * only the success path ever carries that.
 *
 * Never throws: this is observation, and a malformed header must not be able to
 * fail a request that otherwise worked.
 */
export function observeVendorResponse(args: {
  tenantId: string;
  vendor: string;
  connectorId: string;
  status: number;
  headers: { get(name: string): string | null };
  classified?: 'insufficient_funds' | 'invalid_key' | null;
}): void {
  try {
    const snapshot = parseRateLimitHeaders(args.headers);
    recordRateLimit({
      tenantId: args.tenantId,
      vendor: args.vendor,
      connectorId: args.connectorId,
      snapshot,
    });

    const reason = cooldownReasonForFailure({
      status: args.status,
      classified: args.classified ?? null,
    });
    if (!reason) {
      // A response that worked clears any cooldown this key was under. A key
      // that works is a key that works, and keeping it sidelined for the rest
      // of a window it has evidently left is a self-inflicted outage.
      if (args.status >= 200 && args.status < 300) markCredentialHealthy(args.connectorId);
      return;
    }

    markCredentialCooling({
      tenantId: args.tenantId,
      vendor: args.vendor,
      connectorId: args.connectorId,
      reason,
      // The vendor's own number beats any backoff we would invent.
      retryAfterMs: snapshot.retryAfterMs,
    });
  } catch {
    /* observation must never fail the call it rode in on */
  }
}
