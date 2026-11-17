// The referral programme's decisions, tested where they are actually made.
//
// Three of these lock rules that are one careless edit away from being wrong in
// a way nothing else would catch: the cursor, because an unstable order makes
// Load more duplicate and skip rows; the binding exclusions, because they are
// the difference between a referral that pays and one that does not; and the
// invite gate, which is the enforcement rather than the rendering hint.

import { ReferralRepository } from '../repository';
import {
  creditStatusFor,
  decodeCursor,
  encodeCursor,
  InvitesNotPermittedError,
  ReferralService,
  sanitizeInviteMessage,
} from '../service';
import { getBillingAdminClient } from '../../billing/billing-admin-client';
import { sendReferralInviteEmail } from '../../infrastructure/email';
import { TenantRepository } from '../../tenants/repository';
import {
  REFERRAL_INVITES_PER_DAY,
  REFERRAL_SIGNUP_EXPIRY_DAYS,
  REFERRAL_THROTTLE_MIN_SENT,
} from '../constants';

jest.mock('../repository');
jest.mock('../../tenants/repository');
jest.mock('../../accounts/repository');
jest.mock('../../billing/billing-admin-client');
jest.mock('../../infrastructure/email', () => ({ sendReferralInviteEmail: jest.fn() }));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const TENANT = '11111111-1111-4111-8111-111111111111';
const REFERRER_ACCOUNT = '33333333-3333-4333-8333-333333333333';
const NEW_ACCOUNT = '44444444-4444-4444-8444-444444444444';

const MockRepo = ReferralRepository as jest.MockedClass<typeof ReferralRepository>;
const MockTenantRepo = TenantRepository as jest.MockedClass<typeof TenantRepository>;
const mockBillingClient = getBillingAdminClient as jest.MockedFunction<typeof getBillingAdminClient>;

/** The money half, which always comes from billing. */
function billingSays(overrides: Partial<{
  creditEarnedUsd: number;
  creditAppliedUsd: number;
  creditAvailableUsd: number;
  convertedCount: number;
  subscriptionActive: boolean;
}> = {}) {
  const summary = {
    creditEarnedUsd: 0,
    creditAppliedUsd: 0,
    creditAvailableUsd: 0,
    convertedCount: 0,
    subscriptionActive: true,
    ...overrides,
  };
  mockBillingClient.mockReturnValue({
    getReferralCreditSummary: jest.fn(async () => summary),
    getReferralCredits: jest.fn(async () => []),
  } as unknown as ReturnType<typeof getBillingAdminClient>);
  return summary;
}

beforeEach(() => {
  jest.clearAllMocks();
  MockRepo.prototype.findCodeByTenant = jest.fn(async () => 'northwind-7f3a');
  MockRepo.prototype.issueCode = jest.fn(async (_t: string, code: string) => code);
  MockRepo.prototype.countPending = jest.fn(async () => 0);
  MockRepo.prototype.inviteAcceptanceStats = jest.fn(async () => ({ sent: 0, accepted: 0 }));
  MockRepo.prototype.countInvitesSentToday = jest.fn(async () => 0);
  MockRepo.prototype.findInvitedEmails = jest.fn(async () => new Set<string>());
  MockRepo.prototype.findAccountIdsByEmail = jest.fn(async () => new Set<string>());
  MockRepo.prototype.recordInvites = jest.fn(async () => undefined);
  MockRepo.prototype.adminMarkInviteAccepted = jest.fn(async () => undefined);
  MockTenantRepo.prototype.findById = jest.fn(async () => ({
    id: TENANT,
    accountId: REFERRER_ACCOUNT,
    name: 'Northwind',
  }) as never);
  (sendReferralInviteEmail as jest.Mock).mockResolvedValue('email_1');
  billingSays();
});

// ── Binding ──────────────────────────────────────────────────────────────────

