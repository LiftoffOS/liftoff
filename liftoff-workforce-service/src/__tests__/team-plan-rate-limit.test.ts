// CAIO chat rate limiter.
//
// The behaviour worth pinning is not the arithmetic, it is the two failure
// modes: a database fault must fail OPEN (never take the surface down over the
// ledger), and a malformed identifier must fail LOUD (never silently switch the
// limiter off). Those pull in opposite directions and the second one is the one
// that has gone wrong before, on another surface, for the entire life of that
// surface.

const mockQuery = jest.fn();
const mockWithTenantContext = jest.fn();

jest.mock('../infrastructure/rls.js', () => ({
  withTenantContext: (tenantId: string, fn: (client: unknown) => Promise<unknown>) =>
    mockWithTenantContext(tenantId, fn),
}));

jest.mock('../infrastructure/logging.js', () => ({
  log: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import {
  checkAndIncrementTeamPlanRateLimit,
  TEAM_PLAN_RATE_LIMITS,
} from '../workforce-plans/rate-limiter.js';

const TENANT = '22222222-2222-4222-8222-222222222222';
const ACCOUNT = '33333333-3333-4333-8333-333333333333';

/** One counts row, as the atomic CTE returns it. */
function counts(over: Partial<Record<string, number>> = {}) {
  return {
    rows: [{
      tenant_minute: String(over.tenant_minute ?? 1),
      tenant_hour: String(over.tenant_hour ?? 1),
      tenant_day: String(over.tenant_day ?? 1),
      user_minute: String(over.user_minute ?? 1),
      user_hour: String(over.user_hour ?? 1),
      user_day: String(over.user_day ?? 1),
    }],
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockWithTenantContext.mockImplementation(
    async (_tenantId: string, fn: (client: unknown) => Promise<unknown>) =>
      fn({ query: mockQuery }),
  );
});

describe('CAIO chat rate limiter', () => {
  it('allows a turn under the caps and reports the tighter remaining window', async () => {
    mockQuery.mockResolvedValueOnce(counts({ tenant_minute: 2, user_minute: 2 }));

    const result = await checkAndIncrementTeamPlanRateLimit(TENANT, ACCOUNT);

    expect(result.allowed).toBe(true);
    // The per-user cap is the tighter of the two, so it sets what is left.
    expect(result.remaining.minute).toBe(TEAM_PLAN_RATE_LIMITS.user.maxPerMinute - 2);
    // One statement: the insert and the six counts are the same query.
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('denies and rolls back the speculative insert when the tenant minute cap is passed', async () => {
    mockQuery
      .mockResolvedValueOnce(counts({ tenant_minute: TEAM_PLAN_RATE_LIMITS.tenant.maxPerMinute + 1 }))
      .mockResolvedValueOnce({ rows: [] });

    const result = await checkAndIncrementTeamPlanRateLimit(TENANT, ACCOUNT);

    expect(result.allowed).toBe(false);
    expect(result.retryAfter).toBeGreaterThan(0);
    // A refused turn must not count against the window that refused it.
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockQuery.mock.calls[1][0]).toMatch(/DELETE FROM team_plan_rate_limit_events/);
  });

  it('denies on the per-user cap even when the tenant is well under its own', async () => {
    mockQuery
      .mockResolvedValueOnce(counts({
        tenant_minute: 2,
        user_minute: TEAM_PLAN_RATE_LIMITS.user.maxPerMinute + 1,
      }))
      .mockResolvedValueOnce({ rows: [] });

    const result = await checkAndIncrementTeamPlanRateLimit(TENANT, ACCOUNT);

    expect(result.allowed).toBe(false);
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it('fails OPEN when the ledger query throws', async () => {
    mockQuery.mockRejectedValueOnce(new Error('connection terminated'));

    const result = await checkAndIncrementTeamPlanRateLimit(TENANT, ACCOUNT);

    expect(result.allowed).toBe(true);
  });

  // The one that matters. This service reads account_id straight off an
  // x-account-id header, and the columns are UUID NOT NULL. If a non-UUID were
  // allowed to reach the query, every insert would raise "invalid input syntax
  // for type uuid", every request would take the fail-open branch, and the
  // surface would have no rate limit at all while logging a database error once
  // per request. Throwing is what stops that being invisible.
  it('throws, rather than failing open, on a non-UUID identifier', async () => {
    await expect(
      checkAndIncrementTeamPlanRateLimit(TENANT, 'firebase-uid-abc123'),
    ).rejects.toThrow(/accountId must be a UUID/);

    await expect(
      checkAndIncrementTeamPlanRateLimit('not-a-uuid', ACCOUNT),
    ).rejects.toThrow(/tenantId must be a UUID/);

    // Never reached the database, so it cannot have been reported as a fault.
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('scopes every statement to the tenant, for RLS', async () => {
    mockQuery.mockResolvedValueOnce(counts());

    await checkAndIncrementTeamPlanRateLimit(TENANT, ACCOUNT);

    expect(mockWithTenantContext).toHaveBeenCalledWith(TENANT, expect.any(Function));
  });
});
