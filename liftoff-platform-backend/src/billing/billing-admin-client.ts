// HMAC-signed HTTP client for liftoff-billing's internal admin API.
// Signing convention matches billing-controls-internal-router.ts (same shared BILLING_SERVICE_TOKEN):
//   X-Billing-Timestamp: unix epoch milliseconds
//   X-Billing-Signature: HMAC-SHA256(method + '\n' + path + '\n' + timestamp + '\n' + body)
//
// Cloud Run enforces IAM-based invocation on the billing service, so every
// request also needs an OIDC bearer token issued for the billing service's
// origin. The HMAC body authenticates the *payload*; the OIDC token gets the
// request past Cloud Run's frontend in the first place.

import { createHmac } from 'crypto';
import { buildOidcAuthHeader } from '@liftoffos/service-client';

/**
 * The tenant's Stripe customer has no payment method yet, so a subscription
 * cannot be created. NOT a fault: the fused-onboarding wizard collects payment
 * at step 7 (`payment`) and `TenantService.activate` runs at step 0, so every
 * self-serve signup passes through this state. Retrying cannot resolve it —
 * only the user entering a card can — so callers must treat it as terminal and
 * deferred rather than feeding it to the provisioning-outbox retry budget.
 *
 * Distinct from a generic provisioning failure (Stripe outage, rate limit),
 * which SHOULD still be retried.
 */
export class NoPaymentMethodError extends Error {
  readonly tenantId: string;

  constructor(tenantId: string, detail: string) {
    super(`billing-admin: provision-subscription deferred for tenant ${tenantId} — customer has no payment method: ${detail}`);
    this.name = 'NoPaymentMethodError';
    this.tenantId = tenantId;
  }
}

/**
 * Recognise the missing-payment-method rejection in a provision-subscription
 * error response. Two shapes are matched deliberately:
 *
 *   402 {"error":"no_payment_method"}  — what liftoff-billing returns once its
 *       own classification ships (mirrors /replace-subscription's vocabulary).
 *   400 {"code":"resource_missing", "message":"This customer has no attached
 *       payment source or default payment method…"} — the raw Stripe rejection
 *       billing forwards today.
 *
 * Keeping the legacy 400 shape means this repo retires already-queued outbox
 * rows without waiting on a billing deploy, and the two services can ship in
 * either order.
 *
 * Both arms are narrow on purpose. `resource_missing` alone is far too broad —
 * Stripe uses it for any absent object — so the payment-source phrase must be
 * present too, or an unrelated rejection would be silently swallowed as
 * "deferred" and never retried.
 */
function isNoPaymentMethodResponse(status: number, body: string): boolean {
  if (status === 402 && /"error"\s*:\s*"no_payment_method"/.test(body)) {
    return true;
  }
  if (
    status === 400 &&
    /"code"\s*:\s*"resource_missing"/.test(body) &&
    /no attached payment source or default payment method/i.test(body)
  ) {
    return true;
  }
  return false;
}

export class BillingAdminClient {
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

