// The referral programme's decisions.
//
// This module answers "does this referral count", "what may this workspace do",
// and "what does the page show". What a referral is WORTH and when it can be
// spent is liftoff-billing's, and every money figure on the payload arrives
// from there: INV-PB-010 makes billing the one money authority, so a second
// opinion computed here would be a second authority.

import { frontendUrl } from '../infrastructure/frontend-url';
import { log } from '../infrastructure/logging';
import { getBillingAdminClient } from '../billing/billing-admin-client';
import { TenantRepository } from '../tenants/repository';
import { AccountRepository } from '../accounts/repository';
import { sendReferralInviteEmail } from '../infrastructure/email';
import { mintReferralCode } from './code';
import { ReferralRepository } from './repository';
import {
  REFEREE_BONUS_OUS,
  REFEREE_BONUS_USD,
  REFERRAL_ATTRIBUTION_WINDOW_DAYS,
  REFERRAL_INVITES_PER_DAY,
  REFERRAL_INVITE_BATCH_MAX,
  REFERRAL_INVITE_MESSAGE_MAX,
  REFERRAL_REWARD_USD,
  REFERRAL_SIGNUP_EXPIRY_DAYS,
  REFERRAL_THROTTLE_MIN_ACCEPTANCE_RATIO,
  REFERRAL_THROTTLE_MIN_SENT,
} from './constants';
import type {
  ReferralCredit,
  ReferralCreditStatus,
  ReferralCreditSummary,
  ReferralIneligibleReason,
  ReferralInviteRejectionReason,
  ReferralInviteResponse,
  ReferralListResponse,
  ReferralProgramResponse,
  ReferralResponse,
  ReferralRow,
} from './types';

/**
 * Raised when a workspace may not send invitations, which the router turns into
 * a 402.
 *
 * One error for both causes on purpose. The subscription gate and the
 * acceptance-ratio throttle are different rules, but the contract answers 402
 * either way and the frontend's union has no third state — `canSendInvites`
 * carries the difference to the page, and the endpoint stays the enforcement.
 */
export class InvitesNotPermittedError extends Error {
  readonly cause: 'no_subscription' | 'acceptance_ratio';

  constructor(cause: 'no_subscription' | 'acceptance_ratio') {
    super(
      cause === 'no_subscription'
        ? 'An active subscription is required to send referral invitations'
        : 'Invitations are paused for this workspace',
    );
    this.name = 'InvitesNotPermittedError';
    this.cause = cause;
  }
}

/** Raised when a workspace that does exist has no programme. */
export class NoReferralProgramError extends Error {
  constructor(tenantId: string) {
    super(`No referral programme for tenant ${tenantId}`);
    this.name = 'NoReferralProgramError';
  }
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254; // RFC 5321

/** How many times a code collision is retried before giving up. Four hex digits
 *  behind a workspace-name stem collide rarely; three attempts is generous. */
const CODE_MINT_ATTEMPTS = 3;

/** Longest code a binding will look up. A minted code is a 24-character stem
 *  plus a hyphen and four hex digits; the slack is for nothing in particular
 *  beyond not rejecting a code this bound would have to be changed to issue. */
const MAX_CODE_LENGTH = 64;

const DAY_MS = 24 * 60 * 60 * 1000;

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string })?.code === '23505';
}

export class ReferralService {
  private repository = new ReferralRepository();
  private tenantRepo = new TenantRepository();
  private accountRepo = new AccountRepository();

  // ── Codes ──────────────────────────────────────────────────────────────────

