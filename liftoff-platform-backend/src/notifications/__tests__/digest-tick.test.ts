// Plan §10a verification for runDigestTick:
//   • two-tz scenario: LA account at 09:00 PT picks up; London account at 09:00 GMT picks up; neither off-hour
//   • runDigestTick empty pending → no sendEmail call
//   • runDigestTick perf recap dedupe → second tick same hour: only one row in notification_perf_recaps_sent
//   • weekly digest fires only on Tue at 09:00 local, not Mon or Wed

// Stub the pool that runDigestTick calls for candidates.
const candidatesRows: Array<Record<string, unknown>> = [];
const candidatesQuery = jest.fn().mockImplementation(async () => ({
  rows: candidatesRows.slice(),
  rowCount: candidatesRows.length,
}));
// Default to one tenant in the perf-recap tenants query (loadPerfMetricsForAccount).
// Individual tests can override by re-assigning tenantMembersRows.
const tenantMembersRows: Array<{ tenant_id: string; tenant_name: string }> = [
  { tenant_id: 'tenant-perf', tenant_name: 'Perf Tenant' },
];
jest.mock('../../infrastructure/database', () => {
  const original = jest.requireActual('../../infrastructure/database');
  return {
    ...original,
    getPool: () => ({ query: candidatesQuery }),
    withAdminScope: jest.fn(
      async (_ctx: unknown, fn: (c: { query: jest.Mock }) => Promise<unknown>) => {
        const client = {
          query: jest.fn().mockImplementation(async () => ({
            rows: tenantMembersRows.slice(),
            rowCount: tenantMembersRows.length,
          })),
        };
        return fn(client);
      },
    ),
  };
});

// Stub the notifications repository.
const fetchPendingMock = jest.fn();
const markDeliveredMock = jest.fn();
const tryReservePerfRecapMock = jest.fn();
jest.mock('../repository', () => ({
  fetchPendingForAccount: (...args: unknown[]) => fetchPendingMock(...args),
  markDelivered: (...args: unknown[]) => markDeliveredMock(...args),
  tryReservePerfRecap: (...args: unknown[]) => tryReservePerfRecapMock(...args),
  insertNotification: jest.fn(),
  markFailed: jest.fn(),
}));

// Stub the email senders.
const sendDigestEmailMock = jest.fn().mockResolvedValue('digest-resend-id');
const sendPerfRecapMock = jest.fn().mockResolvedValue('recap-resend-id');
jest.mock('../email', () => ({
  sendDigestEmail: (...args: unknown[]) => sendDigestEmailMock(...args),
  sendPerformanceRecapEmail: (...args: unknown[]) => sendPerfRecapMock(...args),
}));

