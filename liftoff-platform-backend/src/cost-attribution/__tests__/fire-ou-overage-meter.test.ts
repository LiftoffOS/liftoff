// C6 verification: every cost source (including Composio) reaches the
// SAME boundary — ingestEventWithBuckets — and the post-commit
// fireOuMeterEvent call carries the customer-billable cost (sum of
// bucket assignments' customerCostUsd). Tests that:
//   - source='composio_mcp' with post-pay assignment → meter fires
//   - source='composio_mcp' with included-only assignment → meter does NOT fire
//   - mixed buckets → meter fires with summed customerCostUsd
//   - source='tenant_runtime' is excluded (spend-subscriber owns that path)
//
// Locks the ONE-Stripe-meter contract (CLAUDE.md) at the boundary: no
// per-vendor meter ever exists, and Composio is no different from LLM or
// web tools — they all funnel through fireOuMeterEvent here.

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockClientQuery = jest.fn();
const mockClient = { query: mockClientQuery, release: jest.fn() };
jest.mock('../../infrastructure/database', () => ({
  withAdminScope: jest.fn(async (_opts: unknown, fn: (c: unknown) => Promise<unknown>) => fn(mockClient)),
  withTenantScope: jest.fn(),
  getPool: jest.fn(),
}));

const mockApplyOuConsumption = jest.fn();
const mockApplyOuRefund = jest.fn();
const mockGetOuDefinitionRateUsd = jest.fn().mockResolvedValue(0.0001);
jest.mock('../ou-bucket-service', () => ({
  applyOuConsumption: (...a: unknown[]) => mockApplyOuConsumption(...a),
  applyOuRefund:      (...a: unknown[]) => mockApplyOuRefund(...a),
  getOuDefinitionRateUsd: (...a: unknown[]) => mockGetOuDefinitionRateUsd(...a),
}));

jest.mock('../reload-drain', () => ({
  applyReloadDrain: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../event-classification', () => ({
  classifyChargeability: jest.fn().mockReturnValue('customer'),
}));

const mockFireOuMeterEvent = jest.fn().mockResolvedValue(true);
jest.mock('../../billing/ou-meter-event', () => ({
  fireOuMeterEvent: (...a: unknown[]) => mockFireOuMeterEvent(...a),
  // The ingest path uses the durable variant (persists failures to
  // ou_meter_event_retries — migration 329); the fire contract this suite
  // asserts is identical, so both route to the same mock.
  fireOuMeterEventDurable: (...a: unknown[]) => mockFireOuMeterEvent(...a),
  OU_METER_EVENT_NAME: 'operating_unit_consumed',
}));

import { ingestEventWithBuckets } from '../repository';
import type { CostAttributionEvent } from '../types';

const ACCOUNT_ID = 'acct-1';
const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const STRIPE_CUSTOMER_ID = 'cus_test123';

const COMPOSIO_TEMPLATE: Omit<CostAttributionEvent, 'sourceId' | 'costUsd' | 'ouConsumed' | 'customerCostUsd' | 'costBucket'> = {
  tenantId:   TENANT_ID,
  agentId:    '22222222-2222-2222-2222-222222222222',
  workflowId: null,
  actionId:   null,
  eventType:  'connector_call',
  source:     'composio_mcp',
  connector:  'gmail',
  purpose:    'GMAIL_FETCH_EMAILS',
  occurredAt: new Date('2026-06-08T12:00:00Z'),
};

/** The one billing_controls read this path makes, resolving both the Stripe
 *  customer and whether the account is charged at all. */
