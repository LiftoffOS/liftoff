// The statements themselves, where the scope and the predicate ARE the
// behaviour.
//
// Every method here is one SQL statement, so mocking the two scope wrappers and
// reading what reaches the client is the only level at which these properties
// are observable at all. Three of them are load-bearing:
//
//   WHICH SCOPE. The referrer's own reads run under withTenantScope, where the
//   RLS policy on `referrals` is keyed on referrer_tenant_id. Binding runs under
//   withAdminScope because it happens at ACCOUNT creation, when the person
//   signing up has no workspace and the code is the only thing that identifies
//   the referring tenant. Getting these the wrong way round would either leak
//   across tenants or return zero rows in production and nowhere else.
//
//   WHAT THE SWEEP TOUCHES. `expired` is presentational and must be reversible:
//   a workspace that subscribes on day 200 moves back to `subscribed` and earns.
//   A sweep that caught anything but `signed_up` would silently unwind
//   conversions.
//
//   WHAT THE ATTACH REFUSES. The referred workspace is the account's FIRST one.
//   Without that condition a later workspace inherits an attribution that was
//   never about it.

import { ReferralRepository } from '../repository';
import { withAdminScope, withTenantScope } from '../../infrastructure/database';

jest.mock('../../infrastructure/database', () => ({
  withTenantScope: jest.fn(),
  withAdminScope: jest.fn(),
}));

const mockTenantScope = withTenantScope as jest.MockedFunction<typeof withTenantScope>;
const mockAdminScope = withAdminScope as jest.MockedFunction<typeof withAdminScope>;

const TENANT = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = '44444444-4444-4444-8444-444444444444';

/** Captures every statement a scope wrapper's callback issues. */
function captureStatements(rows: Record<string, unknown>[] = [], rowCount = 1) {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      statements.push({ sql, params: params ?? [] });
      return { rows, rowCount };
    }),
  };
  const run = async (...args: unknown[]) => {
    const fn = args[args.length - 1] as (c: unknown) => unknown;
    return fn(client);
  };
  mockTenantScope.mockImplementation(run as never);
  mockAdminScope.mockImplementation(run as never);
  return statements;
}

beforeEach(() => jest.clearAllMocks());

describe('scope selection', () => {
  it('reads the referrer own list under tenant scope', async () => {
    captureStatements([]);

    await new ReferralRepository().listForReferrer(TENANT, 50, null);

    expect(mockTenantScope).toHaveBeenCalledWith(TENANT, expect.any(Function));
    expect(mockAdminScope).not.toHaveBeenCalled();
  });

  it('resolves a share code under admin scope, because no tenant is known yet', async () => {
    captureStatements([{ tenant_id: TENANT, account_id: ACCOUNT }]);

    await new ReferralRepository().adminResolveCode('northwind-7f3a');

    expect(mockAdminScope).toHaveBeenCalled();
    expect(mockTenantScope).not.toHaveBeenCalled();
  });
});

describe('the referrer list query', () => {
  it('orders newest signup first with ties on id, and takes one extra row', async () => {
    const statements = captureStatements([]);

    await new ReferralRepository().listForReferrer(TENANT, 50, null);

    // Cursor pagination over an undefined order duplicates and skips rows, so
    // this ordering is a correctness requirement rather than a preference.
    expect(statements[0].sql).toContain('ORDER BY r.signed_up_at DESC, r.id DESC');
    expect(statements[0].params).toEqual([TENANT, 51]);
  });

  it('adds a typed keyset predicate when resuming from a cursor', async () => {
    const statements = captureStatements([]);
    const at = new Date('2026-01-30T00:00:00.000Z');

    await new ReferralRepository().listForReferrer(TENANT, 50, { signedUpAt: at, id: 'ref_1' });

    expect(statements[0].sql).toContain('($3::timestamptz, $4::uuid)');
    expect(statements[0].params).toEqual([TENANT, 51, at, 'ref_1']);
  });
});

describe('the daily invite cap', () => {
  it('counts from a UTC midnight that stays UTC', async () => {
    const statements = captureStatements([{ count: '4' }]);

    await new ReferralRepository().countInvitesSentToday(TENANT);

    // `NOW() AT TIME ZONE 'UTC'` alone yields a timestamp WITHOUT a zone, which
    // a timestamptz comparison re-attaches to the SESSION's zone — moving the
    // cap's reset by hours on any database not set to UTC, with nothing
    // failing. The trailing conversion is what pins it.
    expect(statements[0].sql).toContain("date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'");
  });
});