  private async call(method: string, path: string, payload: unknown): Promise<Response> {
    if (!this.baseUrl) {
      throw new Error('BillingAdminClient: BILLING_SERVICE_URL not configured');
    }
    const body = JSON.stringify(payload ?? {});
    const { timestamp, signature } = this.sign(method, path, body);
    const oidc = await buildOidcAuthHeader(this.baseUrl);
    const resp = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Billing-Timestamp': timestamp,
        'X-Billing-Signature': signature,
        ...oidc,
      },
      body,
    });
    return resp;
  }

  async provisionSubscription(tenantId: string, stripeCustomerId: string): Promise<{ alreadyExists: boolean }> {
    const path = '/api/internal/provision-subscription';
    const resp = await this.call('POST', path, { tenantId, stripeCustomerId });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      // Match against the FULL body, then truncate for the message — the
      // payment-source phrase sits past the first 100 characters, so testing
      // the sliced string would miss it.
      if (isNoPaymentMethodResponse(resp.status, text)) {
        throw new NoPaymentMethodError(tenantId, text.slice(0, 200));
      }
      throw new Error(`billing-admin: provision-subscription → ${resp.status}: ${text.slice(0, 200)}`);
    }
    const body = await resp.json().catch(() => ({})) as { alreadyExists?: boolean };
    return { alreadyExists: body.alreadyExists === true };
  }

  // Called FROM platform-backend TO liftoff-billing when auto-reload trigger is claimed.
  // liftoff-billing creates and pays a Stripe invoice for the reload amount.
  //
  // `tenantId` names the workspace the reload invoice belongs to, and billing
  // writes it into the invoice's Stripe metadata. It is what later resolves
  // that invoice — and any refund, dispute or fraud warning on its charge —
  // back to a tenant. A workspace with no subscription has nothing else to be
  // resolved by, so without it those events reach no row. Optional because a
  // caller that genuinely has no tenant in hand should still be able to fund
  // the wallet.
  async triggerAutoReload(stripeCustomerId: string, amountUsd: number, tenantId: string | null = null): Promise<void> {
    const path = '/api/internal/auto-reload';
    const resp = await this.call('POST', path, { stripeCustomerId, amountUsd, ...(tenantId ? { tenantId } : {}) });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`billing-admin: trigger-auto-reload → ${resp.status}: ${text.slice(0, 200)}`);
    }
  }

  // changeBillingMode REMOVED in PR 2: billing mode is set once at provision
  // time and is immutable. The downstream /api/internal/billing-mode endpoint
  // was deleted alongside; no caller in this repo references it any more.

  // Called FROM platform-backend admin router TO liftoff-billing to provision an
  // enterprise account: sets billing_tier = 'enterprise', loads wallet, configures OUs.
  // stripeCustomerId is passed explicitly so liftoff-billing doesn't have to
  // rely on a self-consistent subscriptions table at call time.
  async scrubCustomer(
    stripeCustomerId: string,
    opts: { emailHash: string; phoneHash?: string; accountId: string; tenantIds: string[] },
  ): Promise<{ fingerprintsMarked: number; paymentMethodsDeleted: number; subsCancelled: number }> {
    const path = `/api/internal/billing/accounts/${stripeCustomerId}/scrub`;
    const resp = await this.call('POST', path, opts);
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`billing-admin: scrub-customer → ${resp.status}: ${text.slice(0, 200)}`);
    }
    return (await resp.json().catch(() => ({}))) as {
      fingerprintsMarked: number;
      paymentMethodsDeleted: number;
      subsCancelled: number;
    };
  }

  async preflightDeletion(
    tenantIds: string[],
  ): Promise<{ hasActiveSubscription: boolean; hasOutstandingInvoice: boolean }> {
    const path = '/api/internal/billing/accounts/preflight-deletion';
    const resp = await this.call('POST', path, { tenantIds });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`billing-admin: preflight-deletion → ${resp.status}: ${text.slice(0, 200)}`);
    }
    return (await resp.json().catch(() => ({}))) as {
      hasActiveSubscription: boolean;
      hasOutstandingInvoice: boolean;
    };
  }

  // ── Referral programme ─────────────────────────────────────────────────────
  //
  // Every money figure on /dashboard/refer comes from here rather than being
  // computed in the control plane. INV-PB-010 makes billing plus the OU buckets
  // the one authority on money, and `creditRedeemable` / `canSendInvites` are
  // exactly the flags the contract says must never be a second authority's
  // guess: a local "does this workspace have a subscription" check would be
  // wrong for billing-exempt tenants, enterprise contracts, and anyone whose
  // subscription activated by webhook after they skipped the plan step.

  /** Totals for the programme payload, plus whether there is a subscription to
   *  redeem against at all. */
  async getReferralCreditSummary(tenantId: string): Promise<{
    creditEarnedUsd: number;
    creditAppliedUsd: number;
    creditAvailableUsd: number;
    convertedCount: number;
    subscriptionActive: boolean;
  }> {
    const path = '/api/internal/referrals/summary';
    const resp = await this.call('POST', path, { tenantId });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`billing-admin: referral-summary → ${resp.status}: ${text.slice(0, 200)}`);
    }
    const body = (await resp.json().catch(() => ({}))) as Partial<{
      creditEarnedUsd: number;
      creditAppliedUsd: number;
      creditAvailableUsd: number;
      convertedCount: number;
      subscriptionActive: boolean;
    }>;
    return {
      creditEarnedUsd: body.creditEarnedUsd ?? 0,
      creditAppliedUsd: body.creditAppliedUsd ?? 0,
      creditAvailableUsd: body.creditAvailableUsd ?? 0,
      convertedCount: body.convertedCount ?? 0,
      subscriptionActive: body.subscriptionActive === true,
    };
  }

  /**
   * The credit rows behind one page of the list.
   *
   * Keyed by referral id and asked for a page at a time rather than in bulk,
   * because the list is cursor-paginated and the rows the page is about are the
   * only ones it can render.
   */
  async getReferralCredits(
    tenantId: string,
    referralIds: string[],
  ): Promise<Array<{
    referralId: string;
    amountUsd: number;
    status: 'pending' | 'granted' | 'reversed';
    availableAt: string | null;
    expiresAt: string | null;
  }>> {
    const path = '/api/internal/referrals/credits';
    const resp = await this.call('POST', path, { tenantId, referralIds });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`billing-admin: referral-credits → ${resp.status}: ${text.slice(0, 200)}`);
    }
    const body = (await resp.json().catch(() => ({}))) as {
      credits?: Array<{
        referralId: string;
        amountUsd: number;
        status: 'pending' | 'granted' | 'reversed';
        availableAt: string | null;
        expiresAt: string | null;
      }>;
    };
    return body.credits ?? [];
  }

  /**
   * Takes back the credit one referral earned, under the
   * investigate-and-disqualify clause.
   *
   * The enforcement backstop that replaces automatic clawback, which was
   * rejected because it misses fraudsters and catches honest users. Spent
   * credit is absorbed rather than reclaimed, so the counts come back split:
   * an operator must be told what was actually recovered, not just that the
   * decision was recorded.
   */
  async disqualifyReferralCredit(
    referralId: string,
  ): Promise<{ reversed: number; absorbed: number; found: boolean }> {
    const path = `/api/internal/referrals/credits/${referralId}/disqualify`;
    const resp = await this.call('POST', path, {});
    if (resp.status === 404) return { reversed: 0, absorbed: 0, found: false };
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`billing-admin: referral-disqualify → ${resp.status}: ${text.slice(0, 200)}`);
    }
    const body = (await resp.json().catch(() => ({}))) as Partial<{
      reversed: number;
      absorbed: number;
    }>;
    return { reversed: body.reversed ?? 0, absorbed: body.absorbed ?? 0, found: true };
  }

  /** Forfeits a workspace's whole unspent balance on termination for cause or
   *  a terms violation. Immediate, with no grace period. */
  async forfeitReferralCredit(tenantId: string): Promise<{ forfeited: number }> {
    const path = `/api/internal/referrals/tenants/${tenantId}/forfeit`;
    const resp = await this.call('POST', path, {});
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`billing-admin: referral-forfeit → ${resp.status}: ${text.slice(0, 200)}`);
    }
    const body = (await resp.json().catch(() => ({}))) as Partial<{ forfeited: number }>;
    return { forfeited: body.forfeited ?? 0 };
  }

  /**
   * What may be refunded on one invoice, without moving anything.
   *
   * A quote rather than a guess: billing computes it from the invoice's own
   * term and the tenant's consumption, and the refund that follows runs the
   * same function, so the number an operator is shown is the number enforced.
   */
  async refundQuote(opts: { tenantId: string; stripeInvoiceId: string }): Promise<{
    refundableCents: number;
    refusal: string | null;
    monthsStarted: number | null;
    monthlyListCents: number | null;
    amountPaidCents: number;
  }> {
    const resp = await this.call('POST', '/api/internal/refund-quote', opts);
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`billing-admin: refund-quote → ${resp.status}: ${text.slice(0, 200)}`);
    }
    return (await resp.json()) as Awaited<ReturnType<BillingAdminClient['refundQuote']>>;
  }

  /**
   * Issues a refund as a credit note against the invoice, and cancels the
   * subscription, because the Terms say a refund ends access at once.
   *
   * `idempotencyKey` is passed through to Stripe, so a replay returns the
   * original credit note rather than issuing a second.
   */
  async issueRefund(opts: {
    tenantId: string;
    stripeInvoiceId: string;
    amountCents: number;
    reason: string;
    idempotencyKey: string;
  }): Promise<{ creditNoteId: string; refundedCents: number; cancelledSubscriptionId: string | null }> {
    const resp = await this.call('POST', '/api/internal/refund', opts);
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      // The refusal reason travels in the body; the caller turns it into a 409
      // rather than a generic failure, so an operator learns WHY.
      throw Object.assign(new Error(`billing-admin: refund → ${resp.status}: ${text.slice(0, 200)}`), {
        status: resp.status,
        body: text,
      });
    }
    return (await resp.json()) as Awaited<ReturnType<BillingAdminClient['issueRefund']>>;
  }

  async provisionEnterprise(
    opts: {
      tenantId: string; stripeCustomerId: string;
      includedOus: number; precommitExtraOus: number;
      includedRateUsdPerOu: number; precommitRateUsdPerOu: number; reloadRateUsdPerOu: number;
      stripeBilled: boolean; isAnnualPlan: boolean; annualTotalUsdCents: number | null;
      // PR 4 — opt-in cleanup pre-step on the billing side. Default `undefined`
      // forwards as `undefined` and the billing-side handler treats it as false.
      // Existing call sites (router.ts admin provision-enterprise) pass nothing
      // → backwards-compatible. PR 5's enterprise-setup endpoint sets this to
      // true to trigger orphan-state cleanup before provisioning.
      cleanOrphanState?: boolean;
    },
  ): Promise<void> {
    const path = '/api/internal/provision-enterprise';
    const resp = await this.call('POST', path, opts);
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`billing-admin: provision-enterprise → ${resp.status}: ${text.slice(0, 200)}`);
    }
  }
}

let _client: BillingAdminClient | null = null;
export function getBillingAdminClient(): BillingAdminClient {
  if (!_client) {
    const url = process.env.BILLING_SERVICE_URL ?? '';
    const token = process.env.BILLING_SERVICE_TOKEN ?? '';
    _client = new BillingAdminClient(url, token);
  }
  return _client;
}
