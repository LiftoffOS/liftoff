// Tests for readAccountState + inferHealthIssues — PR 3 / Gap A.
//
// Unit-style mocks per Q4 — no real Postgres, no real Stripe.

const mockSubscriptionsList = jest.fn();
const mockSubscriptionsSearch = jest.fn();

jest.mock('stripe', () => {
  const RealStripe = jest.requireActual('stripe');
  const mockInstance = {
    subscriptions: {
      list: mockSubscriptionsList,
      search: mockSubscriptionsSearch,
    },
  };
  const MockStripe = jest.fn(() => mockInstance) as unknown as {
    (...args: unknown[]): typeof mockInstance;
    errors: typeof RealStripe.errors;
  };
  MockStripe.errors = RealStripe.errors;
  return { __esModule: true, default: MockStripe };
});

const mockPoolQuery = jest.fn();
jest.mock('../infrastructure/database', () => ({
  getPool: jest.fn(() => ({ query: mockPoolQuery })),
  // The tenant_members / entitlements JOINs in readAccountState run under
  // withAdminScope (RLS-force); route the client to the same mockPoolQuery so
  // the Promise.all call order and per-SQL responses are preserved.
  withAdminScope: (_opts: unknown, fn: (c: { query: typeof mockPoolQuery }) => unknown) =>
    fn({ query: mockPoolQuery }),
}));

jest.mock('../infrastructure/secrets', () => ({
  getStripeSecretKey: jest.fn(async () => 'sk_test_dummy'),
}));

const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../infrastructure/logging', () => ({ log: mockLog }));

import Stripe from 'stripe';
import { readAccountState, inferHealthIssues, type AccountStateSnapshot } from './account-state-service';
import { AccountNotFoundError } from '../accounts/service';

const ACCOUNT_ID = '11111111-1111-1111-1111-111111111111';
const TENANT_ID_OLD = '22222222-2222-2222-2222-222222222222';
const TENANT_ID_NEW = '33333333-3333-3333-3333-333333333333';
const CUSTOMER_ID = 'cus_test_state';
const SUB_ID = 'sub_test_state';

// Program the six in-order Promise.all DB queries that readAccountState runs.
function programDb(options: {
  accountRows?: unknown[];
  tenantsRows?: unknown[];
  entitlementsRows?: unknown[];
  billingControlsRows?: unknown[];
  contractRows?: unknown[];
  subscriptionsRows?: unknown[];
}): void {
  mockPoolQuery
    .mockResolvedValueOnce({ rows: options.accountRows ?? [] })
    .mockResolvedValueOnce({ rows: options.tenantsRows ?? [] })
    .mockResolvedValueOnce({ rows: options.entitlementsRows ?? [] })
    .mockResolvedValueOnce({ rows: options.billingControlsRows ?? [] })
    .mockResolvedValueOnce({ rows: options.contractRows ?? [] })
    .mockResolvedValueOnce({ rows: options.subscriptionsRows ?? [] });
}

function defaultAccountRow(): Record<string, unknown> {
  return {
    id: ACCOUNT_ID,
    email: 'admin@example.com',
    stripe_customer_id: CUSTOMER_ID,
    is_platform_admin: false,
  };
}

function defaultTenantRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: TENANT_ID_OLD,
    name: 'Primary',
    status: 'active',
    gcp_project_id: null,
    database_name: null,
    created_at: new Date('2026-01-01T00:00:00Z'),
    role: 'owner',
    ...overrides,
  };
}

function defaultBcRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    account_id: ACCOUNT_ID,
    billing_tier: 'enterprise',
    stripe_customer_id: CUSTOMER_ID,
    stripe_subscription_id: SUB_ID,
    suspended: false,
    suspended_reason: null,
    current_period_spend_usd: '0.00',
    reload_balance_usd: '0.00',
    updated_at: new Date('2026-05-17T00:00:00Z'),
    ...overrides,
  };
}

function defaultContractRow(): Record<string, unknown> {
  return {
    account_id: ACCOUNT_ID,
    included_ous: '10000000',
    precommit_extra_ous: '0',
    included_rate_usd_per_ou: '0.02',
    precommit_rate_usd_per_ou: '0.02',
    reload_rate_usd_per_ou: '0.02',
    stripe_billed: false,
    is_annual_plan: false,
    annual_total_usd_cents: null,
    effective_from: new Date('2026-01-01T00:00:00Z'),
    effective_to: null,
    contract_reference: 'MSA-test',
  };
}

