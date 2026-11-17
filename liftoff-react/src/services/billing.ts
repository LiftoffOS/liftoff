// Billing Service
// Read-only billing data: subscription, invoices, usage, payment methods.
// All endpoints are proxied through platform-backend → liftoff-billing.

import { api, ApiError } from './api'

// ── Types ──────────────────────────────────────────────────────────────────

export interface BillingSubscriptionSummary {
  stripeSubscriptionId: string
  status: string
  planId: string
  currentPeriodEnd: string
  cancelAtPeriodEnd: boolean
}

export interface BillingOverview {
  subscription: BillingSubscriptionSummary | null
  currentPeriodSpendUsd: number
  nextThresholdUsd: number
  outstandingBalanceUsd: number
  executionBlocked: boolean
  billingTier: string
  graduated: boolean
  billingPeriodStart: string | null
  hasPaymentMethod: boolean
  billingMode?: 'pre_pay' | 'post_pay'
  planType?: 'core' | 'growth' | 'scale' | null
  // OU-native allotment + consumption (replaces allocationBalanceUsd, which
  // depended on the dropped prepaid_balance_usd column).
  planIncludedOus?: number
  precommitExtraOus?: number
  ousConsumedThisPeriod?: number
  reloadBalanceUsd?: number
  suspendedReason?: string | null
}

export interface BillingInvoice {
  id: string
  number: string | null
  amountDue: number
  amountPaid: number
  status: string | null
  created: number
  periodEnd: number | null
  hostedInvoiceUrl: string | null
  invoicePdf: string | null
  planType?: 'core' | 'growth' | 'scale' | null
  allocatedOus?: number | null
  billingPeriod?: 'monthly' | 'yearly' | null
}

export interface BillingInvoicesPage {
  invoices: BillingInvoice[]
  hasMore: boolean
  nextCursor: string | null
}

export interface UpcomingInvoice {
  amountDue: number
  periodEnd: number
  nextPaymentAttempt: number | null
}

export interface PaymentMethod {
  id: string
  brand: string
  last4: string
  expMonth: number
  expYear: number
  isDefault: boolean
}

export interface PaymentMethodsResponse {
  paymentMethods: PaymentMethod[]
}

export interface ActiveSubscription {
  id: string
  accountId: string
  planId: string
  stripeSubscriptionId: string
  status: string
  currentPeriodStart: string
  currentPeriodEnd: string
}

export interface CurrentUsage {
  accountId: string;
  currentPeriodSpendUsd: number;
  nextThresholdUsd: number;
  outstandingBalanceUsd: number;
  suspended: boolean;
  executionBlocked: boolean;
  billingTier: string;
  graduated: boolean;
  billingPeriodStart: string | null;
  spendUpdatedAt: string | null;
  hasPaymentMethod: boolean;
  billingMode?: 'pre_pay' | 'post_pay';
  planType?: 'core' | 'growth' | 'scale' | null;
  // OU-native fields
  planIncludedOus: number;
  precommitExtraOus: number;
  ousConsumedThisPeriod: number;
  includedRateUsdPerOu: number;
  precommitRateUsdPerOu: number;
  reloadRateUsdPerOu: number;
  // USD wallet (Migration B drops prepaid_balance_usd; reload_balance_usd is the only credit field).
  reloadBalanceUsd?: number;
  creditBalanceUsd?: number;            // alias maintained for SettingsPage display
  suspendedReason?: string | null;
}

// ── Service functions ──────────────────────────────────────────────────────

export async function replaceSubscription(
  tenantId: string,
  planId: 'core' | 'growth' | 'scale',
  billingPeriod: 'monthly' | 'yearly',
  committedOus?: number,
): Promise<{ stripeSubscriptionId: string }> {
  return api.post<{ stripeSubscriptionId: string }>(
    `/api/billing/accounts/${tenantId}/replace-subscription`,
    { planId, billingPeriod, committedOus },
  );
}

export async function getBillingOverview(tenantId: string): Promise<BillingOverview | null> {
  try {
    return await api.get<BillingOverview>(`/api/billing/accounts/${tenantId}/overview`)
  } catch (err) {
    // Discriminate on the HTTP status (ApiError.status), NOT on whether the
    // error message string happens to contain '404'. The api.ts error builder
    // pulls the message from the response body (errorBody.message ?? .issue
    // ?? .error) before falling back to "HTTP 404"; a 404 with a populated
    // body like { message: "Tenant not found" } would otherwise bypass this
    // catch and propagate the error.
    if (err instanceof ApiError && err.status === 404) return null
    throw err
  }
}

export async function getInvoices(
  tenantId: string,
  opts?: { limit?: number; cursor?: string },
): Promise<BillingInvoicesPage> {
  const params = new URLSearchParams();
  if (opts?.limit  != null) params.set('limit',  String(opts.limit));
  if (opts?.cursor != null) params.set('cursor', opts.cursor);
  const qs = params.toString() ? `?${params}` : '';
  return api.get<BillingInvoicesPage>(`/api/billing/accounts/${tenantId}/invoices${qs}`);
}

export async function getUpcomingInvoice(tenantId: string): Promise<UpcomingInvoice | null> {
  // Backend returns 200 with `null` body for unprovisioned tenants (plan §3.2).
  const data = await api.get<UpcomingInvoice | null>(`/api/billing/accounts/${tenantId}/upcoming-invoice`)
  return data ?? null
}

export async function getCurrentUsage(tenantId: string): Promise<CurrentUsage | null> {
  try {
    return await api.get<CurrentUsage>(`/api/billing/accounts/${tenantId}/current-usage`)
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null
    throw err
  }
}

