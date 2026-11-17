// More than one key for the same vendor, and knowing when one is spent.
//
// Two properties carry the risk. First, failing over for the WRONG reason: a
// vendor having a bad minute must not rotate a tenant through every key they
// own and leave all of them cooling for a fault that was never theirs. Second,
// going quiet: when the last key is spent, the person still has to be told —
// the pool changes when they hear it, never whether.

import {
  DEFAULT_RATE_LIMIT_COOLDOWN_MS,
  EXHAUSTED_COOLDOWN_MS,
  INVALID_KEY_COOLDOWN_MS,
  _resetCredentialPoolForTesting,
  cooldownReason,
  cooldownReasonForFailure,
  isCooling,
  markCredentialCooling,
  markCredentialHealthy,
  observeVendorResponse,
  parseRateLimitHeaders,
  recordRateLimit,
  selectCredential,
} from '../credential-pool';

const warn = jest.fn();
const info = jest.fn();
jest.mock('../../../infrastructure/logging', () => ({
  logger: { warn: (...a: unknown[]) => warn(...a), info: (...a: unknown[]) => info(...a), error: jest.fn() },
}));

const headers = (h: Record<string, string>) => ({
  get: (name: string) => h[name.toLowerCase()] ?? null,
});

const cred = (id: string) => ({ connectorId: id, apiKey: `key-${id}`, extra: {} });

beforeEach(() => {
  jest.clearAllMocks();
  _resetCredentialPoolForTesting();
});

describe('reading what the vendor said', () => {
  it('reads the common spelling', () => {
    const s = parseRateLimitHeaders(headers({ 'x-ratelimit-remaining': '7', 'x-ratelimit-limit': '100' }));
    expect(s.remaining).toBe(7);
    expect(s.limit).toBe(100);
  });

  it('reads the un-prefixed spelling too', () => {
    const s = parseRateLimitHeaders(headers({ 'ratelimit-remaining': '3', 'ratelimit-limit': '50' }));
    expect(s.remaining).toBe(3);
    expect(s.limit).toBe(50);
  });

  it('honours retry-after', () => {
    expect(parseRateLimitHeaders(headers({ 'retry-after': '30' })).retryAfterMs).toBe(30_000);
  });

  it('reads a reset given as seconds from now', () => {
    const s = parseRateLimitHeaders(headers({ 'x-ratelimit-reset': '45' }));
    expect(s.retryAfterMs).toBeGreaterThan(40_000);
    expect(s.retryAfterMs).toBeLessThanOrEqual(45_000);
  });

  it('reads a reset given as epoch seconds', () => {
    const future = Math.floor(Date.now() / 1000) + 120;
    const s = parseRateLimitHeaders(headers({ 'x-ratelimit-reset': String(future) }));
    expect(s.retryAfterMs).toBeGreaterThan(110_000);
    expect(s.retryAfterMs).toBeLessThanOrEqual(120_000);
  });

  it('reads a reset given as epoch milliseconds', () => {
    const future = Date.now() + 90_000;
    const s = parseRateLimitHeaders(headers({ 'x-ratelimit-reset': String(future) }));
    expect(s.retryAfterMs).toBeGreaterThan(80_000);
    expect(s.retryAfterMs).toBeLessThanOrEqual(90_000);
  });

  it('says "not stated" rather than zero for a missing header', () => {
    // The difference decides whether a key is set aside. Zero remaining would
    // sideline a perfectly healthy key on every request.
    const s = parseRateLimitHeaders(headers({}));
    expect(s.remaining).toBeNull();
    expect(s.limit).toBeNull();
    expect(s.retryAfterMs).toBeNull();
  });

  it('ignores a header that is not a number', () => {
    expect(parseRateLimitHeaders(headers({ 'x-ratelimit-remaining': 'lots' })).remaining).toBeNull();
  });
});

describe('surfacing the limits', () => {
  it('says nothing when the vendor said nothing', () => {
    recordRateLimit({ tenantId: 't', vendor: 'exa', connectorId: 'c1', snapshot: parseRateLimitHeaders(headers({})) });
    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns when a key is nearly out of its window', () => {
    recordRateLimit({
      tenantId: 't', vendor: 'exa', connectorId: 'c1',
      snapshot: parseRateLimitHeaders(headers({ 'x-ratelimit-remaining': '5', 'x-ratelimit-limit': '100' })),
    });
    expect(warn).toHaveBeenCalled();
  });

  it('never logs the key itself', () => {
    // Only the connector id. A secret in a log line outlives every request it
    // was ever used on.
    recordRateLimit({
      tenantId: 't', vendor: 'exa', connectorId: 'c1',
      snapshot: parseRateLimitHeaders(headers({ 'x-ratelimit-remaining': '5', 'x-ratelimit-limit': '100' })),
    });
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/apiKey|key-/);
  });
});