  /**
   * The workspace's code, issued on first use.
   *
   * Lazily rather than at tenant creation, which the plan permits either way:
   * issuing here means every workspace that ever existed has a code the first
   * time somebody opens the page, with no backfill, and a tenant provisioned
   * while this was deploying is not left permanently without one.
   */
  async ensureCode(tenantId: string): Promise<string> {
    const existing = await this.repository.findCodeByTenant(tenantId);
    if (existing) return existing;

    const tenant = await this.tenantRepo.findById(tenantId);
    if (!tenant) throw new NoReferralProgramError(tenantId);

    let lastError: unknown;
    for (let attempt = 0; attempt < CODE_MINT_ATTEMPTS; attempt++) {
      try {
        return await this.repository.issueCode(tenantId, mintReferralCode());
      } catch (err) {
        // A collision on the UNIQUE code, not on the tenant: another workspace
        // already drew this string. Six characters over a 30-character alphabet
        // is 30^6, so it is rare rather than impossible, and the constraint is
        // what decides — draw again.
        if (!isUniqueViolation(err)) throw err;
        lastError = err;
      }
    }
    throw lastError;
  }

  /** The canonical share link, always served rather than composed by the page:
   *  the frontend's fallback would produce dev-origin links for anyone sharing
   *  from dev. */
  referralUrl(code: string): string {
    return `${frontendUrl()}/?ref=${encodeURIComponent(code)}`;
  }

  // ── The page ───────────────────────────────────────────────────────────────

  async getProgram(tenantId: string): Promise<ReferralProgramResponse> {
    const code = await this.ensureCode(tenantId);
    const [pendingCount, money, throttled] = await Promise.all([
      this.repository.countPending(tenantId),
      this.creditSummary(tenantId),
      this.isInviteThrottled(tenantId),
    ]);

    return {
      code,
      url: this.referralUrl(code),
      rewardPerReferralUsd: REFERRAL_REWARD_USD,
      refereeBonusOus: REFEREE_BONUS_OUS,
      refereeBonusUsd: REFEREE_BONUS_USD,
      creditEarnedUsd: money.creditEarnedUsd,
      creditAppliedUsd: money.creditAppliedUsd,
      creditAvailableUsd: money.creditAvailableUsd,
      // An unpaid workspace earns and accumulates; it simply has no invoice to
      // spend against. Nothing is confiscated from somebody who refers before
      // they subscribe.
      creditRedeemable: money.subscriptionActive,
      // The gate is not about the reward. This endpoint sends mail from a
      // Liftoff domain, passing our SPF, DKIM and DMARC, to addresses the
      // caller supplies — ungated, that is a mail relay wearing our sending
      // reputation, and the damage lands on password resets rather than here.
      canSendInvites: money.subscriptionActive && !throttled,
      pendingCount,
      convertedCount: money.convertedCount,
    };
  }

  async listReferrals(
    tenantId: string,
    limit: number,
    cursor: string | null,
  ): Promise<ReferralListResponse> {
    const decoded = cursor ? decodeCursor(cursor) : null;
    const page = await this.repository.listForReferrer(tenantId, limit, decoded);

    const hasMore = page.length > limit;
    const rows = hasMore ? page.slice(0, limit) : page;

    const credits = await this.creditsFor(tenantId, rows.map((r) => r.id));

    const referrals: ReferralResponse[] = rows.map((row) => {
      const credit = credits.get(row.id) ?? null;
      return {
        id: row.id,
        email: row.email,
        name: row.name,
        status: row.status,
        signedUpAt: row.signedUpAt.toISOString(),
        subscribedAt: row.subscribedAt ? row.subscribedAt.toISOString() : null,
        creditUsd: row.ineligibleReason ? 0 : credit?.amountUsd ?? 0,
        creditStatus: creditStatusFor(row, credit),
        // Only pending credit has something to wait for. Once it is spendable
        // the date would be answering a question nobody is asking.
        creditAvailableAt: credit?.status === 'pending' ? credit.availableAt : null,
        creditExpiresAt: credit?.status === 'granted' ? credit.expiresAt : null,
        ineligibleReason: row.ineligibleReason,
      };
    });

    const last = rows[rows.length - 1];
    return {
      referrals,
      hasMore,
      nextCursor: hasMore && last ? encodeCursor(last.signedUpAt, last.id) : null,
    };
  }

  // ── Invitations ────────────────────────────────────────────────────────────

