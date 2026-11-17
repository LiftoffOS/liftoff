// billing_exempt on the LLM real-time spend path.
//
// Billing-exempt accounts run the same system customers do: real plan, real
// metering, real OU bucket drains, real dashboards, real admission. The ONE
// thing they never produce is a Stripe charge. This suite pins the boundary:
// the meter event is skipped, and everything that makes the dashboards truthful
// still happens.
//
// The gate is the explicit flag and NOT the absence of a stripe_customer_id —
// an exempt account has a real subscription and a real customer id, which is
// exactly why "no customer" was never a usable proxy for "not charged".

jest.mock('google-auth-library', () => ({
  OAuth2Client: jest.fn().mockImplementation(() => ({ verifyIdToken: jest.fn() })),
  GoogleAuth: jest.fn().mockImplementation(() => ({
    getIdTokenClient: jest.fn().mockResolvedValue({
      idTokenProvider: { fetchIdToken: jest.fn().mockResolvedValue('mock-id-token') },
    }),
    getClient: jest.fn().mockResolvedValue({}),
  })),
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const mockPoolQuery = jest.fn();
const mockClientQuery = jest.fn();
const mockClient = { query: mockClientQuery, release: jest.fn() };
jest.mock('../../infrastructure/database', () => ({
  getPool: () => ({ query: mockPoolQuery, connect: async () => mockClient }),
  withTenantScope: jest.fn(async (_t: string, fn: (c: unknown) => Promise<unknown>) =>
    fn({ query: mockClientQuery })),
}));

const mockApplyOuConsumption = jest.fn();
jest.mock('../../cost-attribution/ou-bucket-service', () => ({
  applyOuConsumption: (...a: unknown[]) => mockApplyOuConsumption(...a),
}));

const mockApplyReloadDrain = jest.fn().mockResolvedValue({ autoReloadClaim: null });
jest.mock('../../cost-attribution/reload-drain', () => ({
  applyReloadDrain: (...a: unknown[]) => mockApplyReloadDrain(...a),
}));

const mockInsertEvents = jest.fn().mockResolvedValue(undefined);
jest.mock('../../cost-attribution/repository', () => ({
  insertEvents: (...a: unknown[]) => mockInsertEvents(...a),
}));

const mockFireOuMeterEvent = jest.fn().mockResolvedValue(true);
jest.mock('../ou-meter-event', () => ({
  fireOuMeterEvent: (...a: unknown[]) => mockFireOuMeterEvent(...a),
  OU_METER_EVENT_NAME: 'operating_unit_consumed',
}));

jest.mock('../billing-admin-client', () => ({
  getBillingAdminClient: () => ({ triggerAutoReload: jest.fn() }),
}));

import { processInvocationCompleted } from '../spend-subscriber';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const ACCOUNT_ID = 'acct-exempt-1';
const STRIPE_CUSTOMER_ID = 'cus_exempt123';

const POST_PAY_ASSIGNMENT = {
  ouConsumed: 100,
  costUsd: 1.0,
  customerCostUsd: 1.0,
  costBucket: 'post_pay' as const,
  sourceIdSuffix: '',
};

function payload(invocationId: string) {
  return {
    tenantId: TENANT_ID,
    invocationId,
    costUsd: 1.0,
    occurredAt: '2026-08-07T12:00:00Z',
  };
}

/** Wire the two DB surfaces processInvocationCompleted touches: the tenant →
 *  account lookup on the pool, and the billing_controls read inside the tx. */
function setup(billingExempt: boolean): void {
  mockPoolQuery.mockResolvedValue({
    rows: [{ account_id: ACCOUNT_ID, hosting_mode: 'shared' }],
    rowCount: 1,
  });
  mockClientQuery.mockImplementation(async (sql: string) => {
    if (typeof sql === 'string' && sql.includes('FROM billing_controls')) {
      return {
        rows: [{ stripe_customer_id: STRIPE_CUSTOMER_ID, billing_exempt: billingExempt }],
        rowCount: 1,
      };
    }
    // BEGIN / ensure-row / ledger INSERT / COMMIT — rowCount 1 so the ledger
    // insert counts as new and the meter branch is reached.
    return { rows: [], rowCount: 1 };
  });
  mockApplyOuConsumption.mockResolvedValue([POST_PAY_ASSIGNMENT]);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockApplyReloadDrain.mockResolvedValue({ autoReloadClaim: null });
  mockInsertEvents.mockResolvedValue(undefined);
  mockFireOuMeterEvent.mockResolvedValue(true);
});

describe('spend-subscriber → billing_exempt account', () => {
  it('fires no Stripe meter event despite a real customer id and post-pay spend', async () => {
    setup(true);

    await processInvocationCompleted(payload('inv-exempt-1'));

    expect(mockFireOuMeterEvent).not.toHaveBeenCalled();
  });

  it('still drains the OU buckets', async () => {
    setup(true);

    await processInvocationCompleted(payload('inv-exempt-2'));

    expect(mockApplyOuConsumption).toHaveBeenCalledTimes(1);
    expect(mockApplyReloadDrain).toHaveBeenCalledTimes(1);
  });

  it('still writes the spend ledger and the cost-attribution rows', async () => {
    setup(true);

    await processInvocationCompleted(payload('inv-exempt-3'));

    const ledgerInserts = mockClientQuery.mock.calls
      .map(c => String(c[0]))
      .filter(s => s.includes('INSERT INTO billing_spend_events'));
    expect(ledgerInserts).toHaveLength(1);
    expect(mockInsertEvents).toHaveBeenCalledTimes(1);
  });

  it('commits — the exemption is not a drop', async () => {
    setup(true);

    await processInvocationCompleted(payload('inv-exempt-4'));

    const statements = mockClientQuery.mock.calls.map(c => String(c[0]));
    expect(statements).toContain('COMMIT');
    expect(statements).not.toContain('ROLLBACK');
  });
});

describe('spend-subscriber → non-exempt account is unchanged', () => {
  it('fires the meter with the invocation cost and id', async () => {
    setup(false);

    await processInvocationCompleted(payload('inv-charged-1'));

    expect(mockFireOuMeterEvent).toHaveBeenCalledTimes(1);
    const args = mockFireOuMeterEvent.mock.calls[0][0] as {
      stripeCustomerId: string; costUsd: number; identifier: string;
    };
    expect(args.stripeCustomerId).toBe(STRIPE_CUSTOMER_ID);
    expect(args.costUsd).toBe(1.0);
    expect(args.identifier).toBe('inv-charged-1');
  });
});
