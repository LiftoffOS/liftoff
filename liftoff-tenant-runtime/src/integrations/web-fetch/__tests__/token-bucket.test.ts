/**
 * Postgres-backed token-bucket unit tests (B1).
 *
 * Replaces the deleted in-memory WebToolRateLimiter — that limiter was
 * process-local and broke under multi-replica deployments. The new bucket
 * lives in Postgres so all replicas see the same state.
 *
 * Mocks the pg pool to verify the consumeToken contract. End-to-end
 * round-trip coverage against a real Postgres lives in
 * `token-bucket.integration.test.ts` (gated on TEST_DATABASE_URL).
 */

const mockQuery = jest.fn();
const mockPool = { query: mockQuery };
jest.mock('../../../infrastructure/database', () => ({
  getPool: jest.fn(() => mockPool),
}));

const mockGetVendorRatePerHour = jest.fn();
// `rateBudgetFor` is pure and is part of what the bucket key MEANS, so the real
// one is used; only the rate lookup (which reads flags over the network) is
// mocked. A hole here would have made every key in this file `undefined`.
jest.mock('../limits-config', () => ({
  ...jest.requireActual('../limits-config'),
  getVendorRatePerHour: (...args: unknown[]) => mockGetVendorRatePerHour(...args),
}));
// The real `getVendorBurst` reads the sentinel flags, and the real flag read
// reaches for a pool — which is the pool this file mocks per call, so leaving
// it live consumed the UPSERT's own mocked response. Stubbed at the FLAGS, so
// the burst defaults this file asserts are still the real table's.
jest.mock('../../../entitlements-client/service', () => ({
  getEntitlementsClient: () => ({ getFeatureFlags: async () => ({}) }),
}));
jest.mock('../../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { consumeToken, bucketKeyFor } from '../token-bucket';

beforeEach(() => {
  mockQuery.mockReset();
  mockGetVendorRatePerHour.mockReset();
});

describe('consumeToken', () => {
  it('passes through with ok:true when no rate is configured for the vendor/tool pair', async () => {
    mockGetVendorRatePerHour.mockResolvedValue(undefined);
    const r = await consumeToken('t', 'webclaw', 'web_unknown');
    expect(r.ok).toBe(true);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('issues the UPSERT and returns ok:true when the bucket commits a row', async () => {
    mockGetVendorRatePerHour.mockResolvedValue(10);
    mockQuery.mockResolvedValueOnce({ rows: [{ tokens: 9 }] });
    const r = await consumeToken('t', 'anchor', 'web_task');
    expect(r.ok).toBe(true);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO token_buckets/);
    expect(sql).toMatch(/ON CONFLICT \(bucket_key\) DO UPDATE/);
    expect(params).toEqual(['t:anchor:web_task', 10, 10 / 3600]);
  });

  it('WAITS for a token the bucket will have shortly, rather than refusing', async () => {
    // The behaviour the vendor's real ceiling requires. Perplexity's Agent API
    // admits one request a second; refusing a call that one second would have
    // admitted sends the vendor's own pacing to the model as a tool failure,
    // which is how a 429 reached a live run twelve times.
    mockGetVendorRatePerHour.mockResolvedValue(3600);
    mockQuery
      .mockResolvedValueOnce({ rows: [] })                       // empty
      .mockResolvedValueOnce({                                   // ...for ~100ms
        rows: [{ tokens: 0, refill_rate_per_sec: 1, last_refilled_at: new Date(Date.now() - 900).toISOString() }],
      })
      .mockResolvedValueOnce({ rows: [{ tokens: 0 }] });         // refilled
    const r = await consumeToken('t', 'webclaw', 'web_fetch_advanced');
    expect(r.ok).toBe(true);
    expect(mockQuery.mock.calls.length).toBe(3);
  });

  it('refuses at once when the token is further away than the caller will wait', async () => {
    // A bucket whose refill is an hour out is a refusal, not a wait: holding
    // the call would outlast the call itself. The figure still travels so the
    // caller can say how long.
    mockGetVendorRatePerHour.mockResolvedValue(1);
    mockQuery.mockResolvedValue({ rows: [] });
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ tokens: 0, refill_rate_per_sec: 1 / 3600, last_refilled_at: new Date().toISOString() }],
      });
    const r = await consumeToken('t', 'webclaw', 'web_fetch_advanced');
    expect(r.ok).toBe(false);
    expect(r.retryAfterMs).toBeGreaterThan(5_000);
  });

  it('handles the (rare) race where the row vanished between UPSERT and SELECT', async () => {
    // The row is gone, so the deficit is unknowable and the fallback is a
    // second. Inside the wait budget, so the call is retried rather than
    // refused — and a vanished row means the next UPSERT re-creates it full.
    mockGetVendorRatePerHour.mockResolvedValue(5);
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ tokens: 4 }] });
    const r = await consumeToken('t', 'anchor', 'web_research');
    expect(r.ok).toBe(true);
  });

  it('gives up after the wait budget rather than holding a call forever', async () => {
    mockGetVendorRatePerHour.mockResolvedValue(5);
    // Always empty, always a short deficit: the only thing that ends this is
    // the budget.
    mockQuery.mockImplementation((sql: string) => Promise.resolve(
      /INSERT INTO/.test(sql)
        ? { rows: [] }
        : { rows: [{ tokens: 0, refill_rate_per_sec: 100, last_refilled_at: new Date().toISOString() }] },
    ));
    const started = Date.now();
    const r = await consumeToken('t', 'anchor', 'web_research');
    expect(r.ok).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(4_000);
  }, 15_000);
});

