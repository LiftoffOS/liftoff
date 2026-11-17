// The comparison ou-report was supposed to be.
//
// An environment with no OU usage cannot exercise this end to end: the loop
// body never runs there. So the behaviour is pinned over fixtures rather than
// by a deploy -- a green run against an empty population proves nothing.

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockAdminQuery = jest.fn();
const mockPoolQuery  = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  withAdminScope: jest.fn(async (_o: unknown, fn: (c: unknown) => Promise<unknown>) =>
    fn({ query: mockAdminQuery })),
  getPool: () => ({ query: mockPoolQuery }),
}));

jest.mock('../../infrastructure/secrets', () => ({
  getStripeSecretKey: jest.fn().mockResolvedValue('sk_test_x'),
}));

const mockMetersList = jest.fn();
const mockSummaries  = jest.fn();
jest.mock('stripe', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    billing: { meters: { list: mockMetersList, listEventSummaries: mockSummaries } },
  })),
}));

import {
  runOuMeterReconciliation,
  lastCompleteUtcDay,
  _resetStripeForTesting,
} from '../ou-meter-reconciliation-service';

const ACCT_OK     = 'aaaaaaaa-0000-0000-0000-000000000001';
const ACCT_DRIFT  = 'bbbbbbbb-0000-0000-0000-000000000002';
const ACCT_EXEMPT = 'cccccccc-0000-0000-0000-000000000003';

interface LedgerFixture {
  account_id: string; stripe_customer_id: string | null;
  billing_exempt: boolean; ledger_value: string;
}

function setup(ledger: LedgerFixture[], summariesByCustomer: Record<string, number>) {
  _resetStripeForTesting();
  mockAdminQuery.mockReset(); mockPoolQuery.mockReset();
  mockMetersList.mockReset(); mockSummaries.mockReset();

  mockMetersList.mockResolvedValue({
    data: [{ id: 'mtr_x', event_name: 'operating_unit_consumed', status: 'active' }],
  });

  mockAdminQuery.mockImplementation(async (sql: string) => {
    if (sql.includes('stripe_metered_at IS NULL')) return { rows: [{ n: '0' }] };
    return { rows: ledger };                       // the ledger-side CTE
  });
  mockPoolQuery.mockImplementation(async (sql: string) => {
    if (sql.includes('ou_meter_event_retries')) return { rows: [{ n: '0' }] };
    return { rows: [], rowCount: 1 };              // the upsert
  });
  mockSummaries.mockImplementation(async (_m: string, args: { customer: string }) => ({
    data: [{ aggregated_value: summariesByCustomer[args.customer] ?? 0 }],
  }));
}

/** The upsert calls, as {accountId, status, ledger, stripe}. */
function persisted() {
  return mockPoolQuery.mock.calls
    .filter(c => String(c[0]).includes('ou_meter_reconciliation'))
    .map(c => {
      const p = c[1] as unknown[];
      return { accountId: p[0], ledger: p[2], stripe: p[3], delta: p[4], exempt: p[5], status: p[6] };
    });
}

describe('lastCompleteUtcDay', () => {
  it('reconciles YESTERDAY, never today — Stripe summaries are eventually consistent', () => {
    const { start, end, day } = lastCompleteUtcDay(new Date('2026-08-20T04:15:00Z'));
    expect(day).toBe('2026-08-19');
    expect(start.toISOString()).toBe('2026-08-19T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-08-20T00:00:00.000Z');
  });

  it('aligns to UTC day boundaries regardless of local time of day', () => {
    const { start, end } = lastCompleteUtcDay(new Date('2026-08-20T23:59:59Z'));
    expect(start.getUTCHours()).toBe(0);
    expect(end.getUTCHours()).toBe(0);
  });
});

