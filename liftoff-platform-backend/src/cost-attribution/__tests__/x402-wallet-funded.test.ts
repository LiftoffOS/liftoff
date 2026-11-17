/**
 * The x402 wallet-funded branch of ingestEventWithBuckets (migration 440).
 *
 * The platform's x402 wallet paid the VENDOR; the CUSTOMER is charged real
 * Operating Units. Both halves are pinned because each failure is silent on
 * its own:
 *
 *   - skip applyOuConsumption → the customer is never charged, and §7.5's
 *     decision (tenant-attributed OUs) quietly becomes platform-absorbed;
 *   - write the per-bucket sibling rows like the plain customer path → the
 *     on-chain reconciliation (the raw-cost total over cost_bucket=
 *     'x402_wallet_funded' vs settled USDC) double-counts a bucket-crossing
 *     call and never matches again;
 *   - let 'browserbase' fall to the strict web-tool bypass by name → every
 *     x402 browserbase CONNECTOR call books $0 'unknown' the day that vendor
 *     lands, exactly the collision the branch ordering exists to prevent.
 */

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const mockClientQuery = jest.fn();
const mockClient = { query: mockClientQuery, release: jest.fn() };
jest.mock('../../infrastructure/database', () => ({
  withAdminScope: jest.fn(async (_opts: unknown, fn: (c: unknown) => Promise<unknown>) => fn(mockClient)),
  withTenantScope: jest.fn(),
  getPool: jest.fn(),
}));

const mockApplyOuConsumption = jest.fn();
jest.mock('../ou-bucket-service', () => ({
  applyOuConsumption: (...a: unknown[]) => mockApplyOuConsumption(...a),
  applyOuRefund: jest.fn(),
  getOuDefinitionRateUsd: jest.fn().mockResolvedValue(0.01),
}));

const mockApplyReloadDrain = jest.fn().mockResolvedValue(undefined);
const mockFireAutoReloadClaim = jest.fn();
jest.mock('../reload-drain', () => ({
  applyReloadDrain: (...a: unknown[]) => mockApplyReloadDrain(...a),
  fireAutoReloadClaim: (...a: unknown[]) => mockFireAutoReloadClaim(...a),
}));

jest.mock('../event-classification', () => ({
  classifyChargeability: jest.fn().mockReturnValue('customer'),
  VOICE_DICTATION_PURPOSE: 'voice_dictation',
}));

const mockFireOuMeter = jest.fn();
jest.mock('../../billing/ou-meter-event', () => ({
  fireOuMeterEventDurable: (...a: unknown[]) => mockFireOuMeter(...a),
}));

import { ingestEventWithBuckets } from '../repository';
import type { CostAttributionEvent } from '../types';

type Template = Omit<
  CostAttributionEvent,
  'sourceId' | 'costUsd' | 'ouConsumed' | 'customerCostUsd' | 'costBucket'
>;

const template = (over: Partial<Template> = {}): Template => ({
  tenantId: 'tenant-1',
  agentId: 'agent-1',
  connector: 'gloria',
  eventType: 'connector_call',
  actionType: 'get_ticker_summary',
  source: 'tenant_runtime',
  occurredAt: new Date('2026-09-10T00:00:00Z'),
  x402Funded: true,
  usageQuantity: 1,
  usageUnit: 'call',
  ...over,
});

function insertCalls(): unknown[][] {
  return mockClientQuery.mock.calls.filter(
    (c) => String(c[0]).includes('INSERT INTO cost_attribution_events'),
  );
}

const COST_USD = 19;
const OU_CONSUMED = 23;
const CUSTOMER_COST = 24;
const COST_BUCKET = 25;
const USAGE_QUANTITY = 27;
const USAGE_UNIT = 28;

const billingControls = {
  current: { stripe_customer_id: 'cus_123', billing_exempt: false } as
    { stripe_customer_id: string | null; billing_exempt: boolean } | null,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockClientQuery.mockImplementation(async (sql: string) => {
    if (String(sql).includes('FROM billing_controls')) {
      return { rows: billingControls.current ? [billingControls.current] : [], rowCount: billingControls.current ? 1 : 0 };
    }
    return { rows: [], rowCount: 1 };
  });
  billingControls.current = { stripe_customer_id: 'cus_123', billing_exempt: false };
  // A consumption that crossed a bucket boundary: two assignments.
  mockApplyOuConsumption.mockResolvedValue([
    { costBucket: 'included', ouConsumed: 0.6, customerCostUsd: 0, costUsd: 0.006, sourceIdSuffix: '/included' },
    { costBucket: 'reload', ouConsumed: 0.5, customerCostUsd: 0.005, costUsd: 0.005, sourceIdSuffix: '/reload' },
  ]);
});