  /**
   * Sends referral invitations.
   *
   * Throws InvitesNotPermittedError with no active subscription, and again
   * when the acceptance-ratio throttle has tripped. The
   * `canSendInvites` flag on the programme payload exists so the page can
   * render the right control, not so it can decide — this is the enforcement,
   * and it answers 402 either way.
   */
  async sendInvites(
    tenantId: string,
    emails: string[],
    message: string | undefined,
    inviterUid?: string,
  ): Promise<ReferralInviteResponse> {
    const money = await this.creditSummary(tenantId);
    if (!money.subscriptionActive) throw new InvitesNotPermittedError('no_subscription');
    if (await this.isInviteThrottled(tenantId)) {
      throw new InvitesNotPermittedError('acceptance_ratio');
    }

    const code = await this.ensureCode(tenantId);
    const tenant = await this.tenantRepo.findById(tenantId);
    if (!tenant) throw new NoReferralProgramError(tenantId);

    const rejected: Array<{ email: string; reason: ReferralInviteRejectionReason }> = [];
    const candidates: string[] = [];
    const seen = new Set<string>();

    for (const raw of emails.slice(0, REFERRAL_INVITE_BATCH_MAX)) {
      const email = raw.trim().toLowerCase();
      if (!isValidEmail(email)) {
        rejected.push({ email: raw, reason: 'invalid_email' });
        continue;
      }
      // A list pasted twice is one invitation, not two rejections.
      if (seen.has(email)) continue;
      seen.add(email);
      candidates.push(email);
    }

    const [alreadyInvited, alreadyCustomers] = await Promise.all([
      this.repository.findInvitedEmails(tenantId, candidates),
      this.repository.findAccountIdsByEmail(tenantId, candidates),
    ]);

    const sendable: string[] = [];
    for (const email of candidates) {
      if (alreadyCustomers.has(email)) {
        rejected.push({ email, reason: 'already_a_customer' });
        continue;
      }
      if (alreadyInvited.has(email)) {
        rejected.push({ email, reason: 'already_invited' });
        continue;
      }
      sendable.push(email);
    }

    // The daily cap is enforced against what has already gone out today, and it
    // truncates rather than rejecting the whole call: a person pasting a list
    // that runs past the limit has the first of it sent and the rest named, so
    // they know exactly which addresses to try again tomorrow.
    const sentToday = await this.repository.countInvitesSentToday(tenantId);
    const remaining = Math.max(0, REFERRAL_INVITES_PER_DAY - sentToday);
    const toSend = sendable.slice(0, remaining);
    for (const email of sendable.slice(remaining)) {
      rejected.push({ email, reason: 'daily_limit_reached' });
    }

    // Recorded BEFORE the sends, so a mailer failure cannot hand a workspace an
    // unmetered retry loop against the daily cap.
    await this.repository.recordInvites(tenantId, toSend);

    const safeMessage = sanitizeInviteMessage(message);
    const inviteUrl = this.referralUrl(code);

    // A person recommending something carries further than a workspace name, so
    // the invitation is sent in the referrer's name where we have one. Best
    // effort on purpose: a missing or unresolvable account falls back to the
    // workspace, and never fails the send.
    const inviter = inviterUid
      ? await this.accountRepo.findByFirebaseUid(inviterUid).catch(() => null)
      : null;
    let sent = 0;
    for (const email of toSend) {
      try {
        await sendReferralInviteEmail(email, {
          workspaceName: tenant.name,
          inviterName: inviter ? `${inviter.firstName ?? ''} ${inviter.lastName ?? ''}`.trim() : '',
          inviteUrl,
          message: safeMessage,
          refereeBonusUsd: REFEREE_BONUS_USD,
          refereeBonusOus: REFEREE_BONUS_OUS,
        });
        sent += 1;
      } catch (err) {
        log.error(
          { tenantId, email, error: (err as Error).message },
          'referrals.invites: send failed',
        );
      }
    }

    return { sent, rejected };
  }

