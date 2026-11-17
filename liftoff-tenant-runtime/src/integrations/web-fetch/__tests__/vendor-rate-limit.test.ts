/**
 * A vendor 429 is a wait, and the wait reaches the model.
 *
 * Twelve `web_finance_search` calls in one live run failed with
 * `Perplexity 429: request_rate_limit_exceeded`, and every one of them reached
 * the model as:
 *
 *   {"code":"internal_error","retryable":false,
 *    "recovery":"...Repeating the identical call is not expected to help..."}
 *
 * The response carrying that 429 had `retry-after: 1` on it. The model obeyed
 * what we told it, changed approach six times, and the run hit its wall clock
 * with no report.
 *
 * Two properties, and the second is why this file reads the status rather than
 * the class name: `classifyWebToolError` knew nine error classes and not the
 * one the failure arrived in, and `router.isRateLimited` named three of the
 * thirteen. Enumerating is the defect.
 */
import { vendorRateLimit, retryAfterFromSnapshot } from '../vendor-rate-limit';
import { parseRateLimitHeaders } from '../credential-pool';
import { PerplexityError } from '../perplexity-client';
import { ExaError } from '../exa-client';

/** The headers the live vendor actually sent, verbatim from a 429 probe. */
const LIVE_429_HEADERS = new Headers({ 'retry-after': '1' });

describe('a vendor that refused on rate says so, whatever class it threw', () => {
  it('reads a Perplexity 429 with the wait it asked for', () => {
    const err = new PerplexityError('Perplexity 429: {...}', 429, '{...}', 1_000);
    expect(vendorRateLimit(err)).toEqual({ retryAfterMs: 1_000 });
  });

  it('reads a vendor class nobody enumerated', () => {
    // The point of the structural read: this passes without ExaError being
    // named anywhere, and so would a vendor added next week.
    expect(vendorRateLimit(new ExaError('Exa 429', 429))).toEqual({ retryAfterMs: 1_000 });
  });

  it('falls back to one second when the vendor said nothing', () => {
    // The shortest window any of these vendors meters on, so the smallest wait
    // that can change the answer. Never zero: a wait of zero is a busy loop.
    expect(vendorRateLimit(new PerplexityError('429', 429))).toEqual({ retryAfterMs: 1_000 });
  });

  it('is not a rate limit on any other status', () => {
    for (const status of [0, 400, 401, 402, 404, 408, 422, 500, 503]) {
      expect(vendorRateLimit(new PerplexityError(`${status}`, status))).toBeNull();
    }
  });

  it('is not confused by a non-error', () => {
    for (const v of [null, undefined, 'Perplexity 429', 429, {}]) {
      expect(vendorRateLimit(v)).toBeNull();
    }
  });

  it('never reports a wait longer than a run would hold for', () => {
    const err = new PerplexityError('429', 429, '', 3_600_000);
    expect(vendorRateLimit(err)!.retryAfterMs).toBe(60_000);
  });
});

describe('the header the client used to discard', () => {
  it('reads retry-after off the live response shape', () => {
    expect(retryAfterFromSnapshot(parseRateLimitHeaders(LIVE_429_HEADERS))).toBe(1_000);
  });

  it('stays undefined when the response said nothing, rather than guessing', () => {
    // A guess here would be indistinguishable from the vendor's own number one
    // layer up, which is where the fallback belongs.
    expect(retryAfterFromSnapshot(parseRateLimitHeaders(new Headers()))).toBeUndefined();
  });

  it('reads the reset clock when only that is sent', () => {
    // The 200 responses carry x-ratelimit-reset and no retry-after.
    const at = Math.floor(Date.now() / 1000) + 1;
    const ms = retryAfterFromSnapshot(parseRateLimitHeaders(new Headers({
      'x-ratelimit-limit': '1', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(at),
    })));
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(2_000);
  });
});