function stripeSub(
  id: string,
  status: Stripe.Subscription.Status,
  customer: string,
  metadata: Record<string, string> = {},
): Stripe.Subscription {
  return { id, status, customer, metadata } as unknown as Stripe.Subscription;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSubscriptionsList.mockResolvedValue({ data: [] });
  mockSubscriptionsSearch.mockResolvedValue({ data: [] });
});

describe('readAccountState', () => {
  it('returns the full snapshot for a healthy account', async () => {
    programDb({
      accountRows: [defaultAccountRow()],
      tenantsRows: [defaultTenantRow()],
      entitlementsRows: [
        {
          tenant_id: TENANT_ID_OLD,
          tenant_operational_status: 'active',
          agent_execution_allowed: true,
          remaining_included_credits: 0,
          overage_allowed: true,
        },
      ],
      billingControlsRows: [defaultBcRow()],
      contractRows: [defaultContractRow()],
      subscriptionsRows: [
        {
          id: 'sub_local_1',
          plan_id: 'enterprise',
          stripe_subscription_id: SUB_ID,
          status: 'active',
          current_period_start: new Date('2026-05-01T00:00:00Z'),
          current_period_end: new Date('2026-06-01T00:00:00Z'),
          updated_at: new Date('2026-05-17T00:00:00Z'),
        },
      ],
    });
    mockSubscriptionsList.mockResolvedValueOnce({
      data: [stripeSub(SUB_ID, 'active', CUSTOMER_ID, { tenant_id: TENANT_ID_OLD })],
    });

    const snapshot = await readAccountState(ACCOUNT_ID);

    expect(snapshot.account.id).toBe(ACCOUNT_ID);
    expect(snapshot.account.email).toBe('admin@example.com');
    expect(snapshot.tenants).toHaveLength(1);
    expect(snapshot.tenants[0].id).toBe(TENANT_ID_OLD);
    expect(snapshot.tenants[0].role).toBe('owner');
    expect(snapshot.entitlements).toHaveLength(1);
    expect(snapshot.billingControls?.billingTier).toBe('enterprise');
    expect(snapshot.contract?.contractReference).toBe('MSA-test');
    expect(snapshot.subscriptions).toHaveLength(1);
    expect(snapshot.stripe.activeSubscription?.id).toBe(SUB_ID);
    expect(snapshot.stripe.allSubscriptions).toHaveLength(1);
    expect(snapshot.stripe.allSubscriptions[0].id).toBe(SUB_ID);
    expect(snapshot.stripe.orphanSubscriptions).toEqual([]);
    expect(snapshot.stripe.searchAvailable).toBe(true);
  });

  it('throws AccountNotFoundError when account row is missing', async () => {
    programDb({ accountRows: [] });
    await expect(readAccountState(ACCOUNT_ID)).rejects.toBeInstanceOf(AccountNotFoundError);
  });

  it('surfaces multi-tenant accounts with primary = earliest created_at', async () => {
    programDb({
      accountRows: [defaultAccountRow()],
      tenantsRows: [
        defaultTenantRow({ id: TENANT_ID_OLD, created_at: new Date('2026-01-01T00:00:00Z') }),
        defaultTenantRow({ id: TENANT_ID_NEW, created_at: new Date('2026-03-01T00:00:00Z'), name: 'Secondary' }),
      ],
    });

    const snapshot = await readAccountState(ACCOUNT_ID);

    expect(snapshot.tenants).toHaveLength(2);
    expect(snapshot.tenants[0].id).toBe(TENANT_ID_OLD);
    expect(snapshot.tenants[1].id).toBe(TENANT_ID_NEW);
    // Stripe search MUST fire when stripeCustomerId + primaryTenantId are
    // present, and MUST be keyed on the primary tenant id (the first one,
    // not the secondary). Two calls — one per status — because Stripe Search
    // disallows mixing AND with OR in a single query.
    expect(mockSubscriptionsSearch).toHaveBeenCalledTimes(2);
    for (const call of mockSubscriptionsSearch.mock.calls) {
      const queryArg = call[0];
      expect(queryArg.query).toContain(TENANT_ID_OLD);
      expect(queryArg.query).not.toContain(TENANT_ID_NEW);
    }
  });

  it('includes per-tenant role from tenant_members JOIN', async () => {
    programDb({
      accountRows: [defaultAccountRow()],
      tenantsRows: [
        defaultTenantRow({ role: 'admin' }),
        defaultTenantRow({ id: TENANT_ID_NEW, role: null }),
      ],
    });

    const snapshot = await readAccountState(ACCOUNT_ID);
    expect(snapshot.tenants[0].role).toBe('admin');
    expect(snapshot.tenants[1].role).toBeNull();
  });

  it('degrades gracefully on Stripe rate-limit (sets searchAvailable=false, leaves orphan list empty)', async () => {
    programDb({
      accountRows: [defaultAccountRow()],
      tenantsRows: [defaultTenantRow()],
    });
    mockSubscriptionsSearch.mockRejectedValueOnce(
      new Stripe.errors.StripeRateLimitError({
        message: 'too many',
        type: 'rate_limit_error',
      }),
    );

    const snapshot = await readAccountState(ACCOUNT_ID);

    expect(snapshot.stripe.searchAvailable).toBe(false);
    expect(snapshot.stripe.orphanSubscriptions).toEqual([]);
    // The rest of the snapshot is unaffected.
    expect(snapshot.tenants).toHaveLength(1);
  });

  it('propagates non-rate-limit Stripe errors from the search call (P3-A — no broad swallow)', async () => {
    programDb({
      accountRows: [defaultAccountRow()],
      tenantsRows: [defaultTenantRow()],
    });
    const apiErr = new Stripe.errors.StripeAPIError({
      message: 'Stripe down',
      type: 'api_error',
    });
    mockSubscriptionsSearch.mockRejectedValueOnce(apiErr);

    await expect(readAccountState(ACCOUNT_ID)).rejects.toBe(apiErr);
  });

  it('propagates Stripe .list() failures (P3-B — plan only authorizes degradation for the search path)', async () => {
    programDb({
      accountRows: [defaultAccountRow()],
      tenantsRows: [defaultTenantRow()],
    });
    const listErr = new Stripe.errors.StripeAPIError({
      message: 'list down',
      type: 'api_error',
    });
    mockSubscriptionsList.mockRejectedValueOnce(listErr);

    await expect(readAccountState(ACCOUNT_ID)).rejects.toBe(listErr);
  });
});