describe('runOuMeterReconciliation', () => {
  it('matches when Stripe agrees with the ledger', async () => {
    setup(
      [{ account_id: ACCT_OK, stripe_customer_id: 'cus_ok', billing_exempt: false, ledger_value: '12.500000' }],
      { cus_ok: 12.5 },
    );
    const r = await runOuMeterReconciliation(new Date('2026-08-20T04:00:00Z'));
    expect(r).toMatchObject({ checked: 1, matched: 1, drifted: 0, exemptMetered: 0, stripeErrors: 0 });
    expect(persisted()[0]).toMatchObject({ accountId: ACCT_OK, status: 'match' });
  });

  it('flags drift when Stripe is missing events we believe we sent', async () => {
    // The missing-meter shape: our ledger has usage, Stripe received nothing.
    setup(
      [{ account_id: ACCT_DRIFT, stripe_customer_id: 'cus_d', billing_exempt: false, ledger_value: '40.000000' }],
      { cus_d: 0 },
    );
    const r = await runOuMeterReconciliation(new Date('2026-08-20T04:00:00Z'));
    expect(r.drifted).toBe(1);
    const row = persisted()[0];
    expect(row.status).toBe('drift');
    expect(row.delta).toBeCloseTo(-40, 6);   // negative = Stripe short
  });

  it('tolerates sub-cent float noise rather than alarming on it', async () => {
    setup(
      [{ account_id: ACCT_OK, stripe_customer_id: 'cus_ok', billing_exempt: false, ledger_value: '12.500000' }],
      { cus_ok: 12.5029 },
    );
    const r = await runOuMeterReconciliation(new Date('2026-08-20T04:00:00Z'));
    expect(r.matched).toBe(1);
    expect(r.drifted).toBe(0);
  });

  it('asserts an exempt account reached Stripe NOT AT ALL, rather than skipping it', async () => {
    setup(
      [{ account_id: ACCT_EXEMPT, stripe_customer_id: 'cus_e', billing_exempt: true, ledger_value: '900.000000' }],
      { cus_e: 900 },   // exempt account accidentally metered
    );
    const r = await runOuMeterReconciliation(new Date('2026-08-20T04:00:00Z'));
    expect(r.exemptMetered).toBe(1);
    expect(r.matched).toBe(0);
    expect(persisted()[0]).toMatchObject({ accountId: ACCT_EXEMPT, exempt: true, status: 'exempt_metered' });
  });

  it('an exempt account consuming heavily with zero on Stripe is the HEALTHY case', async () => {
    setup(
      [{ account_id: ACCT_EXEMPT, stripe_customer_id: 'cus_e', billing_exempt: true, ledger_value: '4874.609000' }],
      { cus_e: 0 },
    );
    const r = await runOuMeterReconciliation(new Date('2026-08-20T04:00:00Z'));
    expect(r.matched).toBe(1);
    expect(r.exemptMetered).toBe(0);
  });

  it('records a Stripe failure as stripe_error, never as a match', async () => {
    setup(
      [{ account_id: ACCT_OK, stripe_customer_id: 'cus_ok', billing_exempt: false, ledger_value: '5.000000' }],
      {},
    );
    mockSummaries.mockRejectedValue(new Error('rate limited'));
    const r = await runOuMeterReconciliation(new Date('2026-08-20T04:00:00Z'));
    expect(r.stripeErrors).toBe(1);
    expect(r.matched).toBe(0);
    expect(persisted()[0].status).toBe('stripe_error');
  });

  it('throws rather than reporting a false all-clear when no meter exists', async () => {
    setup([], {});
    mockMetersList.mockResolvedValue({ data: [] });
    await expect(runOuMeterReconciliation(new Date('2026-08-20T04:00:00Z'))).rejects.toThrow(/no active Stripe meter/);
  });

  it('surfaces the unmetered backlog and retry-queue depth nobody was watching', async () => {
    setup(
      [{ account_id: ACCT_OK, stripe_customer_id: 'cus_ok', billing_exempt: false, ledger_value: '1.000000' }],
      { cus_ok: 1 },
    );
    mockAdminQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('stripe_metered_at IS NULL')) return { rows: [{ n: '37' }] };
      return { rows: [{ account_id: ACCT_OK, stripe_customer_id: 'cus_ok', billing_exempt: false, ledger_value: '1.000000' }] };
    });
    mockPoolQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('ou_meter_event_retries')) return { rows: [{ n: '4' }] };
      return { rows: [], rowCount: 1 };
    });
    const r = await runOuMeterReconciliation(new Date('2026-08-20T04:00:00Z'));
    expect(r.unmeteredBacklog).toBe(37);
    expect(r.retryQueueDepth).toBe(4);
  });
});

// ── The class of bug the mocks above cannot see ─────────────────────────────
// Every test in this file stubs the database, so a SQL TYPE error passes them
// all and still 500s at runtime, e.g.
//   operator does not exist: uuid = text
// because cost_attribution_events.tenant_id is TEXT while tenants.id is uuid.
//
// This asserts the join direction at the source level. It is a weak test and
// deliberately so: a strong one needs a real Postgres with the real column
// types, which this suite does not have. It exists because the failure is
// silent to every other check here and the correct form is non-obvious.
describe('the tenants join must cast the uuid side, not the column', () => {
  it('casts t.id to text rather than cae.tenant_id to uuid', () => {
     
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../ou-meter-reconciliation-service.ts'), 'utf8');

    expect(src).toContain('t.id::text = cae.tenant_id');
    // gcp_billing_platform rows carry tenant_id='platform'. Casting the column
    // to uuid raises 22P02 on that row and takes the whole run down.
    expect(src).not.toContain('cae.tenant_id::uuid');
  });
});