describe('binding', () => {
  it('is idempotent on the referrer and account pair', async () => {
    const statements = captureStatements([
      {
        id: 'ref_1',
        referrer_tenant_id: TENANT,
        referred_tenant_id: null,
        referred_account_id: ACCOUNT,
        code: 'northwind-7f3a',
        clicked_at: null,
        signed_up_at: new Date(),
        subscribed_at: null,
        status: 'signed_up',
        ineligible_reason: null,
      },
    ]);

    await new ReferralRepository().adminBind({
      referrerTenantId: TENANT,
      referredAccountId: ACCOUNT,
      code: 'northwind-7f3a',
      clickedAt: null,
      ineligibleReason: null,
    });

    // A retried signup must re-bind the same pair rather than add a second row
    // to the referrer's list, and must not overwrite a recorded ineligibility.
    expect(statements[0].sql).toContain(
      'ON CONFLICT (referrer_tenant_id, referred_account_id) DO NOTHING',
    );
  });
});

describe('attaching the referred workspace', () => {
  it('claims only the account first workspace, and only an unclaimed row', async () => {
    const statements = captureStatements([], 1);

    const attached = await new ReferralRepository().adminAttachReferredTenant(ACCOUNT, TENANT);

    expect(attached).toBe(true);
    expect(statements[0].sql).toContain('referred_tenant_id IS NULL');
    expect(statements[0].sql).toContain(
      '(SELECT COUNT(*) FROM tenants WHERE account_id = $1) = 1',
    );
  });

  it('reports no attach when nothing matched', async () => {
    captureStatements([], 0);

    expect(await new ReferralRepository().adminAttachReferredTenant(ACCOUNT, TENANT)).toBe(false);
  });
});

describe('the stale-signup sweep', () => {
  it('touches only rows that are still signed_up', async () => {
    const statements = captureStatements([], 7);
    const cutoff = new Date('2026-03-07T00:00:00.000Z');

    const expired = await new ReferralRepository().adminExpireStaleSignups(cutoff);

    expect(expired).toBe(7);
    // Anything wider would silently unwind conversions: `expired` is
    // presentational and a late subscription must move the row back.
    expect(statements[0].sql).toContain("WHERE status = 'signed_up'");
    expect(statements[0].sql).toContain('signed_up_at < $1');
    expect(statements[0].params).toEqual([cutoff]);
  });
});

describe('recording the conversion', () => {
  it('sets the status unconditionally, which is what makes expiry reversible', async () => {
    const statements = captureStatements([
      {
        id: 'ref_1',
        referrer_tenant_id: TENANT,
        referred_tenant_id: null,
        referred_account_id: ACCOUNT,
        code: 'c',
        clicked_at: null,
        signed_up_at: new Date(),
        subscribed_at: new Date(),
        status: 'subscribed',
        ineligible_reason: null,
      },
    ]);

    await new ReferralRepository().adminMarkSubscribed('ref_1', new Date());

    expect(statements[0].sql).toContain("SET status        = 'subscribed'");
    // The date is never moved once set — a redelivered invoice must not
    // restart the 60-day hold.
    expect(statements[0].sql).toContain('subscribed_at = COALESCE(subscribed_at, $2)');
  });

  it('keeps the FIRST ineligibility reason rather than relabelling', async () => {
    const statements = captureStatements([
      {
        id: 'ref_1',
        referrer_tenant_id: TENANT,
        referred_tenant_id: null,
        referred_account_id: ACCOUNT,
        code: 'c',
        clicked_at: null,
        signed_up_at: new Date(),
        subscribed_at: null,
        status: 'signed_up',
        ineligible_reason: 'existing_account',
      },
    ]);

    await new ReferralRepository().adminMarkIneligible('ref_1', 'discounted_signup');

    // A row already marked `existing_account` at binding must not become
    // `discounted_signup` when its invoice arrives: the earlier fact is the one
    // that actually disqualified it.
    expect(statements[0].sql).toContain('COALESCE(ineligible_reason, $2)');
  });
});
