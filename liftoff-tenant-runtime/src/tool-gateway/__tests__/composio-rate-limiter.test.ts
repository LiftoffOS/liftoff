// Composio quota enforcement — unit tests.
//
// Composio bills one organization-wide meter in two dimensions, so the
// properties worth pinning are: a tenant is never authorised beyond the org
// ceiling, the monthly quota is enforced independently of the rate, and the
// foreground reserve is unreachable by ambient work.

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// The client is exercised separately; here it is seeded directly so the quota
// policy is tested without a control-plane round trip.
jest.mock('../../platform-callback/client', () => ({
  getPlatformCallbackClient: () => null,
}));

import {
  checkComposioQuota,
  isBackgroundWork,
  _resetForTesting,
} from '../composio-rate-limiter';
import {
  _resetQuotaCacheForTesting,
  _seedAllocationForTesting,
  ensureAllocation,
} from '../composio-quota-client';

const TENANT = 'tenant-a';

beforeEach(() => {
  _resetForTesting();
  _resetQuotaCacheForTesting();
});

/** A healthy allocation: plenty of month left, a usable per-minute share. */
function seedHealthy(overrides: Record<string, unknown> = {}): void {
  _seedAllocationForTesting(TENANT, {
    orgMonthlyQuota: 20_000,
    orgConsumed: 265,
    orgRemaining: 19_735,
    reservedHeadroom: 2_000,
    backgroundAllowed: true,
    tenantMonthlySlice: 9_000,
    tenantConsumed: 265,
    tenantRemaining: 8_735,
    burstPool: 9_000,
    perMinuteLimit: 100,
    orgPerMinuteLimit: 100,
    tenantCount: 1,
    periodStart: '2026-08-01T00:00:00.000Z',
    periodEnd: '2026-09-01T00:00:00.000Z',
    refreshAfterMs: 300_000,
    ...overrides,
  });
}

describe('a tenant is never allowed more than the organization', () => {
  it('caps the per-minute bucket at the allocated share', async () => {
    seedHealthy({ perMinuteLimit: 5, orgPerMinuteLimit: 100 });
    for (let i = 0; i < 5; i++) {
      expect((await checkComposioQuota({ tenantId: TENANT })).allowed).toBe(true);
    }
    const denied = await checkComposioQuota({ tenantId: TENANT });
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe('tenant_rate_limited');
    expect(denied.retryAfterMs).toBeGreaterThan(0);
  });

  it('re-sizes the bucket when the allocation changes instead of refilling toward a stale ceiling', async () => {
    seedHealthy({ perMinuteLimit: 10 });
    expect((await checkComposioQuota({ tenantId: TENANT })).allowed).toBe(true);

    seedHealthy({ perMinuteLimit: 2 });
    expect((await checkComposioQuota({ tenantId: TENANT })).allowed).toBe(true);
    expect((await checkComposioQuota({ tenantId: TENANT })).allowed).toBe(true);
    expect((await checkComposioQuota({ tenantId: TENANT })).allowed).toBe(false);
  });

  it('tracks tenants independently', async () => {
    seedHealthy({ perMinuteLimit: 1 });
    _seedAllocationForTesting('tenant-b', {
      orgRemaining: 19_735,
      reservedHeadroom: 2_000,
      backgroundAllowed: true,
      tenantRemaining: 8_735,
      perMinuteLimit: 1,
      periodEnd: '2026-09-01T00:00:00.000Z',
    });
    expect((await checkComposioQuota({ tenantId: TENANT })).allowed).toBe(true);
    expect((await checkComposioQuota({ tenantId: TENANT })).allowed).toBe(false);
    expect((await checkComposioQuota({ tenantId: 'tenant-b' })).allowed).toBe(true);
  });
});

