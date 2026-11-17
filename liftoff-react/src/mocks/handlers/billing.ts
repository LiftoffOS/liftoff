import { http, HttpResponse } from 'msw'
import type {
  BillingOverview,
  BillingInvoicesPage,
  UpcomingInvoice,
  CurrentUsage,
  PaymentMethodsResponse,
  ActiveSubscription,
  AutoReloadSettings,
} from '../../services/billing'

// Growth plan, 18 days into a 30-day period. Rates mirror the plan_catalog seed.
// Allocation: 3,650 OUs/month = $52.14 equivalent at Core's $0.014286/OU (4.3% bonus over standard).
// Bought a $10 reload 5 days ago (620 OUs at $0.016129/OU top-up rate).
// Spent 1,350 OUs = $18.49 this period.
// Credit balance: $50.00 allocation + $10 reload − $18.49 spent = $41.51 remaining.

const MOCK_PERIOD_START    = new Date(Date.now() - 18 * 24 * 60 * 60 * 1000).toISOString()
const MOCK_PERIOD_END      = new Date(Date.now() + 12 * 24 * 60 * 60 * 1000).toISOString()
const MOCK_PERIOD_END_UNIX = Math.floor(new Date(MOCK_PERIOD_END).getTime() / 1000)

const mockActiveSubscription: ActiveSubscription = {
  id: 'sub_mock_001',
  accountId: 'acct_mock_001',
  planId: 'growth',
  stripeSubscriptionId: 'sub_mock_stripe_001',
  status: 'active',
  currentPeriodStart: MOCK_PERIOD_START,
  currentPeriodEnd: MOCK_PERIOD_END,
}

const mockOverview: BillingOverview = {
  subscription: {
    stripeSubscriptionId: 'sub_mock_stripe_001',
    status: 'active',
    planId: 'growth',
    currentPeriodEnd: MOCK_PERIOD_END,
    cancelAtPeriodEnd: false,
  },
  currentPeriodSpendUsd: 18.49,
  nextThresholdUsd: 300,
  outstandingBalanceUsd: 0,
  executionBlocked: false,
  billingTier: 'standard',
  graduated: false,
  billingPeriodStart: MOCK_PERIOD_START,
  hasPaymentMethod: true,
  billingMode: 'pre_pay',
  planType: 'growth',
  // OU-native (replaces allocationBalanceUsd which depended on dropped prepaid_balance_usd).
  // Growth plan: 3,650 included OUs; 1,350 OUs consumed this period; no precommit extras.
  planIncludedOus: 3650,
  precommitExtraOus: 0,
  ousConsumedThisPeriod: 1350,
  reloadBalanceUsd: 10.00,       // $10 reload purchased, carries over
  suspendedReason: null,
}

// Starts at $41.51 — updated in-memory when user adds credit via the modal.
let mockCreditBalance = 41.51

const mockCurrentUsage: CurrentUsage = {
  accountId: 'acct_mock_001',
  currentPeriodSpendUsd: 18.49,       // 1,350 OUs × Growth included rate $0.013699
  nextThresholdUsd: 300,
  outstandingBalanceUsd: 0,
  creditBalanceUsd: 41.51,            // overridden per-request by mockCreditBalance
  suspended: false,
  executionBlocked: false,
  billingTier: 'standard',
  graduated: false,
  billingPeriodStart: MOCK_PERIOD_START,
  spendUpdatedAt: new Date().toISOString(),
  hasPaymentMethod: true,
  billingMode: 'pre_pay',
  planType: 'growth',
  // OU-native fields (replaces totalOus / pricePerOu / monthlyAllocationUsd /
  // allocationBalanceUsd which are gone after Migration B).
  planIncludedOus: 3650,              // Growth plan included allotment
  precommitExtraOus: 0,
  ousConsumedThisPeriod: 1350,
  includedRateUsdPerOu:  0.013699,    // Growth included rate (mirrors plan_catalog seed)
  precommitRateUsdPerOu: 0.015217,
  reloadRateUsdPerOu:    0.016129,
  reloadBalanceUsd: 10.00,
  suspendedReason: null,
}

const mockPaymentMethods: PaymentMethodsResponse = {
  paymentMethods: [
    {
      id: 'pm_mock_001',
      brand: 'visa',
      last4: '4242',
      expMonth: 12,
      expYear: 2028,
      isDefault: true,
    },
  ],
}