  /**
   * The acceptance-ratio throttle.
   *
   * A workspace that has sent many invitations with few accepted loses
   * `canSendInvites`, which the page reads to hide the control while leaving
   * the link and every share target in place. Spam has a near-zero acceptance
   * rate, so this targets the behaviour rather than punishing a legitimate
   * heavy referrer who happens to be effective — which a fixed cap alone cannot
   * do, since it lets a spammer send 30 a day forever.
   */
  private async isInviteThrottled(tenantId: string): Promise<boolean> {
    const { sent, accepted } = await this.repository.inviteAcceptanceStats(tenantId);
    if (sent < REFERRAL_THROTTLE_MIN_SENT) return false;
    return accepted / sent < REFERRAL_THROTTLE_MIN_ACCEPTANCE_RATIO;
  }

  // ── Attribution ────────────────────────────────────────────────────────────

  /**
   * Binds a share code to an account at creation.
   *
   * Called from AccountService.create, which is what makes the 30 day window
   * survive a signup on a different device from the click: the row is written
   * once, here, and the earning event months later reads it rather than a
   * cookie.
   *
   * Best-effort by contract. A signup must never fail because the referral
   * could not be recorded, so every path returns rather than throws.
   */
  async bindOnAccountCreation(input: {
    accountId: string;
    email: string;
    code: string;
    clickedAt: Date | null;
    accountPreexisted: boolean;
  }): Promise<ReferralRow | null> {
    try {
      // Lower-cased and bounded before it is looked up. Every issued code is
      // lower-case, so accepting a differently-cased one is what makes a link
      // somebody retyped by hand still attribute; the length bound stops an
      // arbitrary body field reaching the database as a text comparison.
      const code = input.code.trim().toLowerCase();
      if (!code || code.length > MAX_CODE_LENGTH) return null;

      // The window governs click to ACCOUNT CREATION, not click to payment. A
      // click older than it buys only stale attribution: somebody who forgot
      // the link and found Liftoff organically months later is a customer we
      // already acquired.
      if (input.clickedAt) {
        const age = Date.now() - input.clickedAt.getTime();
        if (age > REFERRAL_ATTRIBUTION_WINDOW_DAYS * DAY_MS) {
          log.info(
            { accountId: input.accountId, code },
            'referrals.bind: click older than the attribution window — not bound',
          );
          return null;
        }
      }

      const referrer = await this.repository.adminResolveCode(code);
      if (!referrer) {
        log.info({ accountId: input.accountId, code }, 'referrals.bind: unknown code');
        return null;
      }

      const existing = await this.repository.adminFindByReferredAccount(input.accountId);
      const alreadyBoundToThisReferrer = existing.find(
        (r) => r.referrerTenantId === referrer.tenantId,
      );
      if (alreadyBoundToThisReferrer) return alreadyBoundToThisReferrer;

      const reason = this.ineligibilityAtBinding({
        referrerAccountId: referrer.accountId,
        referredAccountId: input.accountId,
        accountPreexisted: input.accountPreexisted,
        alreadyReferred: existing.length > 0,
      });

      const row = await this.repository.adminBind({
        referrerTenantId: referrer.tenantId,
        referredAccountId: input.accountId,
        code,
        clickedAt: input.clickedAt,
        ineligibleReason: reason,
      });

      // The invitation this signup answers, if the referrer sent one. Only an
      // eligible binding counts: crediting an acceptance to a referral that
      // earns nothing would let a workspace launder its ratio.
      if (!reason) {
        await this.repository.adminMarkInviteAccepted(referrer.tenantId, input.email);
      }

      log.info(
        {
          accountId: input.accountId,
          referralId: row.id,
          referrerTenantId: referrer.tenantId,
          ineligibleReason: reason,
        },
        'referrals.bind: attribution recorded',
      );
      return row;
    } catch (err) {
      log.error(
        { accountId: input.accountId, error: (err as Error).message },
        'referrals.bind: failed — signup continues without attribution',
      );
      return null;
    }
  }