describe('inferHealthIssues', () => {
  function snapshot(overrides: Partial<AccountStateSnapshot> = {}): AccountStateSnapshot {
    return {
      account: {
        id: ACCOUNT_ID,
        email: 'admin@example.com',
        stripeCustomerId: CUSTOMER_ID,
        isPlatformAdmin: false,
      },
      tenants: [],
      entitlements: [],
      billingControls: null,
      contract: null,
      subscriptions: [],
      stripe: {
        activeSubscription: null,
        allSubscriptions: [],
        orphanSubscriptions: [],
        searchAvailable: true,
      },
      ...overrides,
    };
  }

  it('returns ok=true with empty issues on a clean account', () => {
    const issues = inferHealthIssues(snapshot());
    expect(issues).toEqual([]);
  });

  it('flags orphan Stripe subscriptions', () => {
    const issues = inferHealthIssues(snapshot({
      stripe: {
        activeSubscription: null,
        allSubscriptions: [],
        orphanSubscriptions: [
          { id: 'sub_orphan', status: 'active', customer: 'cus_other', metadata: {} },
        ],
        searchAvailable: true,
      },
    }));
    expect(issues).toContain('stripe_orphan_subscriptions_present');
  });

  it('flags customer mismatch between Stripe active sub and billing_controls', () => {
    const issues = inferHealthIssues(snapshot({
      billingControls: {
        accountId: ACCOUNT_ID,
        billingTier: 'enterprise',
        stripeCustomerId: 'cus_canonical',
        stripeSubscriptionId: SUB_ID,
        suspended: false,
        suspendedReason: null,
        currentPeriodSpendUsd: '0',
        prepaidBalanceUsd: '0',
        updatedAt: new Date().toISOString(),
      },
      stripe: {
        activeSubscription: { id: SUB_ID, status: 'active', customer: 'cus_different', metadata: {} },
        allSubscriptions: [{ id: SUB_ID, status: 'active', customer: 'cus_different', metadata: {} }],
        orphanSubscriptions: [],
        searchAvailable: true,
      },
    }));
    expect(issues).toContain('stripe_active_sub_customer_mismatch');
  });

  it('flags stale local active sub vs canceled/missing Stripe sub', () => {
    const issues = inferHealthIssues(snapshot({
      subscriptions: [
        {
          id: 'sub_local_1',
          planId: 'enterprise',
          stripeSubscriptionId: 'sub_stale',
          status: 'active',
          currentPeriodStart: null,
          currentPeriodEnd: null,
          updatedAt: new Date().toISOString(),
        },
      ],
      // No active Stripe sub returned for this customer.
      stripe: {
        activeSubscription: null,
        allSubscriptions: [],
        orphanSubscriptions: [],
        searchAvailable: true,
      },
    }));
    expect(issues).toContain('local_active_sub_diverged_from_stripe');
  });

  it('flags billing_controls.stripe_subscription_id missing from Stripe', () => {
    const issues = inferHealthIssues(snapshot({
      billingControls: {
        accountId: ACCOUNT_ID,
        billingTier: 'enterprise',
        stripeCustomerId: CUSTOMER_ID,
        stripeSubscriptionId: 'sub_nonexistent',
        suspended: false,
        suspendedReason: null,
        currentPeriodSpendUsd: '0',
        prepaidBalanceUsd: '0',
        updatedAt: new Date().toISOString(),
      },
      // No active Stripe sub for the customer; orphan list empty.
      stripe: {
        activeSubscription: null,
        allSubscriptions: [],
        orphanSubscriptions: [],
        searchAvailable: true,
      },
    }));
    expect(issues).toContain('billing_controls_subscription_missing_from_stripe');
  });

  it('flags enterprise contract present but billing_tier not enterprise', () => {
    const issues = inferHealthIssues(snapshot({
      billingControls: {
        accountId: ACCOUNT_ID,
        billingTier: 'standard',
        stripeCustomerId: CUSTOMER_ID,
        stripeSubscriptionId: null,
        suspended: false,
        suspendedReason: null,
        currentPeriodSpendUsd: '0',
        prepaidBalanceUsd: '0',
        updatedAt: new Date().toISOString(),
      },
      contract: {
        accountId: ACCOUNT_ID,
        includedOus: '1', precommitExtraOus: '0',
        includedRateUsdPerOu: '0', precommitRateUsdPerOu: '0', reloadRateUsdPerOu: '0',
        stripeBilled: false, isAnnualPlan: false, annualTotalUsdCents: null,
        effectiveFrom: new Date().toISOString(), effectiveTo: null, contractReference: null,
      },
    }));
    expect(issues).toContain('contract_present_but_tier_not_enterprise');
  });

  it('flags suspended billing_controls with an active Stripe sub', () => {
    const issues = inferHealthIssues(snapshot({
      billingControls: {
        accountId: ACCOUNT_ID,
        billingTier: 'enterprise',
        stripeCustomerId: CUSTOMER_ID,
        stripeSubscriptionId: SUB_ID,
        suspended: true,
        suspendedReason: 'manual',
        currentPeriodSpendUsd: '0',
        prepaidBalanceUsd: '0',
        updatedAt: new Date().toISOString(),
      },
      stripe: {
        activeSubscription: { id: SUB_ID, status: 'active', customer: CUSTOMER_ID, metadata: {} },
        allSubscriptions: [{ id: SUB_ID, status: 'active', customer: CUSTOMER_ID, metadata: {} }],
        orphanSubscriptions: [],
        searchAvailable: true,
      },
    }));
    expect(issues).toContain('billing_controls_suspended_but_stripe_active');
  });

  it('surfaces stripe_search_unavailable when the search degraded', () => {
    const issues = inferHealthIssues(snapshot({
      stripe: {
        activeSubscription: null,
        allSubscriptions: [],
        orphanSubscriptions: [],
        searchAvailable: false,
      },
    }));
    expect(issues).toContain('stripe_search_unavailable');
  });

  it('does NOT flag billing_controls_subscription_missing_from_stripe when the sub is canceled-but-exists (P3-D regression)', () => {
    // bc.stripeSubscriptionId points to a canceled sub; Stripe's status='all'
    // list returned it, so we know it exists — just terminated. Should NOT
    // flag as missing.
    const issues = inferHealthIssues(snapshot({
      billingControls: {
        accountId: ACCOUNT_ID,
        billingTier: 'enterprise',
        stripeCustomerId: CUSTOMER_ID,
        stripeSubscriptionId: SUB_ID,
        suspended: false,
        suspendedReason: null,
        currentPeriodSpendUsd: '0',
        prepaidBalanceUsd: '0',
        updatedAt: new Date().toISOString(),
      },
      stripe: {
        activeSubscription: null,
        allSubscriptions: [{ id: SUB_ID, status: 'canceled', customer: CUSTOMER_ID, metadata: {} }],
        orphanSubscriptions: [],
        searchAvailable: true,
      },
    }));
    expect(issues).not.toContain('billing_controls_subscription_missing_from_stripe');
  });
});