describe('binding a code at account creation', () => {
  function resolvesTo(accountId: string) {
    MockRepo.prototype.adminResolveCode = jest.fn(async () => ({
      tenantId: TENANT,
      accountId,
    }));
  }

  function bindReturns() {
    MockRepo.prototype.adminBind = jest.fn(async (input) => ({
      id: 'ref_1',
      referrerTenantId: input.referrerTenantId,
      referredTenantId: null,
      referredAccountId: input.referredAccountId,
      code: input.code,
      clickedAt: input.clickedAt,
      signedUpAt: new Date(),
      subscribedAt: null,
      status: 'signed_up' as const,
      ineligibleReason: input.ineligibleReason,
    }));
  }

  it('records a fresh signup with no ineligibility', async () => {
    resolvesTo(REFERRER_ACCOUNT);
    MockRepo.prototype.adminFindByReferredAccount = jest.fn(async () => []);
    bindReturns();

    const row = await new ReferralService().bindOnAccountCreation({
      accountId: NEW_ACCOUNT,
      email: 'jordan@example.com',
      code: 'northwind-7f3a',
      clickedAt: new Date(),
      accountPreexisted: false,
    });

    expect(row?.ineligibleReason).toBeNull();
    // The invitation this signup answers is only credited when the referral
    // actually earns, or a workspace could launder its acceptance ratio.
    expect(MockRepo.prototype.adminMarkInviteAccepted).toHaveBeenCalledWith(
      TENANT,
      'jordan@example.com',
    );
  });

  it('marks an account that already existed, and still writes the row', async () => {
    resolvesTo(REFERRER_ACCOUNT);
    MockRepo.prototype.adminFindByReferredAccount = jest.fn(async () => []);
    bindReturns();

    const row = await new ReferralService().bindOnAccountCreation({
      accountId: NEW_ACCOUNT,
      email: 'jordan@example.com',
      code: 'northwind-7f3a',
      clickedAt: new Date(),
      accountPreexisted: true,
    });

    // Visible, not dropped: the referrer controls none of the exclusions and
    // can see none of them, so the reason has to reach the page.
    expect(row?.ineligibleReason).toBe('existing_account');
    expect(MockRepo.prototype.adminMarkInviteAccepted).not.toHaveBeenCalled();
  });

  it('marks a code that resolves to the signer-up own account', async () => {
    resolvesTo(NEW_ACCOUNT);
    MockRepo.prototype.adminFindByReferredAccount = jest.fn(async () => []);
    bindReturns();

    const row = await new ReferralService().bindOnAccountCreation({
      accountId: NEW_ACCOUNT,
      email: 'jordan@example.com',
      code: 'northwind-7f3a',
      clickedAt: new Date(),
      accountPreexisted: false,
    });

    expect(row?.ineligibleReason).toBe('self_referral');
  });

  it('marks a second referrer as already_referred rather than dropping them', async () => {
    resolvesTo(REFERRER_ACCOUNT);
    MockRepo.prototype.adminFindByReferredAccount = jest.fn(async () => [
      {
        id: 'ref_0',
        referrerTenantId: '99999999-9999-4999-8999-999999999999',
        referredTenantId: null,
        referredAccountId: NEW_ACCOUNT,
        code: 'someone-else-0001',
        clickedAt: null,
        signedUpAt: new Date(),
        subscribedAt: null,
        status: 'signed_up' as const,
        ineligibleReason: null,
      },
    ]);
    bindReturns();

    const row = await new ReferralService().bindOnAccountCreation({
      accountId: NEW_ACCOUNT,
      email: 'jordan@example.com',
      code: 'northwind-7f3a',
      clickedAt: new Date(),
      accountPreexisted: false,
    });

    expect(row?.ineligibleReason).toBe('already_referred');
  });

  it('does not bind a click older than the attribution window', async () => {
    resolvesTo(REFERRER_ACCOUNT);
    MockRepo.prototype.adminBind = jest.fn();

    const row = await new ReferralService().bindOnAccountCreation({
      accountId: NEW_ACCOUNT,
      email: 'jordan@example.com',
      code: 'northwind-7f3a',
      clickedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
      accountPreexisted: false,
    });

    expect(row).toBeNull();
    expect(MockRepo.prototype.adminBind).not.toHaveBeenCalled();
  });

  it('never throws, because a signup must not fail on a referral', async () => {
    MockRepo.prototype.adminResolveCode = jest.fn(async () => {
      throw new Error('database on fire');
    });

    await expect(
      new ReferralService().bindOnAccountCreation({
        accountId: NEW_ACCOUNT,
        email: 'jordan@example.com',
        code: 'northwind-7f3a',
        clickedAt: null,
        accountPreexisted: false,
      }),
    ).resolves.toBeNull();
  });
});

// ── The programme payload ────────────────────────────────────────────────────

