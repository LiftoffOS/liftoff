// Composio quota allocation — the policy, tested as arithmetic.
//
// What matters here is the NUMBERS: a tenant is never handed more than the
// organization has, both meters exist, and the reserve is reachable by
// foreground work and not by background work.

const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../../infrastructure/logging', () => ({ log: mockLog }));

const mockGetOrgConsumption = jest.fn();
const mockGetActiveTenantCount = jest.fn();
jest.mock('../repository', () => {
  const actual = jest.requireActual('../repository');
  return {
    ...actual,
    getOrgConsumption: (...a: unknown[]) => mockGetOrgConsumption(...a),
    getActiveTenantCount: (...a: unknown[]) => mockGetActiveTenantCount(...a),
  };
});

import {
  _resetComposioQuotaCacheForTesting,
  computeAllocation,
  getComposioQuotaAllocation,
} from '../service';
import { currentPeriodEnd, currentPeriodStart, type OrgConsumption } from '../repository';

const TENANT = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';

const ENV_KEYS = [
  'COMPOSIO_ORG_MONTHLY_QUOTA',
  'COMPOSIO_ORG_PER_MINUTE_LIMIT',
  'COMPOSIO_MONTHLY_RESERVED_HEADROOM',
  'COMPOSIO_GUARANTEED_FRACTION',
  'COMPOSIO_MIN_TENANT_PER_MINUTE',
  'COMPOSIO_ALLOCATION_TTL_MS',
] as const;

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

function consumption(perTenant: Record<string, number>): OrgConsumption {
  const map = new Map(Object.entries(perTenant));
  return {
    orgCalls: [...map.values()].reduce((a, b) => a + b, 0),
    perTenant: map,
    periodStart: currentPeriodStart(new Date('2026-08-18T00:00:00Z')),
    periodEnd: currentPeriodEnd(new Date('2026-08-18T00:00:00Z')),
  };
}

describe('per-minute limit', () => {
  it('never exceeds the org ceiling at any fleet size', () => {
    for (const tenantCount of [1, 2, 5, 50, 1000]) {
      const a = computeAllocation({ tenantId: TENANT, consumption: consumption({}), tenantCount });
      expect(a.perMinuteLimit).toBeLessThanOrEqual(a.orgPerMinuteLimit);
      expect(a.orgPerMinuteLimit).toBe(100);
    }
  });

  it('gives a single tenant the whole org ceiling', () => {
    const a = computeAllocation({ tenantId: TENANT, consumption: consumption({}), tenantCount: 1 });
    expect(a.perMinuteLimit).toBe(100);
  });

  it('applies the floor rather than dividing a large fleet into an unusable rate', () => {
    // 100/min over 50 tenants is 2/min — no agent turn completes under that.
    const a = computeAllocation({ tenantId: TENANT, consumption: consumption({}), tenantCount: 50 });
    expect(a.perMinuteLimit).toBe(10);
  });

  it('honours the floor only up to the org ceiling', () => {
    process.env.COMPOSIO_MIN_TENANT_PER_MINUTE = '5000';
    const a = computeAllocation({ tenantId: TENANT, consumption: consumption({}), tenantCount: 50 });
    expect(a.perMinuteLimit).toBe(100);
  });
});

describe('monthly slice', () => {
  it('carves guaranteed slices out of the quota MINUS the reserve', () => {
    // 20000 quota, 2000 reserve => 18000 spendable, half guaranteed = 9000,
    // over 3 tenants = 3000 each. The reserve is never pre-committed.
    const a = computeAllocation({ tenantId: TENANT, consumption: consumption({}), tenantCount: 3 });
    expect(a.tenantMonthlySlice).toBe(3000);
    expect(a.burstPool).toBe(9000);
    expect(a.reservedHeadroom).toBe(2000);
  });

  it('reports this tenant consumption, not the org total', () => {
    const a = computeAllocation({
      tenantId: TENANT,
      consumption: consumption({ [TENANT]: 400, [OTHER]: 1200 }),
      tenantCount: 2,
    });
    expect(a.tenantConsumed).toBe(400);
    expect(a.orgConsumed).toBe(1600);
    expect(a.tenantRemaining).toBe(a.tenantMonthlySlice - 400);
  });

  it('floors remaining at zero rather than reporting a negative allowance', () => {
    const a = computeAllocation({
      tenantId: TENANT,
      consumption: consumption({ [TENANT]: 999_999 }),
      tenantCount: 2,
    });
    expect(a.tenantRemaining).toBe(0);
    expect(a.orgRemaining).toBe(0);
  });

  it('supports hard partitioning with no burst pool', () => {
    process.env.COMPOSIO_GUARANTEED_FRACTION = '1';
    const a = computeAllocation({ tenantId: TENANT, consumption: consumption({}), tenantCount: 2 });
    expect(a.tenantMonthlySlice).toBe(9000);
    expect(a.burstPool).toBe(0);
  });
});