const now = Math.floor(Date.now() / 1000)
const mockInvoices: BillingInvoicesPage = {
  invoices: [
    {
      // $10 reload purchased 5 days into current period (13 days ago)
      id: 'in_mock_reload_001',
      number: 'LIFTOFF-0005',
      amountDue: 1000,
      amountPaid: 1000,
      status: 'paid',
      created: now - 13 * 86400,
      periodEnd: null,
      hostedInvoiceUrl: 'https://invoice.stripe.com/i/acct_mock/test_invoice_reload_001?s=ap',
      invoicePdf: 'https://invoice.stripe.com/i/acct_mock/test_invoice_reload_001/pdf?s=ap',
      planType: null,
      allocatedOus: null,
      billingPeriod: null,
    },
    {
      // Current month Growth plan flat fee — fired at period start (18 days ago)
      id: 'in_mock_004',
      number: 'LIFTOFF-0004',
      amountDue: 5000,
      amountPaid: 5000,
      status: 'paid',
      created: now - 18 * 86400,
      periodEnd: MOCK_PERIOD_END_UNIX,
      hostedInvoiceUrl: 'https://invoice.stripe.com/i/acct_mock/test_invoice_004?s=ap',
      invoicePdf: 'https://invoice.stripe.com/i/acct_mock/test_invoice_004/pdf?s=ap',
      planType: 'growth',
      allocatedOus: 3650,
      billingPeriod: 'monthly',
    },
    {
      // Previous month Growth plan flat fee
      id: 'in_mock_003',
      number: 'LIFTOFF-0003',
      amountDue: 5000,
      amountPaid: 5000,
      status: 'paid',
      created: now - 48 * 86400,
      periodEnd: now - 18 * 86400,
      hostedInvoiceUrl: 'https://invoice.stripe.com/i/acct_mock/test_invoice_003?s=ap',
      invoicePdf: 'https://invoice.stripe.com/i/acct_mock/test_invoice_003/pdf?s=ap',
      planType: 'growth',
      allocatedOus: 3650,
      billingPeriod: 'monthly',
    },
    {
      // First month Growth plan flat fee
      id: 'in_mock_002',
      number: 'LIFTOFF-0002',
      amountDue: 5000,
      amountPaid: 5000,
      status: 'paid',
      created: now - 78 * 86400,
      periodEnd: now - 48 * 86400,
      hostedInvoiceUrl: 'https://invoice.stripe.com/i/acct_mock/test_invoice_002?s=ap',
      invoicePdf: 'https://invoice.stripe.com/i/acct_mock/test_invoice_002/pdf?s=ap',
      planType: 'growth',
      allocatedOus: 3650,
      billingPeriod: 'monthly',
    },
  ],
  hasMore: false,
  nextCursor: null,
}

// Upcoming: next month's Growth plan flat fee
const mockUpcomingInvoice: UpcomingInvoice = {
  amountDue: 5000,
  periodEnd: MOCK_PERIOD_END_UNIX,
  nextPaymentAttempt: MOCK_PERIOD_END_UNIX + 86400,
}

let mockAutoReload: AutoReloadSettings | null = null

// Tracks whether retry-outstanding-charge has cleared the suspended state
// in this session. Once true, the `?mock_suspended=1` URL toggle stops
// re-suspending on every poll — otherwise the modal's polling loop would
// observe an endless suspended state and time out.
let mockChargeWasReset = false

