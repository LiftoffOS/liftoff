// In-memory per-IP rate limiting for the public OAuth endpoints (plan v6.1
// Phase 3, v2.1 trim decision: per-instance in-memory is sufficient — the
// 10-instance fan-out bounds global throughput to 10× the per-instance
// limit, and the guessable secrets are 256-bit random so brute force is not
// a real vector; the limit only guards registration spam. Escalation path
// if real abuse appears is Cloud Armor at the edge, never a DB limiter.)
//
// Exact numbers (plan): register 5/min + 20/day per IP; token 30/min per IP;
// client configuration (RFC 7592, the registration_client_uri) 10/min per IP.
//
// The device flow (RFC 8628) adds three more. Device polls are NOT under the
// token limiter: three clients polling at the advertised 5 s behind one
// address already make 36 requests a minute, and a 429 `rate_limited` is not
// one of the errors a polling client continues through, so it could give up
// on a valid session. The per-code interval is the protocol's own rate
// control; the per-IP ceiling here only catches a runaway client and answers
// `slow_down`, which a client is required to honour. The lookup of a user
// code is limited per IP here and per account in the consent router, because
// an eight-character code is guessable in principle (RFC 8628 §5.1).

import type { Request, Response, NextFunction } from 'express';

interface WindowEntry {
  count: number;
  windowStart: number;
}

const stores = new Map<string, Map<string, WindowEntry>>();

function check(storeKey: string, ip: string, max: number, windowMs: number): { allowed: boolean; retryAfterSec: number } {
  let store = stores.get(storeKey);
  if (!store) {
    store = new Map();
    stores.set(storeKey, store);
  }
  const now = Date.now();
  // Bound memory (audit GAP-8): drop expired entries once a store grows
  // beyond a nuisance threshold.
  if (store.size > 10_000) {
    for (const [k, v] of store) {
      if (now - v.windowStart > windowMs) store.delete(k);
    }
  }
  const entry = store.get(ip);
  if (!entry || now - entry.windowStart > windowMs) {
    store.set(ip, { count: 1, windowStart: now });
    return { allowed: true, retryAfterSec: 0 };
  }
  if (entry.count >= max) {
    return { allowed: false, retryAfterSec: Math.ceil((entry.windowStart + windowMs - now) / 1000) };
  }
  entry.count++;
  return { allowed: true, retryAfterSec: 0 };
}

function limitMiddleware(
  limits: Array<{ storeKey: string; max: number; windowMs: number }>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = req.ip ?? 'unknown';
    for (const l of limits) {
      const result = check(l.storeKey, ip, l.max, l.windowMs);
      if (!result.allowed) {
        res.setHeader('Retry-After', String(result.retryAfterSec));
        res.status(429).json({ error: 'rate_limited', retryAfter: result.retryAfterSec });
        return;
      }
    }
    next();
  };
}

export const registerRateLimit = limitMiddleware([
  { storeKey: 'register-min', max: 5, windowMs: 60_000 },
  { storeKey: 'register-day', max: 20, windowMs: 24 * 60 * 60_000 },
]);

/** The client configuration endpoint (RFC 7592): a DELETE is authenticated
 *  by a 256-bit registration access token, so this only bounds guessing. */
export const clientConfigRateLimit = limitMiddleware([
  { storeKey: 'client-config-min', max: 10, windowMs: 60_000 },
]);

const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

const tokenLimit = limitMiddleware([
  { storeKey: 'token-min', max: 30, windowMs: 60_000 },
]);

/** The token limiter, which device polls bypass (see the header). The body
 *  is parsed before this runs, so the grant type is readable. */
export const tokenRateLimit = (req: Request, res: Response, next: NextFunction): void => {
  const grantType = (req.body as Record<string, unknown> | undefined)?.grant_type;
  if (grantType === DEVICE_CODE_GRANT) {
    devicePollRateLimit(req, res, next);
    return;
  }
  tokenLimit(req, res, next);
};

/** A ceiling on device polls per address that answers the protocol's own
 *  back-off error rather than a bare 429. */
export const devicePollRateLimit = (req: Request, res: Response, next: NextFunction): void => {
  const ip = req.ip ?? 'unknown';
  const result = check('device-poll-min', ip, 120, 60_000);
  if (!result.allowed) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(400).json({ error: 'slow_down' });
    return;
  }
  next();
};

export const deviceAuthorizationRateLimit = limitMiddleware([
  { storeKey: 'device-authz-min', max: 10, windowMs: 60_000 },
  { storeKey: 'device-authz-day', max: 100, windowMs: 24 * 60 * 60_000 },
]);

export const deviceLookupRateLimit = limitMiddleware([
  { storeKey: 'device-lookup-min', max: 10, windowMs: 60_000 },
]);

/** The same window counter keyed on something other than the address: the
 *  consent router counts a person's user-code guesses per account. */
export function checkWindow(storeKey: string, key: string, max: number, windowMs: number): { allowed: boolean; retryAfterSec: number } {
  return check(storeKey, key, max, windowMs);
}