export async function getPaymentMethods(tenantId: string): Promise<PaymentMethodsResponse> {
  return api.get<PaymentMethodsResponse>(`/api/billing/accounts/${tenantId}/payment-methods`)
}

export async function retryOutstandingCharge(tenantId: string): Promise<{ ok: true; invoiceId: string }> {
  return api.post<{ ok: true; invoiceId: string }>(
    `/api/billing/accounts/${tenantId}/retry-outstanding-charge`,
    {},
  )
}

export async function createSetupIntent(tenantId: string): Promise<{ clientSecret: string }> {
  return api.post<{ clientSecret: string }>(`/api/billing/accounts/${tenantId}/setup-intent`, {})
}

export interface CreateCheckoutSessionInput {
  planId: string
  billingPeriod: 'monthly' | 'yearly'
  committedOus?: number
  returnUrl: string
  // Dev-only: when true AND the backend is running in dev, cancels the
  // tenant's existing subscription before opening this checkout session.
  // Production ignores this field.
  replaceExisting?: boolean
}

export async function createCheckoutSession(
  tenantId: string,
  input: CreateCheckoutSessionInput,
): Promise<{ clientSecret: string }> {
  return api.post<{ clientSecret: string }>(
    `/api/billing/accounts/${tenantId}/checkout-session`,
    input,
  )
}

export async function setDefaultPaymentMethod(tenantId: string, paymentMethodId: string): Promise<void> {
  await api.patch(`/api/billing/accounts/${tenantId}/default-payment-method`, { paymentMethodId })
}

export async function getActiveSubscription(accountId: string): Promise<ActiveSubscription | null> {
  try {
    return await api.get<ActiveSubscription>(`/api/subscriptions/account/${accountId}/active`)
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null
    throw err
  }
}

/** What the server did with a top-up request.
 *
 *  `requires_confirmation` is the current shape: the invoice is finalized but
 *  deliberately not paid, because a payment charged in the background can
 *  never be challenged by the card's issuer. The browser confirms it instead,
 *  which is what allows 3D Secure and, with it, the shift of liability for a
 *  fraudulent dispute onto the issuer.
 *
 *  `{ ok: true }` is the older shape, where the server charged the card
 *  itself. Kept because platform-backend and this app deploy separately: a
 *  client that only understood the new shape would treat every top-up against
 *  a not-yet-updated billing service as a failure. */
export type PurchaseCreditsResult =
  | { ok: true }
  | { status: 'requires_confirmation'; invoiceId: string; clientSecret: string; paymentMethodId: string }

export async function purchaseCredits(tenantId: string, amountUsd: number): Promise<PurchaseCreditsResult> {
  return api.post<PurchaseCreditsResult>(`/api/billing/accounts/${tenantId}/credits`, { amountUsd })
}

export interface AutoReloadSettings {
  enabled: boolean
  thresholdUsd: number
  reloadAmountUsd: number
}

/** What liftoff-billing sends: platform-backend's billing_controls fields. */
interface AutoReloadWire {
  autoReloadEnabled: boolean
  thresholdUsd: number | null
  amountUsd: number | null
}

export async function getAutoReload(tenantId: string): Promise<AutoReloadSettings | null> {
  try {
    const wire = await api.get<AutoReloadWire>(`/api/billing/accounts/${tenantId}/auto-reload`)
    if (wire.thresholdUsd == null || wire.amountUsd == null) return null
    return { enabled: wire.autoReloadEnabled, thresholdUsd: wire.thresholdUsd, reloadAmountUsd: wire.amountUsd }
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null
    throw err
  }
}

export async function updateAutoReload(
  tenantId: string,
  settings: { thresholdUsd: number; reloadAmountUsd: number },
): Promise<void> {
  await api.put(`/api/billing/accounts/${tenantId}/auto-reload`, settings)
}

export async function disableAutoReload(tenantId: string): Promise<void> {
  await api.delete(`/api/billing/accounts/${tenantId}/auto-reload`)
}

export async function cancelSubscription(tenantId: string): Promise<void> {
  await api.post(`/api/billing/accounts/${tenantId}/cancel-subscription`, {})
}

export interface PromoLookupResult {
  valid: true
  amountOffUsd: number | null
}

export async function lookupPromoCode(
  tenantId: string,
  code: string,
  planId: string,
  billingPeriod: 'monthly' | 'yearly',
): Promise<PromoLookupResult> {
  return api.post<PromoLookupResult>(`/api/billing/accounts/${tenantId}/promo/lookup`, {
    code,
    planId,
    billingPeriod,
  })
}

export async function subscribePlan(
  tenantId: string,
  planId: string,
  billingPeriod: 'monthly' | 'yearly',
  committedOus?: number,
  promoCode?: string,
): Promise<void> {
  // /subscribe is for first-time subscriptions only. To swap an existing
  // active sub for a new plan, callers must use replaceSubscription() above —
  // /subscribe will 409 (already_subscribed) thanks to the
  // subscriptions_one_active_per_tenant invariant. The dev-only
  // `replaceExisting` flag was removed in PR 2.
  await api.post(`/api/billing/accounts/${tenantId}/subscribe`, {
    planId,
    billingPeriod,
    committedOus,
    promoCode,
  })
}

export async function changePlan(
  tenantId: string,
  planId: string,
  billingPeriod: 'monthly' | 'yearly',
  committedOus?: number,
): Promise<void> {
  await api.post(`/api/billing/accounts/${tenantId}/change-plan`, { planId, billingPeriod, committedOus })
}