describe('the x402 wallet-funded branch', () => {
  it('charges real OUs and writes ONE row bucketed x402_wallet_funded with the totals', async () => {
    const inserted = await ingestEventWithBuckets('acct-1', 'evt-x1', 0.011, template());
    expect(inserted).toBe(1);

    // The customer is charged: consumption applied, reload drained.
    expect(mockApplyOuConsumption).toHaveBeenCalledWith(mockClient, 'acct-1', 0.011, expect.anything());
    expect(mockApplyReloadDrain).toHaveBeenCalledWith(
      mockClient, 'acct-1', expect.arrayContaining([expect.objectContaining({ costBucket: 'reload' })]),
      { fireAutoReload: true },
    );

    // One row, totals summed across the assignments, bucket literal ours.
    const inserts = insertCalls();
    expect(inserts).toHaveLength(1);
    const params = inserts[0][1] as unknown[];
    expect(params[COST_USD]).toBe(0.011);
    expect(params[OU_CONSUMED]).toBeCloseTo(1.1, 9);
    expect(params[CUSTOMER_COST]).toBeCloseTo(0.005, 9);
    expect(params[COST_BUCKET]).toBe('x402_wallet_funded');
    expect(params[USAGE_QUANTITY]).toBe(1);
    expect(params[USAGE_UNIT]).toBe('call');
  });

  it('wins over the strict web-tool bypass when the vendor names collide', async () => {
    await ingestEventWithBuckets('acct-1', 'evt-x2', 0.02, template({ connector: 'browserbase' }));
    const params = insertCalls()[0][1] as unknown[];
    expect(params[COST_BUCKET]).toBe('x402_wallet_funded');
    expect(mockApplyOuConsumption).toHaveBeenCalled();
  });

  it('leaves a browserbase row WITHOUT the marker on the bypass, exactly as before', async () => {
    await ingestEventWithBuckets(
      'acct-1', 'evt-x3', 0.02,
      template({ connector: 'browserbase', eventType: 'web_tool', x402Funded: undefined }),
    );
    const params = insertCalls()[0][1] as unknown[];
    expect(params[COST_BUCKET]).toBe('unknown');
    expect(mockApplyOuConsumption).not.toHaveBeenCalled();
  });

  it('writes nothing when the consumption dedups (replayed source event)', async () => {
    mockApplyOuConsumption.mockResolvedValue([]);
    const inserted = await ingestEventWithBuckets('acct-1', 'evt-x1', 0.011, template());
    expect(inserted).toBe(0);
    expect(insertCalls()).toHaveLength(0);
    expect(mockApplyReloadDrain).not.toHaveBeenCalled();
    expect(mockFireOuMeter).not.toHaveBeenCalled();
  });

  // The drain is the only automatic auto-reload trigger, so a charge booked
  // here that reaches the threshold must fire the reload itself: a workspace
  // stopped at its floor makes no later charge to fire it.
  it('fires the auto-reload the drain claimed, after commit, for the workspace', async () => {
    const claim = { stripeCustomerId: 'cus_123', autoReloadAmountUsd: '5.00' };
    mockApplyReloadDrain.mockResolvedValueOnce({ reloadChargeUsd: 0.005, suspendedNow: false, stopReason: null, autoReloadClaim: claim });
    await ingestEventWithBuckets('acct-1', 'evt-x-reload', 0.011, template());
    expect(mockFireAutoReloadClaim).toHaveBeenCalledWith(claim, 'acct-1', 'tenant-1', 'cost_attribution.ingest');
  });

  it('fires the OU meter with the customer-billed portion — x402 rows have no real-time sibling to do it', async () => {
    await ingestEventWithBuckets('acct-1', 'evt-x-meter', 0.011, template());
    expect(mockFireOuMeter).toHaveBeenCalledWith(
      expect.objectContaining({
        stripeCustomerId: 'cus_123',
        costUsd: expect.closeTo(0.005, 9),
        identifier: 'evt-x-meter',
      }),
    );
  });

  it('suppresses the meter — and ONLY the meter — for a billing-exempt account (INV-PB-011)', async () => {
    billingControls.current = { stripe_customer_id: 'cus_123', billing_exempt: true };
    const inserted = await ingestEventWithBuckets('acct-1', 'evt-x-exempt', 0.011, template());
    // Buckets still drain, the ledger row still writes; only Stripe is quiet.
    expect(inserted).toBe(1);
    expect(mockApplyOuConsumption).toHaveBeenCalled();
    expect(mockApplyReloadDrain).toHaveBeenCalled();
    expect(mockFireOuMeter).not.toHaveBeenCalled();
  });
});
