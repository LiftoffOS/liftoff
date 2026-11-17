// HMAC-signed HTTP client for platform-backend's internal billing API.
//
// Signing convention (must match billing-controls-internal-router.ts):
//   X-Billing-Timestamp: unix epoch milliseconds
//   X-Billing-Signature: HMAC-SHA256(method + '\n' + fullPath + '\n' + timestamp + '\n' + body)
//
// The token is loaded once at startup and passed in via PlatformBackendClient.

import { createHmac, timingSafeEqual } from 'node:crypto';

/** A non-2xx answer from platform-backend, with its status and body kept so a
 *  route can pass a 4xx reason on to the caller instead of a bare 500. */
export class PlatformBackendError extends Error {
  constructor(message: string, readonly status: number, readonly body: string) {
    super(message);
    this.name = 'PlatformBackendError';
  }
}

export class PlatformBackendClient {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
  }

  private sign(method: string, path: string, body: string): { timestamp: string; signature: string } {
    const timestamp = String(Date.now());
    const signingString = `${method}\n${path}\n${timestamp}\n${body}`;
    const signature = createHmac('sha256', this.token).update(signingString).digest('hex');
    return { timestamp, signature };
  }

  private async call(
    method: string,
    path: string,
    payload: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<void> {
    if (!this.baseUrl) return; // PLATFORM_BACKEND_URL not configured — skip (test/local env)
    const body = JSON.stringify(payload ?? {});
    const { timestamp, signature } = this.sign(method, path, body);
    const resp = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Billing-Timestamp': timestamp,
        'X-Billing-Signature': signature,
        ...extraHeaders,
      },
      body,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new PlatformBackendError(`platform-backend ${method} ${path} → ${resp.status}: ${text.slice(0, 300)}`, resp.status, text);
    }
  }

  // Response-bearing variant of `call`. Used when the PB endpoint returns
  // a JSON body the billing service needs to act on (e.g. promo eligibility
  // check). Returns `null` when PLATFORM_BACKEND_URL is unconfigured so
  // callers can degrade gracefully in local dev / test environments.
  private async callJson<T>(
    method: string,
    path: string,
    payload: unknown,
    opts: { nullOnNotFound?: boolean } = {},
  ): Promise<T | null> {
    if (!this.baseUrl) return null;
    const body = JSON.stringify(payload ?? {});
    const { timestamp, signature } = this.sign(method, path, body);
    const resp = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Billing-Timestamp': timestamp,
        'X-Billing-Signature': signature,
      },
      body,
    });
    // A 404 can mean "this platform-backend does not have that endpoint",
    // which is a deploy-ordering fact rather than a failure. Opt-in, because
    // for most callers a 404 IS a failure and swallowing it would hide one.
    if (resp.status === 404 && opts.nullOnNotFound) return null;
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`platform-backend ${method} ${path} → ${resp.status}: ${text.slice(0, 300)}`);
    }
    return (await resp.json()) as T;
  }

  async checkDeletionHistory(emailHash: string): Promise<{ matched: boolean; deletedAt?: string }> {
    const r = await this.callJson<{ matched: boolean; deletedAt?: string }>(
      'POST',
      '/api/internal/accounts/check-deletion-history',
      { emailHash },
    );
    return r ?? { matched: false };
  }

  // ── Billing Controls endpoints ─────────────────────────────────────────────

  async initControls(stripeCustomerId: string, opts: {
    tenantId: string;
    stripeSubscriptionId: string | null;
    stripePeriodStart: string | null;
    billingTier?: string;
    currency?: string;
  }): Promise<void> {
    await this.call('POST', `/api/internal/billing/controls/${stripeCustomerId}/init`, {
      tenantId: opts.tenantId,
      stripeCustomerId,
      billingPeriodStart: opts.stripePeriodStart,
      stripeSubscriptionId: opts.stripeSubscriptionId,
      stripePeriodStart: opts.stripePeriodStart,
      billingTier: opts.billingTier ?? 'standard',
      currency: opts.currency ?? 'usd',
    });
  }

  async thresholdSucceeded(stripeCustomerId: string, opts: {
    thresholdLevel: number | string;
  }): Promise<void> {
    await this.call('POST', `/api/internal/billing/controls/${stripeCustomerId}/threshold-succeeded`, {
      thresholdLevel: opts.thresholdLevel,
    });
  }

  async thresholdFailed(stripeCustomerId: string, opts: {
    thresholdLevel: number | string;
    outstandingBalanceUsd: number;
  }): Promise<void> {
    await this.call('POST', `/api/internal/billing/controls/${stripeCustomerId}/threshold-failed`, {
      thresholdLevel: opts.thresholdLevel,
      outstandingBalanceUsd: opts.outstandingBalanceUsd,
    });
  }

  async periodReset(stripeCustomerId: string, opts: {
    billingPeriodStart: string;
    stripePeriodStart?: string | null;
    stripeSubscriptionId?: string | null;
  }): Promise<void> {
    await this.call('POST', `/api/internal/billing/controls/${stripeCustomerId}/period-reset`, {
      billingPeriodStart: opts.billingPeriodStart,
      stripePeriodStart: opts.stripePeriodStart ?? null,
      stripeSubscriptionId: opts.stripeSubscriptionId ?? null,
    });
  }

  async prepaidToppedUp(stripeCustomerId: string, amountUsd: number): Promise<void> {
    await this.call('POST', `/api/internal/billing/controls/${stripeCustomerId}/prepaid-topped-up`, {
      amountUsd,
    });
  }

  /**
   * Debit prepaid credit when the payment that bought it is taken back.
   *
   * The balance is allowed to go negative on the platform-backend side, which
   * is the point: credit that has already been spent must not be forgiven, and
   * a negative balance suspends the account until the debt is settled.
   */
  async prepaidClawback(
    stripeCustomerId: string,
    amountUsd: number,
    reason: 'refund' | 'dispute',
  ): Promise<void> {
    await this.call('POST', `/api/internal/billing/controls/${stripeCustomerId}/prepaid-clawback`, {
      amountUsd,
      reason,
    });
  }

  /**
   * Hold a customer's workspaces after an early fraud warning.
   *
   * The issuer of a card that paid this account has reported the payment as
   * fraud. platform-backend sets billing_controls.fraud_hold_at, which is a
   * term in the predicate its entitlement snapshot and execution guard both
   * read, so every workspace under the account stops taking new work.
   *
   * Sent whatever the invoice bought: the signal is about the card, not the
   * purchase. Nothing about the wallet changes — credit leaves when money
   * leaves, which is the refund and dispute path, not this one.
   */
  async fraudHold(
    stripeCustomerId: string,
    payload: { ref: string; chargeId: string; invoiceId: string | null; fraudType: string },
  ): Promise<void> {
    await this.call('POST', `/api/internal/billing/controls/${stripeCustomerId}/fraud-hold`, payload);
  }

  async subscriptionCancelled(
    stripeCustomerId: string,
    opts?: {
      metadata?: { tenant_id?: string | null };
      subscriptionId?: string;
    },
  ): Promise<void> {
    // PR 2b — forward sub.metadata.tenant_id so PB's billing-controls-internal
    // router can resolve the account even when billing_controls has lost
    // track of the Stripe customer (orphan-customer scenario, Gap F).
    //
    // subscriptionId + stripeCustomerId identify WHICH subscription was
    // cancelled. PB compares them against billing_controls' current pointers
    // and ignores cancellations of stale/orphan subscriptions instead of
    // suspending the account they resolve to.
    await this.call(
      'POST',
      `/api/internal/billing/controls/${stripeCustomerId}/subscription-cancelled`,
      {
        ...(opts?.metadata ? { metadata: opts.metadata } : {}),
        ...(opts?.subscriptionId ? { subscriptionId: opts.subscriptionId } : {}),
        stripeCustomerId,
      },
    );
  }

  async subscriptionEnding(
    stripeCustomerId: string,
    payload: { accessEndsAt: number },
  ): Promise<void> {
    await this.call('POST', `/api/internal/billing/controls/${stripeCustomerId}/subscription-ending`, payload);
  }

  async receipt(
    stripeCustomerId: string,
    payload: {
      context: 'subscription_renewal' | 'credit_reload';
      amountUsd: number;
      paymentMethodType: 'card' | 'us_bank_account';
      paymentMethodLast4: string;
    },
  ): Promise<void> {
    await this.call('POST', `/api/internal/billing/controls/${stripeCustomerId}/receipt`, payload);
  }

  async cardExpiring(
    stripeCustomerId: string,
    payload: {
      cardBrand: string;
      cardLast4: string;
      cardExpMonth: string;
      cardExpYear: string;
    },
  ): Promise<void> {
    await this.call('POST', `/api/internal/billing/controls/${stripeCustomerId}/card-expiring`, payload);
  }

  async recoverySucceeded(stripeCustomerId: string): Promise<void> {
    await this.call('POST', `/api/internal/billing/controls/${stripeCustomerId}/recovery-succeeded`, {});
  }


  async paymentFailed(stripeCustomerId: string, opts: {
    outstandingBalanceUsd: number;
  }): Promise<void> {
    await this.call('POST', `/api/internal/billing/controls/${stripeCustomerId}/payment-failed`, {
      outstandingBalanceUsd: opts.outstandingBalanceUsd,
    });
  }

  async paymentMethodAdded(stripeCustomerId: string): Promise<void> {
    await this.call('POST', `/api/internal/billing/controls/${stripeCustomerId}/payment-method-added`, {});
  }

  async subscriptionActivated(stripeCustomerId: string, opts?: {
    planType?: 'core' | 'growth' | 'scale';
    billingTier?: string;
    includedOus?: number;
    precommitExtraOus?: number;
    includedRateUsdPerOu?: number;
    precommitRateUsdPerOu?: number;
    reloadRateUsdPerOu?: number;
    isAnnualPlan?: boolean;
    stripeSubscriptionId?: string;
    stripePeriodStart?: string;
    stripePeriodEnd?: string;
    tenantId?: string;
    promoApplied?: { amountOffUsd: number; firstInvoiceTotalUsd: number };
  }): Promise<void> {
    await this.call('POST', `/api/internal/billing/controls/${stripeCustomerId}/subscription-activated`, {
      ...(opts?.planType              !== undefined && { planType:              opts.planType }),
      ...(opts?.billingTier           !== undefined && { billingTier:           opts.billingTier }),
      ...(opts?.includedOus           !== undefined && { includedOus:           opts.includedOus }),
      ...(opts?.precommitExtraOus     !== undefined && { precommitExtraOus:     opts.precommitExtraOus }),
      ...(opts?.includedRateUsdPerOu  !== undefined && { includedRateUsdPerOu:  opts.includedRateUsdPerOu }),
      ...(opts?.precommitRateUsdPerOu !== undefined && { precommitRateUsdPerOu: opts.precommitRateUsdPerOu }),
      ...(opts?.reloadRateUsdPerOu    !== undefined && { reloadRateUsdPerOu:    opts.reloadRateUsdPerOu }),
      ...(opts?.isAnnualPlan          !== undefined && { isAnnualPlan:          opts.isAnnualPlan }),
      ...(opts?.stripeSubscriptionId  !== undefined && { stripeSubscriptionId:  opts.stripeSubscriptionId }),
      ...(opts?.stripePeriodStart     !== undefined && { stripePeriodStart:     opts.stripePeriodStart }),
      ...(opts?.stripePeriodEnd       !== undefined && { stripePeriodEnd:       opts.stripePeriodEnd }),
      ...(opts?.tenantId              !== undefined && { tenantId:              opts.tenantId }),
      ...(opts?.promoApplied          !== undefined && { promoApplied:          opts.promoApplied }),
    });
  }

  async syncSubscriptionItems(subscriptionId: string): Promise<void> {
    await this.call('POST', `/api/internal/billing/subscription-items/sync`, {
      subscriptionId,
    });
  }

  async autoReloadFailed(
    stripeCustomerId: string,
    payload: {
      amountUsd: number;
      reason: string;
      paymentMethodType?: 'card' | 'us_bank_account';
      paymentMethodLast4?: string;
    },
  ): Promise<void> {
    await this.call('POST', `/api/internal/billing/controls/${stripeCustomerId}/auto-reload-failed`, payload);
  }

  // ── Auto-reload settings ───────────────────────────────────────────────────

  async getAutoReloadSettings(tenantId: string): Promise<{
    billingMode: string;
    autoReloadEnabled: boolean;
    thresholdUsd: number | null;
    amountUsd: number | null;
    prepaidBalanceUsd: number;
  }> {
    if (!this.baseUrl) {
      return { billingMode: 'post_pay', autoReloadEnabled: false, thresholdUsd: null, amountUsd: null, prepaidBalanceUsd: 0 };
    }
    const path = `/api/internal/billing/controls/by-tenant/${tenantId}/auto-reload-settings`;
    const body = JSON.stringify({});
    const { timestamp, signature } = this.sign('GET', path, body);
    const resp = await fetch(`${this.baseUrl}${path}`, {
      method: 'GET',
      headers: {
        'X-Billing-Timestamp': timestamp,
        'X-Billing-Signature': signature,
      },
    });
    if (!resp.ok) throw new Error(`platform-backend GET ${path} → ${resp.status}`);
    return resp.json() as Promise<{
      billingMode: string;
      autoReloadEnabled: boolean;
      thresholdUsd: number | null;
      amountUsd: number | null;
      prepaidBalanceUsd: number;
    }>;
  }

  async updateAutoReloadSettings(
    tenantId: string,
    settings: { enabled: boolean; thresholdUsd: number; amountUsd: number },
  ): Promise<void> {
    await this.call('PUT', `/api/internal/billing/controls/by-tenant/${tenantId}/auto-reload-settings`, settings);
  }

  // ── Customer listing ───────────────────────────────────────────────────────
  // Full billing_controls customer→pointer listing from PB. Consumed by the
  // daily subscription reconciliation so its sweep covers Stripe customers
  // with no row in the local subscriptions table (superseded customers,
  // which a local-only sweep cannot see).

  async listBillingCustomers(): Promise<Array<{
    accountId: string;
    stripeCustomerId: string;
    stripeSubscriptionId: string | null;
    suspended?: boolean;
  }>> {
    if (!this.baseUrl) return [];
    const path = '/api/internal/billing/customers';
    const body = JSON.stringify({});
    const { timestamp, signature } = this.sign('GET', path, body);
    const resp = await fetch(`${this.baseUrl}${path}`, {
      method: 'GET',
      headers: {
        'X-Billing-Timestamp': timestamp,
        'X-Billing-Signature': signature,
      },
    });
    if (!resp.ok) throw new Error(`platform-backend GET ${path} → ${resp.status}`);
    const data = (await resp.json()) as {
      customers: Array<{ accountId: string; stripeCustomerId: string; stripeSubscriptionId: string | null; suspended?: boolean }>;
    };
    return data.customers;
  }

  // ── Status ─────────────────────────────────────────────────────────────────
  // PR 1: getOperatingUnits removed. /current-usage no longer fetches OU data
  // separately — billing_controls.ous_consumed_this_period is included in the
  // /status response. Per-tenant OU breakdown is served by /api/internal/
  // billing/tenants/:tenantId/operating-units, but no liftoff-billing caller
  // needs it; the endpoint stays on platform-backend for /insights.

  async getControlsStatus(stripeCustomerId: string): Promise<{
    accountId: string;
    currentPeriodSpendUsd: number;
    nextThresholdUsd: number;
    outstandingBalanceUsd: number;
    suspended: boolean;
    billingTier: string;
    graduated: boolean;
    billingPeriodStart: string;
    spendUpdatedAt: string;
    thresholdChargesCollectedUsd: number;
    hasPaymentMethod: boolean;
    billingMode: 'pre_pay' | 'post_pay';
    planType: 'core' | 'growth' | 'scale' | null;
    planIncludedOus: number;
    precommitExtraOus: number;
    // The referee half of the referral programme: bonus Operating Units on the
    // referred workspace's FIRST billing period. Reported separately by
    // platform-backend so its own endpoint keeps saying what its columns hold;
    // the surfaces that report an ALLOWANCE add it to precommitExtraOus, which
    // is the only way the referred workspace is ever told it was granted.
    referralBonusOus?: number;
    ousConsumedThisPeriod: number;
    includedRateUsdPerOu: number;
    precommitRateUsdPerOu: number;
    reloadRateUsdPerOu: number;
    reloadBalanceUsd: number;
    autoReloadEnabled: boolean;
    autoReloadThresholdUsd: number | null;
    autoReloadAmountUsd: number | null;
    suspendedReason: string | null;
    stripeSubscriptionId?: string | null;
  } | null> {
    if (!this.baseUrl) return null;
    const path = `/api/internal/billing/controls/${stripeCustomerId}/status`;
    const body = JSON.stringify({});
    const { timestamp, signature } = this.sign('GET', path, body);
    const resp = await fetch(`${this.baseUrl}${path}`, {
      method: 'GET',
      headers: {
        'X-Billing-Timestamp': timestamp,
        'X-Billing-Signature': signature,
      },
    });
    if (resp.status === 404) return null;
    if (!resp.ok) throw new Error(`platform-backend GET ${path} → ${resp.status}`);
    return resp.json() as Promise<{
      accountId: string;
      currentPeriodSpendUsd: number;
      nextThresholdUsd: number;
      outstandingBalanceUsd: number;
      suspended: boolean;
      billingTier: string;
      graduated: boolean;
      billingPeriodStart: string;
      spendUpdatedAt: string;
      thresholdChargesCollectedUsd: number;
      hasPaymentMethod: boolean;
      billingMode: 'pre_pay' | 'post_pay';
      planType: 'core' | 'growth' | 'scale' | null;
      planIncludedOus: number;
      precommitExtraOus: number;
      referralBonusOus?: number;
      ousConsumedThisPeriod: number;
      includedRateUsdPerOu: number;
      precommitRateUsdPerOu: number;
      reloadRateUsdPerOu: number;
      reloadBalanceUsd: number;
      autoReloadEnabled: boolean;
      autoReloadThresholdUsd: number | null;
      autoReloadAmountUsd: number | null;
      suspendedReason: string | null;
    }>;
  }

  // ── Referral programme ─────────────────────────────────────────────────────
  //
  // platform-backend owns the attribution graph; this service owns the money.
  // These are the three questions the invoice cannot answer on its own, plus
  // the two writes the invoice settles, plus the referee-side grant.

  /**
   * Was this paying workspace referred, and by whom?
   *
   * Called on EVERY subscription invoice that is paid, which is what makes its
   * failure mode load-bearing far beyond the referral programme: this runs
   * inside the Stripe consumer, so an error here fails the whole event and
   * Pub/Sub retries the entire invoice.
   *
   * That is right for a 5xx — platform-backend is degraded, the referral is
   * recoverable, and a retry is cheap — and wrong for a 404, which means that
   * platform-backend does not have the endpoint at all. A rollback of the
   * control plane to a revision predating the referral programme would
   * otherwise take every subscription invoice in the estate down with it.
   * A 404 therefore reads as "not referred", which is the correct answer from a
   * control plane that has never heard of referrals.
   */
  async referralLookup(tenantId: string): Promise<{
    referralId: string;
    referrerTenantId: string;
    referrerAccountId: string;
    referrerStripeCustomerId: string | null;
    referredAccountId: string;
    referredStripeCustomerId: string | null;
    signedUpAt: string;
    subscribedAt: string | null;
    status: string;
    ineligibleReason: string | null;
  } | null> {
    const r = await this.callJson<{ referral: null | {
      referralId: string;
      referrerTenantId: string;
      referrerAccountId: string;
      referrerStripeCustomerId: string | null;
      referredAccountId: string;
      referredStripeCustomerId: string | null;
      signedUpAt: string;
      subscribedAt: string | null;
      status: string;
      ineligibleReason: string | null;
    } }>('POST', '/api/internal/referrals/lookup', { tenantId }, { nullOnNotFound: true });
    return r?.referral ?? null;
  }

  /** Records the conversion on the attribution row. */
  async referralSubscribed(referralId: string, subscribedAt: Date): Promise<void> {
    await this.call('POST', `/api/internal/referrals/${referralId}/subscribed`, {
      subscribedAt: subscribedAt.toISOString(),
    });
  }

  /**
   * Records why a referral earns nothing.
   *
   * Never a silent drop: the referrer controls none of these exclusions and can
   * see none of them, so the reason is printed where the amount would be. A row
   * that signed up, subscribed and paid nothing without saying why reads as the
   * programme not working.
   */
  async referralIneligible(
    referralId: string,
    reason: 'existing_account' | 'already_referred' | 'self_referral' | 'discounted_signup',
  ): Promise<void> {
    await this.call('POST', `/api/internal/referrals/${referralId}/ineligible`, { reason });
  }

  /**
   * Grants the referee half — bonus Operating Units on the referred
   * workspace's first billing period.
   *
   * Returns whether this call was the one that granted them. platform-backend
   * refuses a second grant for an account that already carries one, so a
   * redelivered invoice comes back `granted: false` rather than doubling the
   * allowance.
   */
  async referralBonus(
    stripeCustomerId: string,
    opts: { referralId: string; bonusOus: number },
  ): Promise<{ granted: boolean }> {
    const r = await this.callJson<{ granted: boolean }>(
      'POST',
      `/api/internal/billing/controls/${stripeCustomerId}/referral-bonus`,
      { referralId: opts.referralId, bonusOus: opts.bonusOus },
    );
    return { granted: r?.granted === true };
  }
}

// ── Shared validator for inbound HMAC-signed requests from platform-backend ───
// Used by liftoff-billing's /api/internal/billing/threshold-charge endpoint.

export function validateInboundBillingHmac(
  method: string,
  path: string,
  body: string,
  headers: { timestamp?: string; signature?: string },
  token: string,
): boolean {
  const ts = parseInt(headers.timestamp ?? '', 10);
  if (isNaN(ts) || Math.abs(Date.now() - ts) > 60_000) return false;
  const signingString = `${method}\n${path}\n${ts}\n${body}`;
  const expected = createHmac('sha256', token).update(signingString).digest('hex');
  const a = Buffer.from(headers.signature ?? '');
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
