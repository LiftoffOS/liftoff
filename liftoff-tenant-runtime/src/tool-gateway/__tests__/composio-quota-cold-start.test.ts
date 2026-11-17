// The first call for a tenant must decide on a budget somebody looked up.
//
// The blind fallback refuses background work, which is right for a runtime
// that asked and could not find out, and wrong for one that has not asked yet.
// Those were the same state: the first call got the fallback synchronously
// while its own fetch was still in flight. A scheduled run makes one connector
// call on a container that has never served its tenant, so it was refused
// against a budget nobody had read — and left no trace, because the refresh
// behind it then succeeded.

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const fetchMock = jest.fn();
jest.mock('../../platform-callback/client', () => ({
  getPlatformCallbackClient: () => (fetchMock.getMockImplementation() ? { fetch: fetchMock } : null),
}));

import { checkComposioQuota, _resetForTesting } from '../composio-rate-limiter';
import { _resetQuotaCacheForTesting } from '../composio-quota-client';

const TENANT = 'tenant-cold';

const HEALTHY = {
  orgMonthlyQuota: 20_000,
  orgConsumed: 135,
  orgRemaining: 19_865,
  reservedHeadroom: 2_000,
  backgroundAllowed: true,
  tenantMonthlySlice: 1_125,
  tenantConsumed: 135,
  tenantRemaining: 990,
  burstPool: 9_000,
  perMinuteLimit: 12,
  orgPerMinuteLimit: 100,
  tenantCount: 8,
  periodStart: '2026-09-01T00:00:00.000Z',
  periodEnd: '2026-10-01T00:00:00.000Z',
  refreshAfterMs: 300_000,
};

beforeEach(() => {
  _resetForTesting();
  _resetQuotaCacheForTesting();
  fetchMock.mockReset();
});

describe('the very first call for a tenant', () => {
  beforeEach(() => {
    fetchMock.mockImplementation(async () => ({ ok: true, json: async () => HEALTHY }));
  });

  it('allows background work when the control plane says there is budget', async () => {
    // The defect: this was refused, on a cold container, with almost none of
    // the quota consumed — enough to stop a weekly agent from ever running.
    const decision = await checkComposioQuota({ tenantId: TENANT, triggeredBy: 'cron' });
    expect(decision.allowed).toBe(true);
  });

  it('asks the control plane exactly once, then serves from cache', async () => {
    await checkComposioQuota({ tenantId: TENANT, triggeredBy: 'cron' });
    await checkComposioQuota({ tenantId: TENANT, triggeredBy: 'cron' });
    await checkComposioQuota({ tenantId: TENANT, triggeredBy: 'event' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('still refuses background work when the control plane says the reserve is reached', async () => {
    fetchMock.mockImplementation(async () => ({
      ok: true,
      json: async () => ({ ...HEALTHY, orgRemaining: 1_500, backgroundAllowed: false }),
    }));
    const decision = await checkComposioQuota({ tenantId: TENANT, triggeredBy: 'cron' });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('background_reserve_protected');
  });
});

describe('when the control plane cannot be reached', () => {
  it('refuses background work — not knowing is a real reason to hold back', async () => {
    fetchMock.mockImplementation(async () => { throw new Error('ECONNREFUSED'); });
    const decision = await checkComposioQuota({ tenantId: TENANT, triggeredBy: 'cron' });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('background_reserve_protected');
  });

  it('still serves foreground work rather than failing every connector tool', async () => {
    fetchMock.mockImplementation(async () => { throw new Error('ECONNREFUSED'); });
    expect((await checkComposioQuota({ tenantId: TENANT })).allowed).toBe(true);
  });

  it('does not retry on every call once it has failed', async () => {
    fetchMock.mockImplementation(async () => { throw new Error('ECONNREFUSED'); });
    await checkComposioQuota({ tenantId: TENANT });
    await checkComposioQuota({ tenantId: TENANT });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('when a fetch hangs', () => {
  it('does not hold the tool call open indefinitely', async () => {
    jest.useFakeTimers();
    fetchMock.mockImplementation(() => new Promise(() => { /* never settles */ }));
    const pending = checkComposioQuota({ tenantId: TENANT, triggeredBy: 'cron' });
    await jest.advanceTimersByTimeAsync(3_500);
    const decision = await pending;
    // Timed out means it did not find out, so background is held back.
    expect(decision.allowed).toBe(false);
    jest.useRealTimers();
  });
});