export const billingHandlers = [
  http.get('*/api/billing/accounts/:tenantId/overview', () => {
    // Dev-only toggle: append ?mock_suspended=1 to the page URL to flip the
    // tenant into a suspended state. MSW intercepts the API fetch, not the
    // page URL — so read window.location.search directly here.
    const pageParams = new URLSearchParams(window.location.search)
    if (pageParams.get('mock_suspended') === '1' && !mockChargeWasReset) {
      mockOverview.executionBlocked = true
      mockOverview.outstandingBalanceUsd = 42.50
    }
    return HttpResponse.json(mockOverview)
  }),

  http.get('*/api/billing/accounts/:tenantId/current-usage', () => {
    const pageParams = new URLSearchParams(window.location.search)
    if (pageParams.get('mock_suspended') === '1' && !mockChargeWasReset) {
      mockCurrentUsage.executionBlocked = true
      mockCurrentUsage.suspended = true
      mockCurrentUsage.outstandingBalanceUsd = 42.50
    }
    return HttpResponse.json({ ...mockCurrentUsage, creditBalanceUsd: mockCreditBalance })
  }),

  // The server finalizes an invoice and hands back its client secret; it does
  // not charge the card. The browser confirms the payment so the issuer can
  // authenticate it, and the wallet is credited by the invoice.paid webhook
  // afterwards — which is why the balance moves here rather than in the
  // response body.
  http.post('*/api/billing/accounts/:tenantId/credits', async ({ request }) => {
    const body = await request.json() as { amountUsd: number }
    mockCreditBalance += body.amountUsd
    return HttpResponse.json({
      status: 'requires_confirmation',
      invoiceId: 'in_mock_topup',
      clientSecret: 'pi_mock_topup_secret',
      paymentMethodId: 'pm_mock_default',
    })
  }),

  http.post('*/api/billing/accounts/:tenantId/subscribe', async ({ request }) => {
    const body = await request.json() as { planId: string; billingPeriod: string }
    mockActiveSubscription.planId = body.planId
    mockOverview.subscription = {
      stripeSubscriptionId: 'sub_mock_stripe_001',
      status: 'active',
      planId: body.planId,
      currentPeriodEnd: MOCK_PERIOD_END,
      cancelAtPeriodEnd: false,
    }
    return HttpResponse.json({ success: true })
  }),

  http.post('*/api/billing/accounts/:tenantId/change-plan', async ({ request }) => {
    const body = await request.json() as { planId: string; billingPeriod: string }
    mockActiveSubscription.planId = body.planId
    if (mockOverview.subscription) mockOverview.subscription.planId = body.planId
    return HttpResponse.json({ success: true })
  }),

  http.post('*/api/billing/accounts/:tenantId/cancel-subscription', () => {
    if (mockOverview.subscription) {
      mockOverview.subscription.cancelAtPeriodEnd = true
    }
    return HttpResponse.json({ success: true, cancelAtPeriodEnd: true })
  }),

  http.get('*/api/billing/accounts/:tenantId/live-state', () => {
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      start(controller) {
        const payload = JSON.stringify({
          currentPeriodSpendUsd: mockCurrentUsage.currentPeriodSpendUsd,
          executionBlocked: mockCurrentUsage.executionBlocked,
          outstandingBalanceUsd: mockCurrentUsage.outstandingBalanceUsd,
          ousConsumedThisPeriod: mockCurrentUsage.ousConsumedThisPeriod,
          spendUpdatedAt: new Date().toISOString(),
        })
        controller.enqueue(encoder.encode(`event: billing_state\ndata: ${payload}\n\n`))
        controller.close()
      },
    })
    return new HttpResponse(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
      },
    })
  }),

  http.get('*/api/billing/accounts/:tenantId/invoices', () => {
    return HttpResponse.json(mockInvoices)
  }),

  http.get('*/api/billing/accounts/:tenantId/upcoming-invoice', () => {
    return HttpResponse.json(mockUpcomingInvoice)
  }),

  http.get('*/api/billing/accounts/:tenantId/payment-methods', () => {
    return HttpResponse.json(mockPaymentMethods)
  }),

  http.post('*/api/billing/accounts/:tenantId/setup-intent', () => {
    return HttpResponse.json({ clientSecret: 'seti_1MockSetupIntent_secret_mockSecretValue123' })
  }),

  http.patch('*/api/billing/accounts/:tenantId/default-payment-method', () => {
    return new HttpResponse(null, { status: 204 })
  }),

  http.post('*/api/billing/accounts/:tenantId/retry-outstanding-charge', () => {
    // Dev-only toggle: append ?mock_card_decline=1 to the page URL to simulate
    // a 200 ok with a card decline that leaves executionBlocked=true,
    // exercising the modal's timeout/decline branch.
    const pageParams = new URLSearchParams(window.location.search)
    if (pageParams.get('mock_card_decline') !== '1') {
      mockCurrentUsage.executionBlocked = false
      mockCurrentUsage.suspended = false
      mockCurrentUsage.outstandingBalanceUsd = 0
      mockOverview.executionBlocked = false
      mockOverview.outstandingBalanceUsd = 0
      // Pin the cleared state so subsequent polls don't see the URL's
      // ?mock_suspended=1 and flip it back to suspended.
      mockChargeWasReset = true
    }
    return HttpResponse.json({ ok: true, invoiceId: 'in_mock_recovery_001' })
  }),

  http.get('*/api/subscriptions/account/:accountId/active', () => {
    return HttpResponse.json(mockActiveSubscription)
  }),

  // The wire shape liftoff-billing passes through from platform-backend, not
  // AutoReloadSettings: services/billing.ts maps one to the other.
  http.get('*/api/billing/accounts/:tenantId/auto-reload', () => {
    return HttpResponse.json({
      billingMode: 'pre_pay',
      autoReloadEnabled: mockAutoReload?.enabled ?? false,
      thresholdUsd: mockAutoReload?.thresholdUsd ?? null,
      amountUsd: mockAutoReload?.reloadAmountUsd ?? null,
    })
  }),

  http.put('*/api/billing/accounts/:tenantId/auto-reload', async ({ request }) => {
    const body = await request.json() as { thresholdUsd: number; reloadAmountUsd: number }
    if (body.thresholdUsd < 1) return HttpResponse.json({ error: 'thresholdUsd_must_be_at_least_1' }, { status: 400 })
    if (body.reloadAmountUsd < 5) return HttpResponse.json({ error: 'amountUsd_must_be_at_least_5' }, { status: 400 })
    mockAutoReload = { enabled: true, thresholdUsd: body.thresholdUsd, reloadAmountUsd: body.reloadAmountUsd }
    return HttpResponse.json({ ok: true })
  }),

  http.delete('*/api/billing/accounts/:tenantId/auto-reload', () => {
    mockAutoReload = mockAutoReload ? { ...mockAutoReload, enabled: false } : null
    return new HttpResponse(null, { status: 204 })
  }),
]
