import { WebToolRateLimiter } from '../rate-limiter';

describe('WebToolRateLimiter', () => {
  it('allows requests below the per-tool hourly limit', () => {
    const rl = new WebToolRateLimiter();
    for (let i = 0; i < 5; i++) {
      expect(rl.checkRateLimit('t', 'a', 'web_research').ok).toBe(true);
    }
  });

  it('rejects after the limit is reached', () => {
    const rl = new WebToolRateLimiter();
    // web_research limit = 5/hour
    for (let i = 0; i < 5; i++) rl.checkRateLimit('t', 'a', 'web_research');
    const next = rl.checkRateLimit('t', 'a', 'web_research');
    expect(next.ok).toBe(false);
    expect(next.resetAt).toBeGreaterThan(Date.now());
  });

  it('isolates buckets per tenant + agent + tool', () => {
    const rl = new WebToolRateLimiter();
    for (let i = 0; i < 5; i++) rl.checkRateLimit('t', 'a', 'web_research');
    // Different agent must not be throttled.
    expect(rl.checkRateLimit('t', 'b', 'web_research').ok).toBe(true);
    // Different tool must not be throttled.
    expect(rl.checkRateLimit('t', 'a', 'web_fetch_advanced').ok).toBe(true);
  });

  it('passes through unknown tool names (no configured limit)', () => {
    const rl = new WebToolRateLimiter();
    for (let i = 0; i < 1000; i++) {
      expect(rl.checkRateLimit('t', 'a', 'web_unknown').ok).toBe(true);
    }
  });

  it('pruneExpired drops expired buckets', () => {
    const rl = new WebToolRateLimiter();
    rl.checkRateLimit('t', 'a', 'web_diff');
    // Force-expire by reaching into private state.
    const buckets = (rl as unknown as { buckets: Map<string, { resetAt: number }> }).buckets;
    for (const b of buckets.values()) b.resetAt = Date.now() - 1000;
    const pruned = rl.pruneExpired();
    expect(pruned).toBeGreaterThanOrEqual(1);
  });
});