describe('reserved headroom', () => {
  it('keeps background work allowed while the reserve is untouched', () => {
    const a = computeAllocation({
      tenantId: TENANT,
      consumption: consumption({ [OTHER]: 17_999 }),
      tenantCount: 2,
    });
    expect(a.orgRemaining).toBe(2001);
    expect(a.backgroundAllowed).toBe(true);
  });

  it('refuses background work the moment only the reserve is left', () => {
    const a = computeAllocation({
      tenantId: TENANT,
      consumption: consumption({ [OTHER]: 18_000 }),
      tenantCount: 2,
    });
    expect(a.orgRemaining).toBe(2000);
    expect(a.backgroundAllowed).toBe(false);
    // Foreground still has the whole reserve to spend.
    expect(a.orgRemaining).toBe(a.reservedHeadroom);
  });

  it('cannot reserve more than the quota', () => {
    process.env.COMPOSIO_MONTHLY_RESERVED_HEADROOM = '999999';
    const a = computeAllocation({ tenantId: TENANT, consumption: consumption({}), tenantCount: 1 });
    expect(a.reservedHeadroom).toBe(a.orgMonthlyQuota);
    expect(a.tenantMonthlySlice).toBe(0);
  });
});

describe('period window', () => {
  it('anchors on the UTC calendar month so every runtime shares one window', () => {
    expect(currentPeriodStart(new Date('2026-08-18T23:30:00Z')).toISOString())
      .toBe('2026-08-01T00:00:00.000Z');
    expect(currentPeriodEnd(new Date('2026-08-18T23:30:00Z')).toISOString())
      .toBe('2026-09-01T00:00:00.000Z');
  });

  it('rolls the year over in December', () => {
    expect(currentPeriodEnd(new Date('2026-12-31T23:59:59Z')).toISOString())
      .toBe('2027-01-01T00:00:00.000Z');
  });
});

describe('per-workspace consumption is surfaced, not discarded', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _resetComposioQuotaCacheForTesting();
    mockGetActiveTenantCount.mockResolvedValue(3);
  });

  it('names the biggest consumers, so a runaway is identifiable', async () => {
    // A shared budget whose per-workspace breakdown is computed and thrown away
    // leaves "which tenant is spending it" unanswerable from anything we keep.
    mockGetOrgConsumption.mockResolvedValue(consumption({
      [TENANT]: 400,
      [OTHER]: 9_000,
      'cccccccc-cccc-cccc-cccc-cccccccccccc': 12,
    }));

    await getComposioQuotaAllocation(TENANT);

    expect(mockLog.info).toHaveBeenCalledWith(
      expect.objectContaining({
        metric: 'composio.quota.org_snapshot',
        orgCalls: 9_412,
        consumingTenants: 3,
        topConsumers: [
          { tenantId: OTHER, calls: 9_000 },
          { tenantId: TENANT, calls: 400 },
          { tenantId: 'cccccccc-cccc-cccc-cccc-cccccccccccc', calls: 12 },
        ],
      }),
      expect.any(String),
    );
  });

  it('carries the quota and the window, so a tier decision has both sides', async () => {
    mockGetOrgConsumption.mockResolvedValue(consumption({ [TENANT]: 1 }));
    await getComposioQuotaAllocation(TENANT);
    expect(mockLog.info).toHaveBeenCalledWith(
      expect.objectContaining({
        orgMonthlyQuota: 20_000,
        activeTenants: 3,
        periodStart: '2026-08-01T00:00:00.000Z',
        periodEnd: '2026-09-01T00:00:00.000Z',
      }),
      expect.any(String),
    );
  });

  it('emits once per snapshot refresh, not once per asking tenant', async () => {
    // One control-plane query serves the fleet's refresh cycle; logging per
    // request would turn a diagnostic into noise.
    mockGetOrgConsumption.mockResolvedValue(consumption({ [TENANT]: 1 }));
    await getComposioQuotaAllocation(TENANT);
    await getComposioQuotaAllocation(OTHER);
    await getComposioQuotaAllocation(TENANT);

    const snapshots = mockLog.info.mock.calls.filter(
      ([ctx]) => (ctx as { metric?: string }).metric === 'composio.quota.org_snapshot',
    );
    expect(snapshots).toHaveLength(1);
  });
});