  /**
   * The exclusions that can be decided the moment the code is bound.
   *
   * The row is written either way. Ineligibility is visible on purpose: every
   * exclusion in the terms is something the referrer neither controls nor can
   * see, and a row that signed up and silently paid nothing reads as the
   * programme not working. `self_referral` is printed as "same account
   * details", which names the observation rather than asserting a motive the
   * system cannot see — two people at one company sharing a corporate card is a
   * real false positive.
   *
   * The exclusions that CANNOT be decided here — "same person", "household",
   * an entity the referrer controls — are all defeated by a fresh email
   * address. Payment-method fingerprinting is the enforceable half and it
   * applies where money moves, in liftoff-billing.
   */
  private ineligibilityAtBinding(input: {
    referrerAccountId: string;
    referredAccountId: string;
    accountPreexisted: boolean;
    alreadyReferred: boolean;
  }): ReferralIneligibleReason | null {
    if (input.referrerAccountId === input.referredAccountId) return 'self_referral';
    if (input.alreadyReferred) return 'already_referred';
    if (input.accountPreexisted) return 'existing_account';
    return null;
  }

  /**
   * Points a waiting referral at the workspace the referred account has just
   * provisioned. A no-op for a second workspace under the same account, and for
   * an account nobody referred.
   */
  async attachReferredTenant(accountId: string, tenantId: string): Promise<void> {
    try {
      const attached = await this.repository.adminAttachReferredTenant(accountId, tenantId);
      if (attached) {
        log.info({ accountId, tenantId }, 'referrals: referred workspace attached');
      }
    } catch (err) {
      log.error(
        { accountId, tenantId, error: (err as Error).message },
        'referrals: failed to attach referred workspace',
      );
    }
  }

  // ── liftoff-billing's half ─────────────────────────────────────────────────

  /**
   * The money figures, from billing.
   *
   * Falls back to zeros and an inactive subscription when billing cannot
   * answer. Conservative in both directions that matter: no credit is claimed
   * to exist, and nothing that needs a subscription is permitted. The page
   * renders rather than erroring, which is what the plan asks of this endpoint
   * before the billing half is live at all.
   */
  private async creditSummary(tenantId: string): Promise<ReferralCreditSummary> {
    try {
      return await getBillingAdminClient().getReferralCreditSummary(tenantId);
    } catch (err) {
      log.error(
        { tenantId, error: (err as Error).message },
        'referrals: credit summary unavailable — serving zeros',
      );
      return {
        creditEarnedUsd: 0,
        creditAppliedUsd: 0,
        creditAvailableUsd: 0,
        convertedCount: 0,
        subscriptionActive: false,
      };
    }
  }

  private async creditsFor(
    tenantId: string,
    referralIds: string[],
  ): Promise<Map<string, ReferralCredit>> {
    if (referralIds.length === 0) return new Map();
    try {
      const credits = await getBillingAdminClient().getReferralCredits(tenantId, referralIds);
      return new Map(credits.map((c) => [c.referralId, c]));
    } catch (err) {
      log.error(
        { tenantId, error: (err as Error).message },
        'referrals: per-referral credits unavailable — rows render without amounts',
      );
      return new Map();
    }
  }

  /**
   * Marks signups that have gone the horizon without converting.
   *
   * Run daily. Idempotent by construction — it only selects rows still
   * `signed_up` — so a second run in the same day finds nothing, and a missed
   * day catches up on the next one.
   */
  async expireStaleSignups(now: Date = new Date()): Promise<{ expired: number }> {
    const cutoff = new Date(now.getTime() - REFERRAL_SIGNUP_EXPIRY_DAYS * DAY_MS);
    const expired = await this.repository.adminExpireStaleSignups(cutoff);
    if (expired > 0) {
      log.info(
        { expired, cutoff: cutoff.toISOString() },
        'referrals: stale signups marked expired',
      );
    }
    return { expired };
  }

  // ── Reads and writes for the internal router ───────────────────────────────

  async markSubscribed(referralId: string, subscribedAt: Date): Promise<ReferralRow | null> {
    return this.repository.adminMarkSubscribed(referralId, subscribedAt);
  }