describe('the monthly quota is enforced independently of the rate', () => {
  it('refuses every call once the org month is spent', async () => {
    seedHealthy({ orgRemaining: 0, orgConsumed: 20_000 });
    const denied = await checkComposioQuota({ tenantId: TENANT });
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe('org_monthly_quota_exhausted');
    // No retry hint: nothing frees up until the window rolls, and offering one
    // would send the caller into a retry loop that cannot succeed.
    expect(denied.retryAfterMs).toBeUndefined();
  });

  it('names the reset date so the refusal is actionable', async () => {
    seedHealthy({ orgRemaining: 0 });
    expect((await checkComposioQuota({ tenantId: TENANT })).message).toContain('2026-09-01');
  });

  it('refuses a tenant past its slice once the shared pool is down to the reserve', async () => {
    seedHealthy({ tenantRemaining: 0, orgRemaining: 1_500, reservedHeadroom: 2_000 });
    const denied = await checkComposioQuota({ tenantId: TENANT });
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe('tenant_monthly_slice_exhausted');
  });

  it('lets a tenant past its slice burst while the shared pool is healthy', async () => {
    seedHealthy({ tenantRemaining: 0, orgRemaining: 12_000, reservedHeadroom: 2_000 });
    expect((await checkComposioQuota({ tenantId: TENANT })).allowed).toBe(true);
  });
});

describe('reserved headroom is foreground-only', () => {
  it.each(['cron', 'event'])('classifies %s as background', (t) => {
    expect(isBackgroundWork(t)).toBe(true);
  });

  it.each(['human', 'agent', undefined])('classifies %s as foreground', (t) => {
    expect(isBackgroundWork(t)).toBe(false);
  });

  it('refuses ambient work once only the reserve remains', async () => {
    seedHealthy({ orgRemaining: 2_000, reservedHeadroom: 2_000, backgroundAllowed: false });
    const denied = await checkComposioQuota({ tenantId: TENANT, triggeredBy: 'cron' });
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe('background_reserve_protected');
  });

  it('still serves the person who is waiting, out of that same reserve', async () => {
    seedHealthy({ orgRemaining: 2_000, reservedHeadroom: 2_000, backgroundAllowed: false });
    expect((await checkComposioQuota({ tenantId: TENANT, triggeredBy: 'human' })).allowed).toBe(true);
  });

  it('treats a caller that says nothing as foreground rather than assuming ambient', async () => {
    seedHealthy({ orgRemaining: 2_000, reservedHeadroom: 2_000, backgroundAllowed: false });
    expect((await checkComposioQuota({ tenantId: TENANT })).allowed).toBe(true);
  });
});

describe('local consumption between control-plane refreshes', () => {
  it('spends the local counter on every allowed call', async () => {
    seedHealthy({ tenantConsumed: 0, tenantRemaining: 3, orgRemaining: 100, reservedHeadroom: 2_000 });
    await checkComposioQuota({ tenantId: TENANT });
    await checkComposioQuota({ tenantId: TENANT });
    const alloc = await ensureAllocation(TENANT);
    expect(alloc.tenantConsumed).toBe(2);
    expect(alloc.tenantRemaining).toBe(1);
  });

  it('does not spend the counter on a denied call', async () => {
    seedHealthy({ orgRemaining: 0, tenantConsumed: 7 });
    await checkComposioQuota({ tenantId: TENANT });
    expect((await ensureAllocation(TENANT)).tenantConsumed).toBe(7);
  });

  it('notices the reserve being crossed without waiting for a refresh', async () => {
    seedHealthy({ orgRemaining: 2_001, reservedHeadroom: 2_000, backgroundAllowed: true });
    expect((await checkComposioQuota({ tenantId: TENANT, triggeredBy: 'cron' })).allowed).toBe(true);
    // That one call took the org to exactly the reserve.
    expect((await checkComposioQuota({ tenantId: TENANT, triggeredBy: 'cron' })).reason)
      .toBe('background_reserve_protected');
  });
});

describe('blind fallback when the control plane has never answered', () => {
  it('serves a small conservative budget rather than an unlimited one', async () => {
    const alloc = await ensureAllocation('never-fetched');
    expect(alloc.perMinuteLimit).toBe(20);
    expect(alloc.perMinuteLimit).toBeLessThan(alloc.orgPerMinuteLimit);
    expect(alloc.tenantMonthlySlice).toBe(500);
  });

  it('refuses background work while blind', async () => {
    const denied = await checkComposioQuota({ tenantId: 'never-fetched', triggeredBy: 'cron' });
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe('background_reserve_protected');
  });

  it('still serves foreground work rather than failing every connector tool', async () => {
    expect((await checkComposioQuota({ tenantId: 'never-fetched', triggeredBy: 'human' })).allowed).toBe(true);
  });
});
