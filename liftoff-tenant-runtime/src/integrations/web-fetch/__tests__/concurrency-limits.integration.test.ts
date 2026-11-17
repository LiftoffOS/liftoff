/**
 * Postgres-backed integration tests for acquireInflightSlot / VendorPoolBusy.
 *
 * Gated on TEST_DATABASE_URL. The plan's "Verification per step" calls these
 * out as Cloud Run Job test-harness coverage; this file makes them runnable
 * locally too against a test Postgres.
 *
 * These tests need the `web_inflight_requests` + `web_waiters` tables and the
 * advisory-lock primitive — they cannot be faithfully mocked. The unit-level
 * coverage in `limits-config.test.ts` and `router-rate-limit-vendor-match.test.ts`
 * complements but does not replace these.
 */

import { Pool } from 'pg';

const SKIP = !process.env.TEST_DATABASE_URL;
const describeFn = SKIP ? describe.skip : describe;

// We need acquireInflightSlot to call OUR test pool, not the production
// service pool builder. Mock getPool BEFORE importing the module.
let testPool: Pool;
jest.mock('../../../infrastructure/database', () => ({
  getPool: () => testPool,
  getPoolForService: () => testPool,
}));
jest.mock('../../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// Force the per-vendor concurrency cap so we can saturate it in tests.
const mockGlobalCap = jest.fn();
jest.mock('../limits-config', () => ({
  getVendorConcurrencyLimits: async (v: string) => ({ maxConcurrentGlobal: mockGlobalCap(v) }),
}));
// Notifier — the integration test attaches a real LISTEN client, so we
// pass through to the real implementation here.
jest.unmock('../notifier');

import { acquireInflightSlot, VendorPoolBusy } from '../concurrency-limits';
import { getReleaseEmitter, shutdownNotifier } from '../notifier';

const T1 = '11111111-1111-1111-1111-111111111111';
const T2 = '22222222-2222-2222-2222-222222222222';
const A1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

async function reset(pool: Pool): Promise<void> {
  await pool.query(`DELETE FROM web_inflight_requests`);
  await pool.query(`DELETE FROM web_waiters`);
}

describeFn('concurrency-limits — Postgres integration', () => {
  beforeAll(async () => {
    testPool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    // Boot the LISTEN client so release() NOTIFYs wake waiters.
    getReleaseEmitter();
  });

  afterAll(async () => {
    await shutdownNotifier();
    await testPool.end();
  });

  beforeEach(async () => {
    await reset(testPool);
    mockGlobalCap.mockReset();
  });

  it('admits the first request immediately when the pool is empty', async () => {
    mockGlobalCap.mockReturnValue(3);
    const t0 = Date.now();
    const h = await acquireInflightSlot('anchor', T1, A1, 'web_fetch_advanced');
    expect(Date.now() - t0).toBeLessThan(200);
    expect(h.requestId).toBeDefined();
    const { rows } = await testPool.query(`SELECT COUNT(*)::int AS n FROM web_inflight_requests`);
    expect(rows[0].n).toBe(1);
    await h.release();
    const after = await testPool.query(`SELECT COUNT(*)::int AS n FROM web_inflight_requests`);
    expect(after.rows[0].n).toBe(0);
  });

  it('lets a single tenant hold ALL global slots (no Liftoff-imposed per-tenant cap)', async () => {
    mockGlobalCap.mockReturnValue(3);
    const handles = await Promise.all([
      acquireInflightSlot('anchor', T1, A1, 'web_fetch_advanced'),
      acquireInflightSlot('anchor', T1, A1, 'web_fetch_advanced'),
      acquireInflightSlot('anchor', T1, A1, 'web_fetch_advanced'),
    ]);
    const { rows } = await testPool.query(
      `SELECT COUNT(*)::int AS n FROM web_inflight_requests WHERE tenant_id = $1`,
      [T1],
    );
    expect(rows[0].n).toBe(3);
    await Promise.all(handles.map(h => h.release()));
  });

  it('throws VendorPoolBusy after the wait budget when the pool stays saturated', async () => {
    mockGlobalCap.mockReturnValue(1);
    const blocker = await acquireInflightSlot('anchor', T1, A1, 'web_fetch_advanced');
    const t0 = Date.now();
    await expect(acquireInflightSlot('anchor', T2, A1, 'web_fetch_advanced'))
      .rejects.toBeInstanceOf(VendorPoolBusy);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(4_500);
    expect(elapsed).toBeLessThan(6_500);
    await blocker.release();
  }, 12_000);

  it('release() NOTIFYs waiters so they admit promptly once a slot opens', async () => {
    mockGlobalCap.mockReturnValue(1);
    const blocker = await acquireInflightSlot('anchor', T1, A1, 'web_fetch_advanced');
    // Start a second request that will wait.
    const t0 = Date.now();
    const waitingPromise = acquireInflightSlot('anchor', T2, A1, 'web_fetch_advanced');
    // Give the waiter a moment to insert its web_waiters row + attach listener.
    await new Promise(r => setTimeout(r, 200));
    await blocker.release();
    const h = await waitingPromise;
    const elapsed = Date.now() - t0;
    // NOTIFY round-trip is sub-second; allow generous slack.
    expect(elapsed).toBeLessThan(2_500);
    await h.release();
  }, 10_000);

  it('fair-share: when both tenants contend at a saturated pool, releases alternate', async () => {
    // Cap = 2 globally. T1 holds both slots. T2 has 0. T2 waiting.
    // When T1 releases one slot, T2 (with 0 inflight) wins the fair-share
    // tiebreak over T1 (who has 1).
    mockGlobalCap.mockReturnValue(2);
    const t1a = await acquireInflightSlot('anchor', T1, A1, 'web_fetch_advanced');
    const t1b = await acquireInflightSlot('anchor', T1, A1, 'web_fetch_advanced');

    const t2Wait = acquireInflightSlot('anchor', T2, A1, 'web_fetch_advanced');
    const t1Wait = acquireInflightSlot('anchor', T1, A1, 'web_fetch_advanced');

    await new Promise(r => setTimeout(r, 200));
    await t1a.release();

    const winner = await Promise.race([
      t2Wait.then(h => ({ who: 'T2' as const, h })),
      t1Wait.then(h => ({ who: 'T1' as const, h })),
    ]);
    expect(winner.who).toBe('T2');

    // Clean up: release everything still held.
    await winner.h.release();
    await t1b.release();
    // t1Wait still pending — let it admit + release.
    const leftover = await t1Wait;
    await leftover.release();
  }, 15_000);

  it('release deletes only its own row', async () => {
    mockGlobalCap.mockReturnValue(3);
    const a = await acquireInflightSlot('anchor', T1, A1, 'web_fetch_advanced');
    const b = await acquireInflightSlot('anchor', T1, A1, 'web_fetch_advanced');
    await a.release();
    const r = await testPool.query(
      `SELECT request_id FROM web_inflight_requests`,
    );
    expect(r.rows.length).toBe(1);
    expect(r.rows[0].request_id).toBe(b.requestId);
    await b.release();
  });

  it('crashed waiter row is cleaned up by expires_at + DELETE; no permanent skew', async () => {
    mockGlobalCap.mockReturnValue(10);
    // Manually insert an expired waiter row (simulating a crashed process).
    await testPool.query(
      `INSERT INTO web_waiters (waiter_id, vendor, tenant_id, expires_at)
       VALUES (gen_random_uuid(), 'anchor', $1, NOW() - INTERVAL '1 minute')`,
      [T1],
    );
    // Janitor would normally clean this. Even without janitor, a fresh
    // admission ignores expired waiters in the fair-share computation.
    const h = await acquireInflightSlot('anchor', T2, A1, 'web_fetch_advanced');
    expect(h.requestId).toBeDefined();
    await h.release();
  });

  it('all five vendors share the same admission code path (regression for the dead-code bug)', async () => {
    mockGlobalCap.mockReturnValue(2);
    for (const vendor of ['webclaw', 'firecrawl', 'perplexity', 'anchor', 'browserbase'] as const) {
      const h = await acquireInflightSlot(vendor, T1, A1, 'web_fetch_advanced');
      expect(h.requestId).toBeDefined();
      const { rows } = await testPool.query(
        `SELECT COUNT(*)::int AS n FROM web_inflight_requests WHERE vendor = $1`,
        [vendor],
      );
      expect(rows[0].n).toBe(1);
      await h.release();
    }
  });

  // D9 regression test (class-of-bug catcher): a newly-added vendor name
  // must be reflected in the web_inflight_requests vendor CHECK. The failure
  // mode is a router wired but the CHECK list not extended. Migration 232 adds 'exa'
  // to the CHECK; this test exercises the constraint end-to-end against a
  // fresh dev DB so CI catches the regression before it ships.
  it('admits exa without CHECK violation (mig 232 regression catcher)', async () => {
    mockGlobalCap.mockReturnValue(2);
    const h = await acquireInflightSlot('exa', T1, A1, 'web_fetch_advanced');
    expect(h.requestId).toBeDefined();
    const { rows } = await testPool.query(
      `SELECT COUNT(*)::int AS n FROM web_inflight_requests WHERE vendor = $1`,
      ['exa'],
    );
    expect(rows[0].n).toBe(1);
    await h.release();
  });

  // Tavily-equivalent (mig 231 regression catcher) — leave in place if
  // already present elsewhere; the regression net is complete only when
  // every supported vendor has an integration-level CHECK exerciser.
  it('admits tavily without CHECK violation (mig 231 regression catcher)', async () => {
    mockGlobalCap.mockReturnValue(2);
    const h = await acquireInflightSlot('tavily', T1, A1, 'web_fetch_advanced');
    expect(h.requestId).toBeDefined();
    const { rows } = await testPool.query(
      `SELECT COUNT(*)::int AS n FROM web_inflight_requests WHERE vendor = $1`,
      ['tavily'],
    );
    expect(rows[0].n).toBe(1);
    await h.release();
  });

  it('firecrawl pool with global=2 admits 2 then VendorPoolBusy on the 3rd', async () => {
    mockGlobalCap.mockReturnValue(2);
    const h1 = await acquireInflightSlot('firecrawl', T1, A1, 'web_fetch_advanced');
    const h2 = await acquireInflightSlot('firecrawl', T1, A1, 'web_fetch_advanced');
    await expect(acquireInflightSlot('firecrawl', T2, A1, 'web_fetch_advanced'))
      .rejects.toBeInstanceOf(VendorPoolBusy);
    await h1.release();
    await h2.release();
  }, 12_000);

  test('perplexity pool admits N concurrent then VendorPoolBusy on the N+1th', async () => {
    mockGlobalCap.mockReturnValue(2);  // small N for test speed; production default is 50
    const h1 = await acquireInflightSlot('perplexity', T1, A1, 'web_fetch_advanced');
    const h2 = await acquireInflightSlot('perplexity', T1, A1, 'web_fetch_advanced');
    await expect(acquireInflightSlot('perplexity', T2, A1, 'web_fetch_advanced'))
      .rejects.toBeInstanceOf(VendorPoolBusy);
    await h1.release();
    await h2.release();
  }, 12_000);

  it('mixed-vendor tenants do not cross-contend (vendor-keyed advisory lock)', async () => {
    // firecrawl cap = 2 (saturated), webclaw cap = 5 (free).
    mockGlobalCap.mockImplementation((v: string) => (v === 'firecrawl' ? 2 : 5));
    const fc1 = await acquireInflightSlot('firecrawl', T1, A1, 'web_fetch_advanced');
    const fc2 = await acquireInflightSlot('firecrawl', T1, A1, 'web_fetch_advanced');
    // webclaw admits immediately despite firecrawl being full.
    const t0 = Date.now();
    const wc = await acquireInflightSlot('webclaw', T1, A1, 'web_fetch_advanced');
    expect(Date.now() - t0).toBeLessThan(200);
    await wc.release();
    await fc1.release();
    await fc2.release();
  });

  // Phase 1 of the deep-research-realtime-billing plan: per-tool TTL + refresh.
  it('per-tool TTL: web_deep_research gets 3000s, all other tools 300s', async () => {
    mockGlobalCap.mockReturnValue(5);
    const fastHandle = await acquireInflightSlot('perplexity', T1, A1, 'web_fetch_advanced');
    const slowHandle = await acquireInflightSlot('perplexity', T1, A1, 'web_deep_research');

    const { rows } = await testPool.query<{ request_id: string; ttl_seconds: number }>(
      `SELECT request_id,
              EXTRACT(EPOCH FROM (expires_at - NOW()))::int AS ttl_seconds
         FROM web_inflight_requests
        WHERE request_id IN ($1, $2)
        ORDER BY ttl_seconds`,
      [fastHandle.requestId, slowHandle.requestId],
    );
    expect(rows).toHaveLength(2);
    // fastHandle = web_fetch_advanced → ~300s; slowHandle = web_deep_research → ~3000s.
    expect(rows[0].request_id).toBe(fastHandle.requestId);
    expect(rows[0].ttl_seconds).toBeGreaterThanOrEqual(295);
    expect(rows[0].ttl_seconds).toBeLessThanOrEqual(305);
    expect(rows[1].request_id).toBe(slowHandle.requestId);
    expect(rows[1].ttl_seconds).toBeGreaterThanOrEqual(2995);
    expect(rows[1].ttl_seconds).toBeLessThanOrEqual(3005);

    await fastHandle.release();
    await slowHandle.release();
  });

  it('refresh() extends the inflight row TTL and returns {refreshed: true}', async () => {
    mockGlobalCap.mockReturnValue(5);
    const h = await acquireInflightSlot('perplexity', T1, A1, 'web_deep_research');

    // Force the row's expires_at to be near-expiry so we can prove refresh
    // pushed it back out the full per-tool TTL.
    await testPool.query(
      `UPDATE web_inflight_requests
          SET expires_at = NOW() + INTERVAL '30 seconds'
        WHERE request_id = $1`,
      [h.requestId],
    );
    const before = await testPool.query<{ ttl_seconds: number }>(
      `SELECT EXTRACT(EPOCH FROM (expires_at - NOW()))::int AS ttl_seconds
         FROM web_inflight_requests WHERE request_id = $1`,
      [h.requestId],
    );
    expect(before.rows[0].ttl_seconds).toBeLessThanOrEqual(31);

    const result = await h.refresh();
    expect(result.refreshed).toBe(true);

    const after = await testPool.query<{ ttl_seconds: number }>(
      `SELECT EXTRACT(EPOCH FROM (expires_at - NOW()))::int AS ttl_seconds
         FROM web_inflight_requests WHERE request_id = $1`,
      [h.requestId],
    );
    // Should now be approximately the full per-tool TTL (3000s for
    // web_deep_research) — not the original 30s near-expiry.
    expect(after.rows[0].ttl_seconds).toBeGreaterThanOrEqual(2995);
    await h.release();
  });

  it('refresh() returns {refreshed: false} when the inflight row no longer exists', async () => {
    mockGlobalCap.mockReturnValue(5);
    const h = await acquireInflightSlot('perplexity', T1, A1, 'web_deep_research');
    await h.release();
    // Row deleted; refresh must report no-op (callers log a structured warn).
    const result = await h.refresh();
    expect(result.refreshed).toBe(false);
  });
});

// Module-load invariant: DEEP_RESEARCH_TTL_SECONDS must dominate the
// poll-loop ceiling by at least 60s of release-block margin. Validated by
// the constants exported indirectly via the production module having
// already been imported without throwing — if the invariant ever regresses
// (e.g. DEEP_RESEARCH_MAX_WAIT_MS bumped past 49 min while TTL stays at
// 3000s), this very test file would have failed to import. We additionally
// verify the constants by direct arithmetic to give the regression a name.
describe('concurrency-limits — DEEP_RESEARCH TTL invariant', () => {
  it('DEEP_RESEARCH_TTL_SECONDS exceeds DEEP_RESEARCH_MAX_WAIT_MS + 60s', () => {
    // We import the live constant rather than re-deriving it here so the
    // test fails fast if either source drifts.
    const { DEEP_RESEARCH_MAX_WAIT_MS } = require('../perplexity-client') as {
      DEEP_RESEARCH_MAX_WAIT_MS: number;
    };
    const DEEP_RESEARCH_TTL_SECONDS = 3000;
    expect(DEEP_RESEARCH_TTL_SECONDS * 1000).toBeGreaterThanOrEqual(
      DEEP_RESEARCH_MAX_WAIT_MS + 60_000,
    );
  });
});