function stubBillingControls(row: { stripe_customer_id: string | null; billing_exempt: boolean }): void {
  mockClientQuery.mockImplementation(async (sql: string) => {
    if (typeof sql === 'string' && sql.includes('FROM billing_controls')) {
      return { rows: [row], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  // Default: a normal charged account with a real Stripe customer; subsequent
  // INSERTs report rowCount=1 so meter math runs.
  stubBillingControls({ stripe_customer_id: STRIPE_CUSTOMER_ID, billing_exempt: false });
});

describe('ingestEventWithBuckets → fireOuMeterEvent (C6: ONE-meter-for-Composio)', () => {
  it('Composio post-pay drain fires operating_unit_consumed for the post-pay portion', async () => {
    mockApplyOuConsumption.mockResolvedValueOnce([{
      ouConsumed: 2.99, costUsd: 0.000299, customerCostUsd: 0.000299,
      costBucket: 'post_pay' as const, sourceIdSuffix: '/post_pay',
    }]);
    const inserted = await ingestEventWithBuckets(
      ACCOUNT_ID,
      'composio-call-1',
      0.000299,
      COMPOSIO_TEMPLATE,
    );
    expect(inserted).toBe(1);
    expect(mockFireOuMeterEvent).toHaveBeenCalledTimes(1);
    const args = mockFireOuMeterEvent.mock.calls[0][0] as {
      stripeCustomerId: string; costUsd: number; identifier: string; occurredAt: Date;
    };
    expect(args.stripeCustomerId).toBe(STRIPE_CUSTOMER_ID);
    expect(args.costUsd).toBeCloseTo(0.000299, 6);
    expect(args.identifier).toBe('composio-call-1');
    expect(args.occurredAt).toEqual(COMPOSIO_TEMPLATE.occurredAt);
  });

  it('Composio drain that lands entirely in included bucket does NOT fire the meter (customerCostUsd=0)', async () => {
    mockApplyOuConsumption.mockResolvedValueOnce([{
      ouConsumed: 2.99, costUsd: 0.000299, customerCostUsd: 0,
      costBucket: 'included' as const, sourceIdSuffix: '/included',
    }]);
    const inserted = await ingestEventWithBuckets(
      ACCOUNT_ID,
      'composio-call-2',
      0.000299,
      COMPOSIO_TEMPLATE,
    );
    expect(inserted).toBe(1);
    expect(mockFireOuMeterEvent).not.toHaveBeenCalled();
  });

  it('Mixed buckets: meter fires once with summed customerCostUsd (only post-pay portion is billable)', async () => {
    mockApplyOuConsumption.mockResolvedValueOnce([
      { ouConsumed: 1.50, costUsd: 0.00015, customerCostUsd: 0,         costBucket: 'included' as const, sourceIdSuffix: '/included' },
      { ouConsumed: 0.50, costUsd: 0.00005, customerCostUsd: 0,         costBucket: 'precommit' as const, sourceIdSuffix: '/precommit' },
      { ouConsumed: 0.99, costUsd: 0.000099, customerCostUsd: 0.000099, costBucket: 'post_pay' as const, sourceIdSuffix: '/post_pay' },
    ]);
    const inserted = await ingestEventWithBuckets(
      ACCOUNT_ID,
      'composio-call-3',
      0.000299,
      COMPOSIO_TEMPLATE,
    );
    expect(inserted).toBe(3);
    expect(mockFireOuMeterEvent).toHaveBeenCalledTimes(1);
    expect((mockFireOuMeterEvent.mock.calls[0][0] as { costUsd: number }).costUsd).toBeCloseTo(0.000099, 6);
  });

  it('source=tenant_runtime is excluded — that path fires the meter via spend-subscriber, not here', async () => {
    mockApplyOuConsumption.mockResolvedValueOnce([{
      ouConsumed: 100, costUsd: 0.01, customerCostUsd: 0.01,
      costBucket: 'post_pay' as const, sourceIdSuffix: '/post_pay',
    }]);
    const TR_TEMPLATE = { ...COMPOSIO_TEMPLATE, source: 'tenant_runtime' as const };
    await ingestEventWithBuckets(ACCOUNT_ID, 'tr-call-1', 0.01, TR_TEMPLATE);
    expect(mockFireOuMeterEvent).not.toHaveBeenCalled();
  });

  it('no stripe_customer_id on billing_controls → meter does NOT fire (free tier / unprovisioned account)', async () => {
    stubBillingControls({ stripe_customer_id: null, billing_exempt: false });
    mockApplyOuConsumption.mockResolvedValueOnce([{
      ouConsumed: 2.99, costUsd: 0.000299, customerCostUsd: 0.000299,
      costBucket: 'post_pay' as const, sourceIdSuffix: '/post_pay',
    }]);
    await ingestEventWithBuckets(ACCOUNT_ID, 'composio-call-4', 0.000299, COMPOSIO_TEMPLATE);
    expect(mockFireOuMeterEvent).not.toHaveBeenCalled();
  });
});

// ── billing_exempt: no charge, everything else identical ──────────────────────
//
// This is the seam every non-LLM cost source funnels through (Composio, web
// tools via the web-tool subscriber, governance, embeddings), so gating it here
// is what makes the exemption hold across all of them at once.

describe('ingestEventWithBuckets → billing_exempt accounts', () => {
  it('fires NO meter event even with a real Stripe customer and post-pay spend', async () => {
    // The gate is the explicit flag, not the absence of a customer id: an
    // exempt account has a real subscription and a real customer.
    stubBillingControls({ stripe_customer_id: STRIPE_CUSTOMER_ID, billing_exempt: true });
    mockApplyOuConsumption.mockResolvedValueOnce([{
      ouConsumed: 2.99, costUsd: 0.000299, customerCostUsd: 0.000299,
      costBucket: 'post_pay' as const, sourceIdSuffix: '/post_pay',
    }]);

    await ingestEventWithBuckets(ACCOUNT_ID, 'exempt-call-1', 0.000299, COMPOSIO_TEMPLATE);

    expect(mockFireOuMeterEvent).not.toHaveBeenCalled();
  });

  it('still drains the OU buckets and still writes the ledger row', async () => {
    // The dashboards must stay truthful about what an exempt account consumed.
    // Only the Stripe invoice line is skipped.
    stubBillingControls({ stripe_customer_id: STRIPE_CUSTOMER_ID, billing_exempt: true });
    mockApplyOuConsumption.mockResolvedValueOnce([{
      ouConsumed: 2.99, costUsd: 0.000299, customerCostUsd: 0.000299,
      costBucket: 'post_pay' as const, sourceIdSuffix: '/post_pay',
    }]);

    const inserted = await ingestEventWithBuckets(ACCOUNT_ID, 'exempt-call-2', 0.000299, COMPOSIO_TEMPLATE);

    expect(inserted).toBe(1);
    expect(mockApplyOuConsumption).toHaveBeenCalledTimes(1);
    const insertSql = mockClientQuery.mock.calls
      .map(c => String(c[0]))
      .filter(s => s.includes('INSERT INTO cost_attribution_events'));
    expect(insertSql).toHaveLength(1);
  });

  it('a non-exempt account on the same inputs is unchanged', async () => {
    stubBillingControls({ stripe_customer_id: STRIPE_CUSTOMER_ID, billing_exempt: false });
    mockApplyOuConsumption.mockResolvedValueOnce([{
      ouConsumed: 2.99, costUsd: 0.000299, customerCostUsd: 0.000299,
      costBucket: 'post_pay' as const, sourceIdSuffix: '/post_pay',
    }]);

    await ingestEventWithBuckets(ACCOUNT_ID, 'exempt-call-3', 0.000299, COMPOSIO_TEMPLATE);

    expect(mockFireOuMeterEvent).toHaveBeenCalledTimes(1);
    expect((mockFireOuMeterEvent.mock.calls[0][0] as { stripeCustomerId: string }).stripeCustomerId)
      .toBe(STRIPE_CUSTOMER_ID);
  });
});
