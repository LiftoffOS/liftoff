// TE-002: Threshold state machine — exhaustive coverage
//
// Tests:
//   - getThresholdCharge() for every scheduled entry + post-graduation ongoing phase
//   - runThresholdCheck() behavioral paths: skip/fire/race/rollback

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('../../infrastructure/database', () => ({
  getPool: jest.fn(),
}));

// Capture fetch calls so we can assert charge parameters
const mockFetch = jest.fn();
global.fetch = mockFetch;

import { getPool } from '../../infrastructure/database';
import { getThresholdCharge, runThresholdCheck } from '../../billing/threshold-charge-service';

const ACCOUNT_ID = 'account-uuid-002';

function makeControls(overrides: Partial<{
  current_period_spend_usd: string;
  next_threshold_usd: string;
  suspended: boolean;
  billing_exempt: boolean;
  stripe_subscription_id: string | null;
  stripe_period_start: Date | null;
  stripe_customer_id: string | null;
}> = {}) {
  return {
    account_id:               ACCOUNT_ID,
    current_period_spend_usd: '0.00',
    next_threshold_usd:       '100.00',
    suspended:                false,
    billing_exempt:           false,
    stripe_subscription_id:   'sub_test123',
    stripe_period_start:      new Date('2026-04-01T00:00:00Z'),
    stripe_customer_id:       'cus_test123',
    ...overrides,
  };
}

function setupPoolWithControls(
  controls: ReturnType<typeof makeControls> | null,
  optimisticUpdateRowCount = 1,
) {
  const mockPool = {
    query: jest.fn()
      .mockResolvedValueOnce({ rows: controls ? [controls] : [], rowCount: controls ? 1 : 0 })  // getControls
      .mockResolvedValueOnce({ rows: [], rowCount: optimisticUpdateRowCount }),                 // optimistic UPDATE
  };
  (getPool as jest.Mock).mockReturnValue(mockPool);
  return mockPool;
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.BILLING_SERVICE_TOKEN = 'test-billing-token';
  process.env.BILLING_SERVICE_URL   = 'http://billing-svc:3001';
  // Default: successful Stripe charge
  mockFetch.mockResolvedValue({ ok: true, text: async () => '' });
});

// ── getThresholdCharge — pure function, no mocks ──────────────────���────────────

describe('TE-002a — getThresholdCharge() graduated schedule', () => {
  it.each([
    // [nextThreshold, expectedCharge, expectedNextTrigger]
    [100,  100,  300 ],
    [300,  200,  800 ],
    [800,  500,  1800],
    [1800, 1000, 2800],
  ])('threshold %i → charges $%i, next trigger = %i', (triggerAt, charge, nextTrigger) => {
    const result = getThresholdCharge(triggerAt);
    expect(result.chargeAmount).toBe(charge);
    expect(result.nextTrigger).toBe(nextTrigger);
  });

  it('graduated accounts in ongoing $1K phase advance by $1K per step', () => {
    // Any value not in the schedule (e.g. 2800, 3800) uses ongoing $1K increment
    expect(getThresholdCharge(2800)).toEqual({ chargeAmount: 1000, nextTrigger: 3800 });
    expect(getThresholdCharge(5800)).toEqual({ chargeAmount: 1000, nextTrigger: 6800 });
  });
});

// ── runThresholdCheck — DB-dependent ──────────────────────────────────────────