describe('the programme payload', () => {
  it('takes every money figure from billing and computes none of its own', async () => {
    billingSays({
      creditEarnedUsd: 40,
      creditAppliedUsd: 20,
      creditAvailableUsd: 20,
      convertedCount: 2,
      subscriptionActive: true,
    });
    MockRepo.prototype.countPending = jest.fn(async () => 1);

    const program = await new ReferralService().getProgram(TENANT);

    expect(program.creditEarnedUsd).toBe(40);
    expect(program.creditAppliedUsd).toBe(20);
    expect(program.creditAvailableUsd).toBe(20);
    expect(program.convertedCount).toBe(2);
    expect(program.pendingCount).toBe(1);
    // The identity the page renders side by side.
    expect(program.creditEarnedUsd).toBe(program.creditAppliedUsd + program.creditAvailableUsd);
  });

  it('withdraws redemption and invites when there is no subscription', async () => {
    billingSays({ subscriptionActive: false });

    const program = await new ReferralService().getProgram(TENANT);

    // Earning is NOT withdrawn: an unpaid workspace accumulates and waits.
    expect(program.creditRedeemable).toBe(false);
    expect(program.canSendInvites).toBe(false);
  });

  it('withdraws invites, but not redemption, when the acceptance ratio trips', async () => {
    billingSays({ subscriptionActive: true });
    MockRepo.prototype.inviteAcceptanceStats = jest.fn(async () => ({
      sent: REFERRAL_THROTTLE_MIN_SENT,
      accepted: 0,
    }));

    const program = await new ReferralService().getProgram(TENANT);

    expect(program.canSendInvites).toBe(false);
    expect(program.creditRedeemable).toBe(true);
  });

  it('serves zeros rather than failing when billing cannot answer', async () => {
    mockBillingClient.mockReturnValue({
      getReferralCreditSummary: jest.fn(async () => {
        throw new Error('billing unreachable');
      }),
      getReferralCredits: jest.fn(async () => []),
    } as unknown as ReturnType<typeof getBillingAdminClient>);

    const program = await new ReferralService().getProgram(TENANT);

    expect(program.creditEarnedUsd).toBe(0);
    // Conservative in the direction that matters: nothing that needs a
    // subscription is permitted when we could not confirm there is one.
    expect(program.creditRedeemable).toBe(false);
    expect(program.canSendInvites).toBe(false);
    expect(program.code).toBe('northwind-7f3a');
  });
});

// ── The list ─────────────────────────────────────────────────────────────────