describe('what counts as a credential problem', () => {
  it('treats a 429 as one', () => {
    expect(cooldownReasonForFailure({ status: 429 })).toBe('rate_limited');
  });

  it('treats a rejection as one', () => {
    expect(cooldownReasonForFailure({ status: 401 })).toBe('invalid_key');
    expect(cooldownReasonForFailure({ status: 403 })).toBe('invalid_key');
  });

  it('treats payment as one', () => {
    expect(cooldownReasonForFailure({ status: 402 })).toBe('exhausted');
  });

  it('does NOT treat a vendor 500 as one', () => {
    // Failing over here would rotate through every key a tenant owns because
    // the vendor was having a bad minute, and leave all of them cooling for a
    // fault that was never theirs.
    expect(cooldownReasonForFailure({ status: 500 })).toBeNull();
    expect(cooldownReasonForFailure({ status: 503 })).toBeNull();
  });

  it('does not treat a success as one', () => {
    expect(cooldownReasonForFailure({ status: 200 })).toBeNull();
  });

  it('prefers an explicit classification over the status', () => {
    expect(cooldownReasonForFailure({ status: 500, classified: 'insufficient_funds' })).toBe('exhausted');
  });
});

describe('cooldowns', () => {
  it('sets a key aside', () => {
    markCredentialCooling({ tenantId: 't', vendor: 'exa', connectorId: 'c1', reason: 'rate_limited' });
    expect(isCooling('c1')).toBe(true);
    expect(cooldownReason('c1')).toBe('rate_limited');
  });

  it('sets an out-of-credit key aside for far longer than a rate-limited one', () => {
    // Topping up an account is a human act on a human timescale; retrying every
    // minute in the meantime is a request that cannot succeed.
    expect(EXHAUSTED_COOLDOWN_MS).toBeGreaterThan(DEFAULT_RATE_LIMIT_COOLDOWN_MS * 5);
    expect(INVALID_KEY_COOLDOWN_MS).toBeGreaterThan(EXHAUSTED_COOLDOWN_MS);
  });

  it('honours the vendor\'s own number over our default', () => {
    const until = markCredentialCooling({
      tenantId: 't', vendor: 'exa', connectorId: 'c1', reason: 'rate_limited', retryAfterMs: 5_000,
    });
    expect(until - Date.now()).toBeLessThan(DEFAULT_RATE_LIMIT_COOLDOWN_MS);
  });

  it('caps how long it believes a retry-after', () => {
    // A vendor asking for a day is describing a quota. The cap bounds how long
    // we believe the header, not how long the quota lasts.
    const until = markCredentialCooling({
      tenantId: 't', vendor: 'exa', connectorId: 'c1', reason: 'rate_limited',
      retryAfterMs: 24 * 60 * 60 * 1000,
    });
    expect(until - Date.now()).toBeLessThanOrEqual(15 * 60_000 + 100);
  });

  it('expires', () => {
    markCredentialCooling({ tenantId: 't', vendor: 'exa', connectorId: 'c1', reason: 'rate_limited' });
    expect(isCooling('c1', Date.now() + DEFAULT_RATE_LIMIT_COOLDOWN_MS + 1)).toBe(false);
  });

  it('is cleared by a success', () => {
    markCredentialCooling({ tenantId: 't', vendor: 'exa', connectorId: 'c1', reason: 'rate_limited' });
    markCredentialHealthy('c1');
    expect(isCooling('c1')).toBe(false);
  });
});