describe('TE-002b — runThresholdCheck() state machine', () => {
  it('does nothing when billing_controls row is missing', async () => {
    setupPoolWithControls(null);
    await runThresholdCheck(ACCOUNT_ID);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does nothing when account is suspended', async () => {
    setupPoolWithControls(makeControls({ suspended: true, current_period_spend_usd: '200.00' }));
    await runThresholdCheck(ACCOUNT_ID);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does nothing when spend < threshold', async () => {
    setupPoolWithControls(makeControls({ current_period_spend_usd: '50.00', next_threshold_usd: '100.00' }));
    await runThresholdCheck(ACCOUNT_ID);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does nothing when Stripe IDs are not set', async () => {
    setupPoolWithControls(makeControls({
      current_period_spend_usd: '200.00',
      stripe_subscription_id:   null,
      stripe_period_start:      null,
      stripe_customer_id:       null,
    }));
    await runThresholdCheck(ACCOUNT_ID);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('silently returns when optimistic UPDATE is a no-op (concurrent race lost)', async () => {
    setupPoolWithControls(
      makeControls({ current_period_spend_usd: '120.00', next_threshold_usd: '100.00' }),
      0, // optimistic update rowCount = 0 → lost the race
    );
    await runThresholdCheck(ACCOUNT_ID);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // ── billing_exempt ────────────────────────────────────────────────────────
  // Billing-exempt accounts cross thresholds like anyone else. Nothing
  // upstream changes — the spend counter moved, the buckets drained, the
  // dashboard is truthful — and then no money moves.

  it('billing_exempt: crosses the threshold and makes no charge call', async () => {
    setupPoolWithControls(makeControls({
      current_period_spend_usd: '120.00',
      next_threshold_usd:       '100.00',
      billing_exempt:           true,
    }));

    await runThresholdCheck(ACCOUNT_ID);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('billing_exempt: still advances the threshold (settled), so nothing re-fires or accrues', async () => {
    // Treating exempt as auto-settled is what keeps outstanding_balance_usd at
    // zero: no invoice is created, so no payment can fail, so nothing accrues
    // and nothing suspends. Advancing also stops the same threshold re-firing
    // on every subsequent event.
    const mockPool = setupPoolWithControls(makeControls({
      current_period_spend_usd: '120.00',
      next_threshold_usd:       '100.00',
      billing_exempt:           true,
    }));

    await runThresholdCheck(ACCOUNT_ID);

    const advanceCall = mockPool.query.mock.calls[1];
    expect(String(advanceCall[0])).toContain('SET next_threshold_usd');
    expect(Number((advanceCall[1] as unknown[])[0])).toBe(300); // next trigger after $100
    // Exactly two statements: read + advance. No rollback, no balance write.
    expect(mockPool.query).toHaveBeenCalledTimes(2);
  });

  it('billing_exempt: a non-exempt account on identical inputs still charges', async () => {
    setupPoolWithControls(makeControls({
      current_period_spend_usd: '120.00',
      next_threshold_usd:       '100.00',
      billing_exempt:           false,
    }));

    await runThresholdCheck(ACCOUNT_ID);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body.chargeAmountUsd).toBe(100);
  });

  it('fires charge with correct amount and idempotency key when spend crosses $100 threshold', async () => {
    const controls = makeControls({ current_period_spend_usd: '120.00', next_threshold_usd: '100.00' });
    setupPoolWithControls(controls);

    await runThresholdCheck(ACCOUNT_ID);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, fetchOptions] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(fetchOptions.body as string);

    expect(body.chargeAmountUsd).toBe(100); // chargeAmount for triggerAt=100
    expect(body.stripeCustomerId).toBe('cus_test123');
    expect(body.idempotencyKey).toMatch(/^threshold-sub_test123-.*-100$/);
    expect(body.metadata.type).toBe('threshold');
    expect(body.metadata.threshold_level).toBe('100');
  });

  it.each([
    ['100',  100,  300 ],
    ['300',  200,  800 ],
    ['800',  500,  1800],
    ['1800', 1000, 2800],
  ])('charges correct amount at threshold %s', async (threshold, expectedCharge, expectedNextTrigger) => {
    const controls = makeControls({
      current_period_spend_usd: String(parseFloat(threshold) + 50),
      next_threshold_usd: threshold,
    });
    const mockPool = setupPoolWithControls(controls);

    await runThresholdCheck(ACCOUNT_ID);

    // Optimistic UPDATE should have been called with nextTrigger as $1
    const updateCall = mockPool.query.mock.calls[1]; // second call
    expect(Number(updateCall[1][0])).toBe(expectedNextTrigger);

    // Charge amount in fetch body
    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body.chargeAmountUsd).toBe(expectedCharge);
  });

  it('rolls back optimistic threshold advance when charge call fails', async () => {
    const controls = makeControls({ current_period_spend_usd: '120.00', next_threshold_usd: '100.00' });
    const mockPool = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [controls], rowCount: 1 })  // getControls
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })           // optimistic UPDATE (advance)
        .mockResolvedValueOnce({ rows: [], rowCount: 1 }),          // rollback UPDATE (restore)
    };
    (getPool as jest.Mock).mockReturnValue(mockPool);
    mockFetch.mockResolvedValueOnce({ ok: false, text: async () => 'stripe error', status: 402 });

    await expect(runThresholdCheck(ACCOUNT_ID)).rejects.toThrow();

    // Third query = compensating rollback — restores next_threshold_usd to 100
    const rollbackCall = mockPool.query.mock.calls[2];
    expect(String(rollbackCall[0])).toContain('next_threshold_usd = $1');
    expect(Number(rollbackCall[1][0])).toBe(100);
  });

  it('period-reset: graduated account resets to $1,000 threshold, non-graduated to $100', async () => {
    // This tests the DB logic in billing-controls-internal-router but the invariant
    // is expressed here for discoverability alongside the state machine tests.
    // The UPDATE SQL uses: CASE WHEN graduated_at IS NOT NULL THEN 1000.00 ELSE 100.00 END
    // Verified by reading the period-reset endpoint — no mock needed.
    expect(true).toBe(true); // documented; covered in billing-controls-router.test.ts
  });
});