describe('the bucket key', () => {
  it('is shared by every tool on one vendor endpoint', () => {
    // Four tool names, one POST /v1/agent, one ceiling. Each of them used to
    // get its own bucket against a limit that belongs to the endpoint.
    const keys = ['web_fetch_advanced', 'web_research', 'web_people_search', 'web_finance_search']
      .map((t) => bucketKeyFor('tenant-a', 'perplexity', t));
    expect(new Set(keys).size).toBe(1);
  });

  it('drops the tenant for a vendor whose key every tenant shares', () => {
    // A customer cannot hold a key for our Perplexity account, so there is one
    // key and one ceiling. A per-tenant bucket against it permits the real
    // ceiling multiplied by the tenant count, which is not a limit.
    expect(bucketKeyFor('tenant-a', 'perplexity', 'web_finance_search'))
      .toBe(bucketKeyFor('tenant-b', 'perplexity', 'web_finance_search'));
    expect(bucketKeyFor('tenant-a', 'perplexity', 'web_finance_search')).toMatch(/^platform:/);
  });

  it('keeps the tenant for a vendor a customer can hold a key for', () => {
    // Here the ceiling really is per key and each tenant may have its own, so
    // one tenant's traffic must not close the window on another's.
    expect(bucketKeyFor('tenant-a', 'exa', 'web_fetch_advanced'))
      .not.toBe(bucketKeyFor('tenant-b', 'exa', 'web_fetch_advanced'));
  });

  it('keeps separate endpoints on separate budgets', () => {
    expect(bucketKeyFor('t', 'perplexity', 'web_search'))
      .not.toBe(bucketKeyFor('t', 'perplexity', 'web_finance_search'));
    expect(bucketKeyFor('t', 'perplexity', 'web_deep_research'))
      .not.toBe(bucketKeyFor('t', 'perplexity', 'web_finance_search'));
  });
});

describe('the wait budget belongs to the caller', () => {
  it('refuses at once when the caller says it will not wait', async () => {
    // What the router passes when the next vendor in the chain could serve the
    // call now. Holding it here while a different backend is free is strictly
    // worse than moving on, so the bucket must not decide to wait on its own.
    mockGetVendorRatePerHour.mockResolvedValue(3600);
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ tokens: 0, refill_rate_per_sec: 1, last_refilled_at: new Date(Date.now() - 900).toISOString() }],
      });
    const started = Date.now();
    const r = await consumeToken('t', 'perplexity', 'web_fetch_advanced', 0);
    expect(r.ok).toBe(false);
    expect(r.retryAfterMs).toBeGreaterThan(0);
    expect(Date.now() - started).toBeLessThan(200);
    expect(mockQuery.mock.calls.length).toBe(2);
  });

  it('waits when the caller gives it a budget', async () => {
    mockGetVendorRatePerHour.mockResolvedValue(3600);
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ tokens: 0, refill_rate_per_sec: 1, last_refilled_at: new Date(Date.now() - 900).toISOString() }],
      })
      .mockResolvedValueOnce({ rows: [{ tokens: 0 }] });
    expect((await consumeToken('t', 'perplexity', 'web_finance_search', 5_000)).ok).toBe(true);
  });
});

describe('capacity is the vendor\'s BURST, not the hour\'s allowance', () => {
  // The hole this closes. `capacity = ratePerHour` meant a 1-RPS vendor's
  // bucket opened with 3,600 tokens: 3,600 calls admitted back to back, and a
  // run of a hundred never reached the pacing at all. The rate was right and
  // paced nothing, which is indistinguishable from having no bucket — and the
  // vendor went on answering 429.
  //
  // Asserted on the SQL parameters, because that is where capacity is decided
  // and the bucket's own arithmetic lives in Postgres.
  const paramsOf = (call: unknown[]) => call[1] as [string, number, number];

  it('opens a Perplexity Agent-API bucket with room for ONE call', async () => {
    mockGetVendorRatePerHour.mockResolvedValue(3_600);
    mockQuery.mockResolvedValueOnce({ rows: [{ tokens: 0 }] });
    await consumeToken('t', 'perplexity', 'web_finance_search');
    const [key, capacity, refillPerSec] = paramsOf(mockQuery.mock.calls[0]);
    expect(capacity).toBe(1);
    // ...while still refilling at the sustained rate, one a second.
    expect(refillPerSec).toBeCloseTo(1, 6);
    expect(key).toBe('platform:perplexity:perplexity_agent_api');
  });

  it('never lets an hour of Agent-API calls burst at once', async () => {
    // The literal defect: 3_600 as a capacity.
    mockGetVendorRatePerHour.mockResolvedValue(3_600);
    mockQuery.mockResolvedValueOnce({ rows: [{ tokens: 0 }] });
    await consumeToken('t', 'perplexity', 'web_fetch_advanced');
    expect(paramsOf(mockQuery.mock.calls[0])[1]).not.toBe(3_600);
  });

  it('leaves a vendor that publishes no burst exactly as it was', async () => {
    // Every other vendor's ceiling is far above our traffic, and changing
    // their capacity would throttle paying usage for no reason.
    mockGetVendorRatePerHour.mockResolvedValue(600);
    mockQuery.mockResolvedValueOnce({ rows: [{ tokens: 599 }] });
    await consumeToken('t', 'exa', 'web_fetch_advanced');
    expect(paramsOf(mockQuery.mock.calls[0])[1]).toBe(600);
  });

  it("a Perplexity tool on its OWN endpoint keeps its own burst", async () => {
    // web_search is POST /search at 50 RPS; capping it at one would throttle a
    // tool the vendor never rate-limited.
    mockGetVendorRatePerHour.mockResolvedValue(180_000);
    mockQuery.mockResolvedValueOnce({ rows: [{ tokens: 1 }] });
    await consumeToken('t', 'perplexity', 'web_search');
    expect(paramsOf(mockQuery.mock.calls[0])[1]).toBe(180_000);
  });
});