describe('choosing a key', () => {
  it('takes the first one', () => {
    // The tenant's own order, so which key gets used is stable and explicable
    // rather than whichever happened to be least recently tried.
    const s = selectCredential([cred('a'), cred('b')]);
    expect(s?.credential.connectorId).toBe('a');
    expect(s?.alternativesRemaining).toBe(1);
  });

  it('skips a cooling key and uses the next one', () => {
    // The whole point: a second connected account should not sit unused while
    // every run fails on the first.
    markCredentialCooling({ tenantId: 't', vendor: 'exa', connectorId: 'a', reason: 'exhausted' });
    expect(selectCredential([cred('a'), cred('b')])?.credential.connectorId).toBe('b');
  });

  it('reports when it is down to the last key', () => {
    markCredentialCooling({ tenantId: 't', vendor: 'exa', connectorId: 'a', reason: 'exhausted' });
    expect(selectCredential([cred('a'), cred('b')])?.alternativesRemaining).toBe(0);
  });

  it('returns nothing when every key is cooling', () => {
    // The caller's cue to raise the same error it always did, so the person
    // still hears about their spent account.
    markCredentialCooling({ tenantId: 't', vendor: 'exa', connectorId: 'a', reason: 'exhausted' });
    markCredentialCooling({ tenantId: 't', vendor: 'exa', connectorId: 'b', reason: 'exhausted' });
    expect(selectCredential([cred('a'), cred('b')])).toBeNull();
  });

  it('behaves exactly as before for a tenant with one key', () => {
    expect(selectCredential([cred('a')])?.credential.connectorId).toBe('a');
    markCredentialCooling({ tenantId: 't', vendor: 'exa', connectorId: 'a', reason: 'rate_limited' });
    expect(selectCredential([cred('a')])).toBeNull();
  });
});

describe('observing a response', () => {
  const base = { tenantId: 't', vendor: 'exa', connectorId: 'c1' };

  it('sets the key aside on a 429, with the vendor\'s own delay', () => {
    observeVendorResponse({ ...base, status: 429, headers: headers({ 'retry-after': '5' }) });
    expect(isCooling('c1')).toBe(true);
    expect(isCooling('c1', Date.now() + 6_000)).toBe(false);
  });

  it('leaves the key alone on a vendor 500', () => {
    observeVendorResponse({ ...base, status: 503, headers: headers({}) });
    expect(isCooling('c1')).toBe(false);
  });

  it('clears a cooldown on a success', () => {
    markCredentialCooling({ ...base, reason: 'rate_limited' });
    observeVendorResponse({ ...base, status: 200, headers: headers({}) });
    expect(isCooling('c1')).toBe(false);
  });

  it('records limits on the success path, where they usually live', () => {
    observeVendorResponse({
      ...base, status: 200,
      headers: headers({ 'x-ratelimit-remaining': '2', 'x-ratelimit-limit': '100' }),
    });
    expect(warn).toHaveBeenCalled();
  });

  it('never throws on a malformed header', () => {
    // Observation must not be able to fail a request that otherwise worked.
    expect(() => observeVendorResponse({
      ...base, status: 200,
      headers: { get: () => { throw new Error('bad header'); } },
    })).not.toThrow();
  });
});

describe('the wiring', () => {
  const read = (f: string): string =>
    require('fs').readFileSync(require('path').join(__dirname, '..', f), 'utf8') as string;

  it('resolves from the whole pool, not the first connector found', () => {
    const src = read('web-tool-secrets.ts');
    expect(src).toMatch(/listTenantConnectors\(/);
    expect(src).toMatch(/selectCredential\(/);
    // The old single-row lookup is gone, not merely unused.
    expect(src).not.toMatch(/lookupTenantConnector\(/);
  });

  it('still raises a BYOK error when every key is spent', () => {
    // Going quiet would be worse than the original behaviour: the run would
    // fail with nothing telling the person their account needs topping up.
    const src = read('web-tool-secrets.ts');
    expect(src).toMatch(/every BYOK key for this vendor is in cooldown/);
    expect(src).toMatch(/throw new VendorConnectorErrored\(/);
  });

  it('survives one unreadable credential among several', () => {
    // Otherwise a single broken row costs the tenant the keys that do work,
    // which is the whole reason they connected more than one.
    expect(read('web-tool-secrets.ts')).toMatch(/continuing with the rest/);
  });

  it('observes every strict vendor response', () => {
    for (const f of ['firecrawl-client.ts', 'exa-client.ts', 'tavily-client.ts', 'webclaw-client.ts', 'anchor-client.ts']) {
      expect(read(f)).toMatch(/observeVendorResponse\(/);
    }
    // Browserbase goes through its SDK, so there is no Response to read
    // headers off — it cools on the classified status instead.
    expect(read('browserbase-client.ts')).toMatch(/markCredentialCooling\(/);
  });

  it('cools a spent key before the RPC that flips the connector row', () => {
    // The RPC and the cache TTL behind it both take time; a tenant with two
    // accounts should not lose a single call to a key that already said it is
    // spent.
    const src = read('byok-error-handler.ts');
    expect(src.indexOf('markCredentialCooling(')).toBeLessThan(src.indexOf('markConnectorError({'));
  });
});
