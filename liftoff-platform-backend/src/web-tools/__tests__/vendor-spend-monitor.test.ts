/**
 * Phase 3 PB-5b of the deep-research-realtime-billing plan.
 *
 * The vendor-spend monitor now appends a per-tool runaway query after the
 * existing per-vendor MTD loop. Default cap is $25/hr for web_deep_research;
 * operators can override via feature flag
 *   web_tools_runaway_per_hour_web_deep_research_value (number, enabled=true).
 *
 * The alert log carries scope='tool' so on-call can distinguish per-vendor
 * MTD ceilings from per-tool hourly bursts.
 */

const mockPoolQuery = jest.fn();
jest.mock('../../infrastructure/database', () => {
  const __db: any = {
  getPool: () => ({ query: (...a: unknown[]) => mockPoolQuery(...a) }),
};
  const __mkc = () => (__db.getPool ? __db.getPool() : (__db.pool || { query: jest.fn() }));
  __db.withTenantScope = (_t: string, fn: (c: any) => any) => fn(__mkc());
  __db.withAdminScope = (_c: any, fn: (c: any) => any) => fn(__mkc());
  return __db;
});
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
const mockGetCachedFlagNumber = jest.fn();
jest.mock('../sentinel-flags', () => ({
  getCachedFlagNumber: (...a: unknown[]) => mockGetCachedFlagNumber(...a),
}));
const mockBalances = jest.fn();
jest.mock('../../connectors/platform-vendor-balances', () => ({
  fetchPlatformVendorBalances: (...a: unknown[]) => mockBalances(...a),
}));

import { log } from '../../infrastructure/logging';
import { monitorVendorSpend } from '../vendor-spend-monitor';

function poolReturns(...sequence: Array<{ rows: unknown[] }>) {
  let i = 0;
  mockPoolQuery.mockImplementation(async () => sequence[i++] ?? { rows: [] });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetCachedFlagNumber.mockResolvedValue(null);   // no operator override → default cap
  mockBalances.mockResolvedValue({ locus: { usd: 23.67 }, vaaya: { usd: 9.87 } });
});

describe('monitorVendorSpend — per-tool runaway (Phase 3)', () => {
  it('fires vendor_spend_high with scope="tool" when hourly cost meets the $25 default cap', async () => {
    // First query: per-vendor MTD (empty); second query: per-tool hourly.
    poolReturns(
      { rows: [] },
      { rows: [{ tool: 'web_deep_research', hourly_cost: '25.00' }] },
    );
    await monitorVendorSpend();
    const { log } = require('../../infrastructure/logging') as { log: { warn: jest.Mock } };
    const toolAlerts = log.warn.mock.calls.filter(
      (c: unknown[]) => (c[0] as Record<string, unknown>).scope === 'tool',
    );
    expect(toolAlerts.length).toBe(1);
    const ctx = toolAlerts[0][0] as Record<string, unknown>;
    expect(ctx.event).toBe('vendor_spend_high');
    expect(ctx.tool).toBe('web_deep_research');
    expect(ctx.hourly_cost_usd).toBeCloseTo(25.0);
    expect(ctx.hourly_cap_usd).toBe(25);
  });

  it('does NOT fire when hourly cost is below the cap', async () => {
    poolReturns(
      { rows: [] },
      { rows: [{ tool: 'web_deep_research', hourly_cost: '5.00' }] },
    );
    await monitorVendorSpend();
    const { log } = require('../../infrastructure/logging') as { log: { warn: jest.Mock } };
    const toolAlerts = log.warn.mock.calls.filter(
      (c: unknown[]) => (c[0] as Record<string, unknown>).scope === 'tool',
    );
    expect(toolAlerts.length).toBe(0);
  });

  it('honors operator override via feature flag (raises threshold to $100 → $25 burst no longer alerts)', async () => {
    poolReturns(
      { rows: [] },
      { rows: [{ tool: 'web_deep_research', hourly_cost: '25.00' }] },
    );
    mockGetCachedFlagNumber.mockResolvedValueOnce(100);   // operator raised cap to $100/hr
    await monitorVendorSpend();
    const { log } = require('../../infrastructure/logging') as { log: { warn: jest.Mock } };
    const toolAlerts = log.warn.mock.calls.filter(
      (c: unknown[]) => (c[0] as Record<string, unknown>).scope === 'tool',
    );
    expect(toolAlerts.length).toBe(0);
    expect(mockGetCachedFlagNumber).toHaveBeenCalledWith(
      'web_tools_runaway_per_hour_web_deep_research_value',
    );
  });

  it('feature-flag override $0 or null falls back to the default cap', async () => {
    poolReturns(
      { rows: [] },
      { rows: [{ tool: 'web_deep_research', hourly_cost: '30.00' }] },
    );
    mockGetCachedFlagNumber.mockResolvedValueOnce(null);   // no override → $25 default
    await monitorVendorSpend();
    const { log } = require('../../infrastructure/logging') as { log: { warn: jest.Mock } };
    const toolAlerts = log.warn.mock.calls.filter(
      (c: unknown[]) => (c[0] as Record<string, unknown>).scope === 'tool',
    );
    expect(toolAlerts.length).toBe(1);
    expect((toolAlerts[0][0] as Record<string, unknown>).hourly_cap_usd).toBe(25);
  });
});

