// Buying credit, now that the browser is what completes the payment.
//
// The server finalizes an invoice and stops. That is deliberate: a payment
// charged in the background cannot be challenged by the card's issuer, so it
// carries no 3D Secure and no shift of liability for a fraudulent dispute.
// Confirming in the browser is what buys both, and it moves two things into
// this hook that used to be nobody's job — handling the issuer's answer, and
// waiting for the webhook that actually credits the wallet.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

const TENANT_ID = 'tenant-1'

vi.mock('./useTenant', () => ({
  useTenant: () => ({ currentTenant: { id: TENANT_ID, accountId: 'account-1' } }),
}))

const mockPurchaseCredits = vi.fn()
const mockGetCurrentUsage = vi.fn()
vi.mock('../services/billing', () => ({
  purchaseCredits: (...a: unknown[]) => mockPurchaseCredits(...a),
  getCurrentUsage: (...a: unknown[]) => mockGetCurrentUsage(...a),
  // The module is imported wholesale by the hook file; every other member is
  // unused here but must exist.
  getBillingOverview: vi.fn(), getInvoices: vi.fn(), getUpcomingInvoice: vi.fn(),
  getPaymentMethods: vi.fn(), getActiveSubscription: vi.fn(), getAutoReload: vi.fn(),
  updateAutoReload: vi.fn(), disableAutoReload: vi.fn(), cancelSubscription: vi.fn(),
  lookupPromoCode: vi.fn(), subscribePlan: vi.fn(), changePlan: vi.fn(),
  replaceSubscription: vi.fn(),
}))

const mockConfirmCardPayment = vi.fn()
vi.mock('../components/stripeClient', () => ({
  stripePromise: Promise.resolve({
    confirmCardPayment: (...a: unknown[]) => mockConfirmCardPayment(...a),
  }),
}))

vi.mock('../lib/analytics', () => ({ track: vi.fn() }))

import { usePurchaseCredits } from './useBilling'
import { PAYMENT_FORM_POLL_CONFIG } from '../components/paymentFormPollConfig'

const ORIGINAL_POLL = { ...PAYMENT_FORM_POLL_CONFIG }

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

/** Balance readings the poll will see, in order. */
function usageReturning(...balances: number[]) {
  mockGetCurrentUsage.mockReset()
  for (const creditBalanceUsd of balances) {
    mockGetCurrentUsage.mockResolvedValueOnce({ creditBalanceUsd, executionBlocked: false })
  }
  mockGetCurrentUsage.mockResolvedValue({
    creditBalanceUsd: balances[balances.length - 1] ?? 0,
    executionBlocked: false,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  // Shrink the poll so the tests do not wait on production cadence.
  PAYMENT_FORM_POLL_CONFIG.intervalMs = 1
  PAYMENT_FORM_POLL_CONFIG.timeoutMs = 60
  mockConfirmCardPayment.mockResolvedValue({ paymentIntent: { status: 'succeeded' } })
})

afterEach(() => {
  PAYMENT_FORM_POLL_CONFIG.intervalMs = ORIGINAL_POLL.intervalMs
  PAYMENT_FORM_POLL_CONFIG.timeoutMs = ORIGINAL_POLL.timeoutMs
})

describe('usePurchaseCredits', () => {
  it('confirms the payment in the browser with the invoice the server finalized', async () => {
    usageReturning(30, 30, 80)
    mockPurchaseCredits.mockResolvedValue({
      status: 'requires_confirmation',
      invoiceId: 'in_1',
      clientSecret: 'pi_1_secret',
      paymentMethodId: 'pm_1',
    })

    const { result } = renderHook(() => usePurchaseCredits(), { wrapper })
    result.current.mutate(50)

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    // The client secret is what carries the 3D Secure challenge; without this
    // call the invoice would sit open and nothing would ever be charged.
    expect(mockConfirmCardPayment).toHaveBeenCalledWith('pi_1_secret', { payment_method: 'pm_1' })
  })

  it('surfaces the issuer\'s own message when the card is refused', async () => {
    usageReturning(30)
    mockPurchaseCredits.mockResolvedValue({
      status: 'requires_confirmation',
      invoiceId: 'in_2',
      clientSecret: 'pi_2_secret',
      paymentMethodId: 'pm_2',
    })
    mockConfirmCardPayment.mockResolvedValue({
      error: { message: 'Your card was declined.' },
    })

    const { result } = renderHook(() => usePurchaseCredits(), { wrapper })
    result.current.mutate(50)

    await waitFor(() => expect(result.current.isError).toBe(true))
    // "Please try again" is wrong advice for a decline and for a failed
    // authentication alike; the modal shows this text verbatim.
    expect((result.current.error as Error).message).toBe('Your card was declined.')
  })

  // The wallet is credited by the invoice.paid webhook, not by the
  // confirmation, so the balance arrives a moment after the person is through
  // the issuer's dialog. Showing them the old balance reads as a failed
  // purchase and invites a second one.
  it('waits for the webhook to credit the wallet before reporting success', async () => {
    usageReturning(30, 30, 30, 80)
    mockPurchaseCredits.mockResolvedValue({
      status: 'requires_confirmation',
      invoiceId: 'in_3',
      clientSecret: 'pi_3_secret',
      paymentMethodId: 'pm_3',
    })

    const { result } = renderHook(() => usePurchaseCredits(), { wrapper })
    result.current.mutate(50)

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    // One read before the purchase, then polls until the balance moves.
    expect(mockGetCurrentUsage.mock.calls.length).toBeGreaterThan(2)
  })

  // A webhook slower than the deadline is a late balance, not a failed
  // payment: the money has already moved. Reporting an error here would tell
  // the person to buy the same credit twice.
  it('still reports success when the webhook outlasts the poll', async () => {
    usageReturning(30)
    mockPurchaseCredits.mockResolvedValue({
      status: 'requires_confirmation',
      invoiceId: 'in_4',
      clientSecret: 'pi_4_secret',
      paymentMethodId: 'pm_4',
    })

    const { result } = renderHook(() => usePurchaseCredits(), { wrapper })
    result.current.mutate(50)

    await waitFor(() => expect(result.current.isSuccess).toBe(true), { timeout: 2000 })
  })

  // platform-backend and this app deploy separately. Against a billing service
  // that still charges the card itself, there is no secret to confirm and
  // nothing to wait for — and treating that as a failure would report every
  // successful top-up in the window as broken.
  it('accepts the older response that charged the card on the server', async () => {
    usageReturning(30)
    mockPurchaseCredits.mockResolvedValue({ ok: true })

    const { result } = renderHook(() => usePurchaseCredits(), { wrapper })
    result.current.mutate(50)

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(mockConfirmCardPayment).not.toHaveBeenCalled()
  })
})