describe('the referral list', () => {
  function rows(count: number) {
    return Array.from({ length: count }, (_, i) => ({
      id: `ref_${i}`,
      referrerTenantId: TENANT,
      referredTenantId: null,
      referredAccountId: NEW_ACCOUNT,
      code: 'northwind-7f3a',
      clickedAt: null,
      signedUpAt: new Date(Date.UTC(2026, 0, 30 - i)),
      subscribedAt: null,
      status: 'signed_up' as const,
      ineligibleReason: null,
      email: `p${i}@example.com`,
      name: null,
    }));
  }

  it('asks for one more row than the page, so hasMore is a fact', async () => {
    MockRepo.prototype.listForReferrer = jest.fn(async () => rows(3));

    const page = await new ReferralService().listReferrals(TENANT, 2, null);

    expect(MockRepo.prototype.listForReferrer).toHaveBeenCalledWith(TENANT, 2, null);
    expect(page.referrals).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).not.toBeNull();
  });

  it('ends the list cleanly when the last page is short', async () => {
    MockRepo.prototype.listForReferrer = jest.fn(async () => rows(2));

    const page = await new ReferralService().listReferrals(TENANT, 2, null);

    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it('resumes from the cursor it handed out', async () => {
    MockRepo.prototype.listForReferrer = jest.fn(async () => rows(3));
    const first = await new ReferralService().listReferrals(TENANT, 2, null);

    await new ReferralService().listReferrals(TENANT, 2, first.nextCursor);

    // The cursor is the exact key the order is on: (signed_up_at, id).
    expect(MockRepo.prototype.listForReferrer).toHaveBeenLastCalledWith(TENANT, 2, {
      signedUpAt: new Date(Date.UTC(2026, 0, 29)),
      id: 'ref_1',
    });
  });

  it('prints an ineligible row with no amount, whatever billing says', async () => {
    MockRepo.prototype.listForReferrer = jest.fn(async () => [
      { ...rows(1)[0], status: 'subscribed' as const, ineligibleReason: 'existing_account' as const },
    ]);
    mockBillingClient.mockReturnValue({
      getReferralCreditSummary: jest.fn(async () => ({
        creditEarnedUsd: 0,
        creditAppliedUsd: 0,
        creditAvailableUsd: 0,
        convertedCount: 0,
        subscriptionActive: true,
      })),
      getReferralCredits: jest.fn(async () => [
        { referralId: 'ref_0', amountUsd: 20, status: 'pending' as const, availableAt: null, expiresAt: null },
      ]),
    } as unknown as ReturnType<typeof getBillingAdminClient>);

    const page = await new ReferralService().listReferrals(TENANT, 50, null);

    expect(page.referrals[0].creditStatus).toBe('ineligible');
    expect(page.referrals[0].creditUsd).toBe(0);
    expect(page.referrals[0].ineligibleReason).toBe('existing_account');
    // The funnel status is a separate axis: they DID subscribe.
    expect(page.referrals[0].status).toBe('subscribed');
  });

  it('renders rows without amounts rather than failing when billing is down', async () => {
    MockRepo.prototype.listForReferrer = jest.fn(async () => rows(1));
    mockBillingClient.mockReturnValue({
      getReferralCreditSummary: jest.fn(async () => ({
        creditEarnedUsd: 0,
        creditAppliedUsd: 0,
        creditAvailableUsd: 0,
        convertedCount: 0,
        subscriptionActive: true,
      })),
      getReferralCredits: jest.fn(async () => {
        throw new Error('billing unreachable');
      }),
    } as unknown as ReturnType<typeof getBillingAdminClient>);

    const page = await new ReferralService().listReferrals(TENANT, 50, null);

    expect(page.referrals[0].creditStatus).toBe('none');
    expect(page.referrals[0].creditUsd).toBe(0);
  });
});

describe('the cursor', () => {
  it('round-trips the exact key the list is ordered by', () => {
    const at = new Date('2026-01-30T12:00:00.000Z');
    expect(decodeCursor(encodeCursor(at, 'ref_9'))).toEqual({ signedUpAt: at, id: 'ref_9' });
  });

  it('refuses junk rather than paging from a garbage key', () => {
    expect(decodeCursor('not-a-cursor')).toBeNull();
    expect(decodeCursor(Buffer.from('nope', 'utf8').toString('base64url'))).toBeNull();
  });
});

describe('creditStatusFor', () => {
  it('lets ineligibility outrank whatever billing knows', () => {
    expect(
      creditStatusFor({ ineligibleReason: 'discounted_signup' }, {
        referralId: 'r', amountUsd: 20, status: 'reversed', availableAt: null, expiresAt: null,
      }),
    ).toBe('ineligible');
  });

  it('is none when nothing has been earned', () => {
    expect(creditStatusFor({ ineligibleReason: null }, null)).toBe('none');
  });
});

// ── Invitations ──────────────────────────────────────────────────────────────

describe('sending invitations', () => {
  it('answers 402 with no active subscription, whatever the flag said', async () => {
    billingSays({ subscriptionActive: false });

    await expect(
      new ReferralService().sendInvites(TENANT, ['jordan@example.com'], undefined),
    ).rejects.toBeInstanceOf(InvitesNotPermittedError);
    expect(sendReferralInviteEmail).not.toHaveBeenCalled();
  });

  it('answers 402 when the acceptance ratio has tripped', async () => {
    billingSays({ subscriptionActive: true });
    MockRepo.prototype.inviteAcceptanceStats = jest.fn(async () => ({ sent: 40, accepted: 1 }));

    await expect(
      new ReferralService().sendInvites(TENANT, ['jordan@example.com'], undefined),
    ).rejects.toMatchObject({ cause: 'acceptance_ratio' });
  });

  it('rejects an existing customer and an already-invited address by name', async () => {
    MockRepo.prototype.findAccountIdsByEmail = jest.fn(
      async () => new Set(['customer@example.com']),
    );
    MockRepo.prototype.findInvitedEmails = jest.fn(async () => new Set(['again@example.com']));

    const result = await new ReferralService().sendInvites(
      TENANT,
      ['customer@example.com', 'again@example.com', 'not-an-email', 'fresh@example.com'],
      undefined,
    );

    expect(result.sent).toBe(1);
    expect(result.rejected).toEqual(
      expect.arrayContaining([
        { email: 'customer@example.com', reason: 'already_a_customer' },
        { email: 'again@example.com', reason: 'already_invited' },
        { email: 'not-an-email', reason: 'invalid_email' },
      ]),
    );
  });

  it('stops at the daily cap, counting what has already gone out today', async () => {
    MockRepo.prototype.countInvitesSentToday = jest.fn(async () => REFERRAL_INVITES_PER_DAY - 1);

    const result = await new ReferralService().sendInvites(
      TENANT,
      ['a@example.com', 'b@example.com', 'c@example.com'],
      undefined,
    );

    expect(result.sent).toBe(1);
    expect(sendReferralInviteEmail).toHaveBeenCalledTimes(1);
    // Named, not dropped. An address in neither `sent` nor `rejected` shows the
    // sender a success toast for a smaller number than they typed, with no way
    // to learn which addresses went.
    expect(result.rejected).toEqual([
      { email: 'b@example.com', reason: 'daily_limit_reached' },
      { email: 'c@example.com', reason: 'daily_limit_reached' },
    ]);
  });

  it('names every address when the cap is already spent', async () => {
    MockRepo.prototype.countInvitesSentToday = jest.fn(async () => REFERRAL_INVITES_PER_DAY);

    const result = await new ReferralService().sendInvites(TENANT, ['a@example.com'], undefined);

    expect(result.sent).toBe(0);
    expect(result.rejected).toEqual([{ email: 'a@example.com', reason: 'daily_limit_reached' }]);
    expect(sendReferralInviteEmail).not.toHaveBeenCalled();
  });

  it('records the invitations before it tries to send them', async () => {
    const order: string[] = [];
    MockRepo.prototype.recordInvites = jest.fn(async () => { order.push('record'); });
    (sendReferralInviteEmail as jest.Mock).mockImplementation(async () => {
      order.push('send');
      return 'id';
    });

    await new ReferralService().sendInvites(TENANT, ['a@example.com'], undefined);

    // A mailer failure must not hand a workspace an unmetered retry loop
    // against the daily cap.
    expect(order).toEqual(['record', 'send']);
  });

  it('counts only the addresses that actually left', async () => {
    (sendReferralInviteEmail as jest.Mock).mockRejectedValueOnce(new Error('resend down'));

    const result = await new ReferralService().sendInvites(
      TENANT,
      ['a@example.com', 'b@example.com'],
      undefined,
    );

    expect(result.sent).toBe(1);
  });
});

describe('the free-text note', () => {
  it('collapses the line breaks that let somebody fake a second paragraph', () => {
    expect(sanitizeInviteMessage('Hi there\n\nOfficial notice: verify your account'))
      .toBe('Hi there Official notice: verify your account');
  });

  it('strips the characters that would reopen the markup', () => {
    expect(sanitizeInviteMessage('<a href="evil">click</a> & win'))
      .toBe('a href="evil"click/a win');
  });

  it('is null when there is nothing left to say', () => {
    expect(sanitizeInviteMessage('   ')).toBeNull();
    expect(sanitizeInviteMessage(undefined)).toBeNull();
  });

  it('caps the length', () => {
    expect(sanitizeInviteMessage('x'.repeat(900))).toHaveLength(500);
  });
});


// ── The stale-signup sweep ───────────────────────────────────────────────────

describe('expiring signups that never converted', () => {
  it('sweeps at the six-month horizon', async () => {
    let cutoff: Date | undefined;
    MockRepo.prototype.adminExpireStaleSignups = jest.fn(async (c: Date) => {
      cutoff = c;
      return 3;
    });
    const now = new Date('2026-09-03T00:00:00.000Z');

    const result = await new ReferralService().expireStaleSignups(now);

    expect(result).toEqual({ expired: 3 });
    const days = (now.getTime() - (cutoff as Date).getTime()) / (24 * 60 * 60 * 1000);
    expect(days).toBe(REFERRAL_SIGNUP_EXPIRY_DAYS);
  });

  it('is a no-op when nothing has gone stale', async () => {
    MockRepo.prototype.adminExpireStaleSignups = jest.fn(async () => 0);

    expect(await new ReferralService().expireStaleSignups()).toEqual({ expired: 0 });
  });
});