/** The platform's Browser Use credit.
 *
 *  Browser Use has no balance endpoint, so what is left can only be derived
 *  from what we have spent — and that total is only trustworthy now that every
 *  session settles. Report-only by design: nothing alerts, nothing degrades,
 *  and the browser is allowed to simply stop when the credit runs out.
 */
describe('platform browser credit', () => {
  /** Answer by SQL rather than by position.
   *
   *  The suite's other helper is ordered, and adding a query anywhere ahead of
   *  it shifts every expectation — which is exactly what happened when this
   *  report was first written at the top of the function. Matching on the
   *  statement is immune to that. */
  const creditRows = (spent: string | null, sessions: string) => {
    mockPoolQuery.mockReset();
    mockPoolQuery.mockImplementation(async (sql: string) =>
      /ou_consumed > 0/.test(String(sql))
        ? { rows: [{ spent, sessions }] }
        : { rows: [] });
  };

  /** The credit query, whichever position it ran in. */
  const creditSql = () =>
    mockPoolQuery.mock.calls.map(c => String(c[0])).find(q => /ou_consumed > 0/.test(q)) ?? '';

  it('reports what the platform key has spent and what is left', async () => {
    creditRows('3.75', '43');

    await monitorVendorSpend();

    const { log } = require('../../infrastructure/logging') as { log: { info: jest.Mock } };
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'platform_browser_credit',
        spent_usd: 3.75,
        remaining_usd: 11.25,
        credit_usd: 15,
        sessions: 43,
      }),
      'platform_browser_credit',
    );
  });

  it('counts only platform-funded rows, not a workspace\'s own key', async () => {
    // A tenant-funded browser_use row takes the strict-vendor bypass and lands
    // with zero OUs, precisely so the workspace is not charged twice. Counting
    // it here would report someone else's spend against our credit.
    creditRows('1.00', '10');

    await monitorVendorSpend();

    expect(creditSql()).toContain("connector  = 'browser_use'");
  });

  it('reports zero rather than NaN before anything has settled', async () => {
    creditRows(null, '0');

    await monitorVendorSpend();

    const { log } = require('../../infrastructure/logging') as { log: { info: jest.Mock } };
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ spent_usd: 0, remaining_usd: 15, mean_session_usd: 0 }),
      'platform_browser_credit',
    );
  });

  it('never fails the spend monitor around it', async () => {
    // It is a report. The MTD ceilings and runaway alerts are the parts with
    // teeth, and a broken total must not take them down.
    mockPoolQuery.mockReset();
    mockPoolQuery.mockImplementation(async (sql: string) => {
      if (/ou_consumed > 0/.test(String(sql))) throw new Error('db unavailable');
      return { rows: [] };
    });

    await expect(monitorVendorSpend()).resolves.toBeUndefined();
  });
});

// The platform's prepaid balances at the aggregators: read from
// connector-service every run, an alert under the floor, a warning when a
// figure cannot be read, and never able to fail the monitor around it.
describe('aggregator balances', () => {
  const events = (name: string) => (log.warn as jest.Mock).mock.calls.concat((log.info as jest.Mock).mock.calls)
    .map((c) => c[0]).filter((p) => p && p.event === name);

  it('reports a funded balance and alerts under the floor', async () => {
    poolReturns({ rows: [] }, { rows: [] }, { rows: [{ spent: '0', sessions: '0' }] });
    mockBalances.mockResolvedValue({ locus: { usd: 4.99 }, vaaya: { usd: 9.87 } });
    await monitorVendorSpend();
    expect(events('vendor_balance_low')).toEqual([expect.objectContaining({ vendor: 'locus', balance_usd: 4.99, floor_usd: 5 })]);
    expect(events('vendor_balance')).toEqual([expect.objectContaining({ vendor: 'vaaya', balance_usd: 9.87, floor_usd: 2 })]);
  });

  it('warns, rather than staying silent, when a figure cannot be read', async () => {
    poolReturns({ rows: [] }, { rows: [] }, { rows: [{ spent: '0', sessions: '0' }] });
    mockBalances.mockResolvedValue({ locus: { usd: null, error: 'connector-service answered HTTP 503' }, vaaya: { usd: 1.5 } });
    await monitorVendorSpend();
    expect(events('vendor_balance_unread')).toEqual([expect.objectContaining({ vendor: 'locus', error: 'connector-service answered HTTP 503' })]);
    expect(events('vendor_balance_low')).toEqual([expect.objectContaining({ vendor: 'vaaya', balance_usd: 1.5 })]);
  });

  it('never fails the spend monitor around it', async () => {
    poolReturns({ rows: [] }, { rows: [] }, { rows: [{ spent: '0', sessions: '0' }] });
    mockBalances.mockRejectedValue(new Error('down'));
    await expect(monitorVendorSpend()).resolves.toBeUndefined();
  });
});