// Stub insights data providers.
jest.mock('../../insights/data-providers', () => ({
  getHitlApprovalStats: jest.fn().mockResolvedValue({ totalApprovals: 5 }),
  getInvocationStats: jest.fn().mockResolvedValue({ invocationCount: 12 }),
  getAuditLogAggregation: jest.fn().mockResolvedValue({ totalActions: 3 }),
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// Import AFTER mocks.
import { runDigestTick } from '../digest';

// Cadence-aware fetchPending mock. Tests register rows per (accountId, cadence);
// the digest tick now ALWAYS calls fetchPending for both 'daily' and 'weekly'
// (on Tuesday) so the mock has to disambiguate by the second arg, not by call order.
const pendingByCadence: Map<string, Array<Record<string, unknown>>> = new Map();
function key(accountId: string, cadence: 'daily' | 'weekly'): string {
  return `${accountId}:${cadence}`;
}
function setPending(accountId: string, cadence: 'daily' | 'weekly', rows: Array<Record<string, unknown>>): void {
  pendingByCadence.set(key(accountId, cadence), rows);
}

beforeEach(() => {
  candidatesRows.length = 0;
  pendingByCadence.clear();
  jest.clearAllMocks();
  fetchPendingMock.mockImplementation(async (accountId: string, cadence: 'daily' | 'weekly') => {
    return pendingByCadence.get(key(accountId, cadence)) ?? [];
  });
  tryReservePerfRecapMock.mockResolvedValue(false);
});

describe('runDigestTick — local hour gating', () => {
  it('fires for LA account at 09:00 PT (16:00 UTC in May, PDT = UTC-7)', async () => {
    candidatesRows.push({
      id: 'acc-la',
      email: 'la@test.local',
      firstName: 'LA',
      timezone: 'America/Los_Angeles',
      preferences: { notificationFrequency: 'daily', notificationTypes: {} },
    });
    setPending('acc-la', 'daily', [
      { id: 'r1', accountId: 'acc-la', type: 'task_update', tenantId: 't1', payload: {}, cadence: 'daily', createdAt: new Date(), deliveredAt: null, deliveryError: null },
    ]);
    // 16:00 UTC = 09:00 PDT
    const now = new Date('2026-05-13T16:00:00Z');
    const result = await runDigestTick(now);
    expect(sendDigestEmailMock).toHaveBeenCalledTimes(1);
    expect(result.digestsSent).toBe(1);
  });

  it('fires for London account at 09:00 GMT/BST', async () => {
    candidatesRows.push({
      id: 'acc-lon',
      email: 'lon@test.local',
      firstName: 'Lon',
      timezone: 'Europe/London',
      preferences: { notificationFrequency: 'daily', notificationTypes: {} },
    });
    setPending('acc-lon', 'daily', [
      { id: 'r2', accountId: 'acc-lon', type: 'task_update', tenantId: 't1', payload: {}, cadence: 'daily', createdAt: new Date(), deliveredAt: null, deliveryError: null },
    ]);
    // 08:00 UTC = 09:00 BST (May, DST active)
    const now = new Date('2026-05-13T08:00:00Z');
    const result = await runDigestTick(now);
    expect(sendDigestEmailMock).toHaveBeenCalledTimes(1);
    expect(result.digestsSent).toBe(1);
  });

  it('skips an LA account when it is off-hour', async () => {
    candidatesRows.push({
      id: 'acc-la',
      email: 'la@test.local',
      firstName: 'LA',
      timezone: 'America/Los_Angeles',
      preferences: { notificationFrequency: 'daily', notificationTypes: {} },
    });
    // 12:00 UTC = 05:00 PDT — off hour
    const now = new Date('2026-05-13T12:00:00Z');
    const result = await runDigestTick(now);
    expect(sendDigestEmailMock).not.toHaveBeenCalled();
    expect(result.digestsSent).toBe(0);
  });
});

describe('runDigestTick — empty pending', () => {
  it('does not call sendDigestEmail when no rows are pending in any cadence', async () => {
    candidatesRows.push({
      id: 'acc-la',
      email: 'la@test.local',
      firstName: 'LA',
      timezone: 'America/Los_Angeles',
      preferences: { notificationFrequency: 'daily', notificationTypes: {} },
    });
    // No setPending() calls — both daily and weekly fetches return [].
    const now = new Date('2026-05-13T16:00:00Z');
    const result = await runDigestTick(now);
    expect(sendDigestEmailMock).not.toHaveBeenCalled();
    expect(result.digestsSent).toBe(0);
  });
});

describe('runDigestTick — weekly digest day gating', () => {
  it('fires weekly digest on Tuesday 09:00 local', async () => {
    candidatesRows.push({
      id: 'acc-tue',
      email: 't@x.com',
      firstName: 'T',
      timezone: 'America/Los_Angeles',
      preferences: { notificationFrequency: 'weekly', notificationTypes: {} },
    });
    setPending('acc-tue', 'weekly', [
      { id: 'rw', accountId: 'acc-tue', type: 'task_update', tenantId: 't1', payload: {}, cadence: 'weekly', createdAt: new Date(), deliveredAt: null, deliveryError: null },
    ]);
    // 2026-05-12 is Tuesday. 16:00 UTC = 09:00 PDT.
    const now = new Date('2026-05-12T16:00:00Z');
    const result = await runDigestTick(now);
    expect(sendDigestEmailMock).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'weekly');
    expect(result.digestsSent).toBe(1);
  });

  it('does NOT fire weekly digest on Monday', async () => {
    candidatesRows.push({
      id: 'acc-mon',
      email: 'm@x.com',
      firstName: 'M',
      timezone: 'America/Los_Angeles',
      preferences: { notificationFrequency: 'weekly', notificationTypes: {} },
    });
    setPending('acc-mon', 'weekly', [
      { id: 'r-mon', accountId: 'acc-mon', type: 'task_update', tenantId: 't1', payload: {}, cadence: 'weekly', createdAt: new Date(), deliveredAt: null, deliveryError: null },
    ]);
    // 2026-05-11 is Monday.
    const now = new Date('2026-05-11T16:00:00Z');
    await runDigestTick(now);
    expect(sendDigestEmailMock).not.toHaveBeenCalled();
  });

  it('does NOT fire weekly digest on Wednesday', async () => {
    candidatesRows.push({
      id: 'acc-wed',
      email: 'w@x.com',
      firstName: 'W',
      timezone: 'America/Los_Angeles',
      preferences: { notificationFrequency: 'weekly', notificationTypes: {} },
    });
    setPending('acc-wed', 'weekly', [
      { id: 'r-wed', accountId: 'acc-wed', type: 'task_update', tenantId: 't1', payload: {}, cadence: 'weekly', createdAt: new Date(), deliveredAt: null, deliveryError: null },
    ]);
    // 2026-05-13 is Wednesday.
    const now = new Date('2026-05-13T16:00:00Z');
    await runDigestTick(now);
    expect(sendDigestEmailMock).not.toHaveBeenCalled();
  });

  it('drains stranded daily rows for a user who flipped to weekly cadence', async () => {
    // Regression for the "stranded rows" defect: a user whose current pref
    // is 'weekly' but who has unflushed cadence='daily' rows should still
    // get those rows delivered at the next 09:00 local tick.
    candidatesRows.push({
      id: 'acc-flip',
      email: 'f@x.com',
      firstName: 'F',
      timezone: 'America/Los_Angeles',
      preferences: { notificationFrequency: 'weekly', notificationTypes: {} },
    });
    setPending('acc-flip', 'daily', [
      { id: 'r-stranded', accountId: 'acc-flip', type: 'task_update', tenantId: 't1', payload: {}, cadence: 'daily', createdAt: new Date(), deliveredAt: null, deliveryError: null },
    ]);
    // Wednesday — weekly branch will NOT fire (not Tuesday), but daily branch should.
    const now = new Date('2026-05-13T16:00:00Z');
    const result = await runDigestTick(now);
    expect(sendDigestEmailMock).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'daily');
    expect(result.digestsSent).toBe(1);
  });
});

describe('runDigestTick — perf recap dedupe + ordering', () => {
  it('does NOT send a second perf recap when tryReservePerfRecap returns false', async () => {
    candidatesRows.push({
      id: 'acc-recap',
      email: 'r@x.com',
      firstName: 'R',
      timezone: 'America/Los_Angeles',
      preferences: { notificationFrequency: 'daily', notificationTypes: { weeklyDigest: true } },
    });
    tryReservePerfRecapMock.mockResolvedValue(false); // already reserved
    // 2026-05-12 is Tuesday, 16:00 UTC = 09:00 PDT
    const now = new Date('2026-05-12T16:00:00Z');
    const result = await runDigestTick(now);
    expect(sendPerfRecapMock).not.toHaveBeenCalled();
    expect(result.perfRecapsSent).toBe(0);
  });

  it('sends a perf recap when tryReservePerfRecap reserves AND metrics are non-zero', async () => {
    candidatesRows.push({
      id: 'acc-recap',
      email: 'r@x.com',
      firstName: 'R',
      timezone: 'America/Los_Angeles',
      preferences: { notificationFrequency: 'daily', notificationTypes: { weeklyDigest: true } },
    });
    tryReservePerfRecapMock.mockResolvedValue(true);
    const now = new Date('2026-05-12T16:00:00Z');
    const result = await runDigestTick(now);
    expect(sendPerfRecapMock).toHaveBeenCalledTimes(1);
    expect(result.perfRecapsSent).toBe(1);
  });

  it('does NOT consume the dedupe reservation when metrics are all zero', async () => {
    // Regression for the "reserve before checking metrics" defect: a quiet
    // week should NOT burn the week's dedupe slot — otherwise the user gets
    // no recap that week even if activity arrives a few hours later.
    const providers = jest.requireMock('../../insights/data-providers') as {
      getHitlApprovalStats: jest.Mock;
      getInvocationStats: jest.Mock;
      getAuditLogAggregation: jest.Mock;
    };
    providers.getHitlApprovalStats.mockResolvedValueOnce({ totalApprovals: 0 });
    providers.getInvocationStats.mockResolvedValueOnce({ invocationCount: 0 });
    providers.getAuditLogAggregation.mockResolvedValueOnce({ totalActions: 0 });

    candidatesRows.push({
      id: 'acc-quiet',
      email: 'q@x.com',
      firstName: 'Q',
      timezone: 'America/Los_Angeles',
      preferences: { notificationFrequency: 'daily', notificationTypes: { weeklyDigest: true } },
    });
    // 2026-05-12 is Tuesday, 16:00 UTC = 09:00 PDT
    const now = new Date('2026-05-12T16:00:00Z');
    await runDigestTick(now);
    expect(sendPerfRecapMock).not.toHaveBeenCalled();
    expect(tryReservePerfRecapMock).not.toHaveBeenCalled();
  });
});