  async markIneligible(
    referralId: string,
    reason: ReferralIneligibleReason,
  ): Promise<ReferralRow | null> {
    return this.repository.adminMarkIneligible(referralId, reason);
  }

  /**
   * Everything liftoff-billing needs about one referred workspace, in a single
   * answer.
   *
   * Both Stripe customer ids come back because the enforceable half of the
   * self-referral rules is a payment-method fingerprint, and only billing holds
   * those. "Already had an account", "previously referred" and "same person"
   * are all defeated by a fresh email address; a card fingerprint is not, and
   * it applies at the moment money moves, which is the moment worth checking.
   */
  async lookupForBilling(referredTenantId: string): Promise<{
    referralId: string;
    referrerTenantId: string;
    referrerAccountId: string;
    referrerStripeCustomerId: string | null;
    referredAccountId: string;
    referredStripeCustomerId: string | null;
    signedUpAt: string;
    subscribedAt: string | null;
    status: string;
    ineligibleReason: ReferralIneligibleReason | null;
  } | null> {
    const referral = await this.repository.adminFindByReferredTenant(referredTenantId);
    if (!referral) return null;

    const referrerTenant = await this.tenantRepo.findById(referral.referrerTenantId);
    const [referrerAccount, referredAccount] = await Promise.all([
      referrerTenant ? this.accountRepo.findById(referrerTenant.accountId) : Promise.resolve(null),
      this.accountRepo.findById(referral.referredAccountId),
    ]);

    return {
      referralId: referral.id,
      referrerTenantId: referral.referrerTenantId,
      referrerAccountId: referrerTenant?.accountId ?? '',
      referrerStripeCustomerId: referrerAccount?.stripeCustomerId ?? null,
      referredAccountId: referral.referredAccountId,
      referredStripeCustomerId: referredAccount?.stripeCustomerId ?? null,
      signedUpAt: referral.signedUpAt.toISOString(),
      subscribedAt: referral.subscribedAt ? referral.subscribedAt.toISOString() : null,
      status: referral.status,
      ineligibleReason: referral.ineligibleReason,
    };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function isValidEmail(email: string): boolean {
  return email.length <= MAX_EMAIL_LENGTH && EMAIL_PATTERN.test(email);
}

/**
 * Constrains the free-text note.
 *
 * Attacker-controlled prose inside Liftoff branding is what makes a phishing
 * wrapper effective, so the note is reduced to a single run of plain text: line
 * breaks collapse (they are what lets somebody fake a second, official-looking
 * paragraph), angle brackets and ampersands go, and the whole thing is capped.
 * The email template escapes it again on the way out.
 */
export function sanitizeInviteMessage(message: string | undefined): string | null {
  if (!message) return null;
  const cleaned = message
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[<>&]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, REFERRAL_INVITE_MESSAGE_MAX);
  return cleaned.length > 0 ? cleaned : null;
}

/** What the page prints where the amount would go. */
export function creditStatusFor(
  row: Pick<ReferralRow, 'ineligibleReason'>,
  credit: ReferralCredit | null,
): ReferralCreditStatus {
  // Ineligibility outranks whatever billing knows: a row marked
  // `discounted_signup` may still carry a credit that was reversed, and the
  // reason is the more useful thing to show.
  if (row.ineligibleReason) return 'ineligible';
  if (!credit) return 'none';
  return credit.status;
}

/**
 * Cursor over (signed_up_at, id), the exact key the list is ordered by.
 *
 * Opaque to the client and cheap to read here. An offset would drift under
 * inserts, which on a list that grows at the top is every new signup.
 */
export function encodeCursor(signedUpAt: Date, id: string): string {
  return Buffer.from(`${signedUpAt.toISOString()}|${id}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): { signedUpAt: Date; id: string } | null {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const separator = raw.indexOf('|');
    if (separator < 0) return null;
    const signedUpAt = new Date(raw.slice(0, separator));
    const id = raw.slice(separator + 1);
    if (Number.isNaN(signedUpAt.getTime()) || !id) return null;
    return { signedUpAt, id };
  } catch {
    return null;
  }
}
