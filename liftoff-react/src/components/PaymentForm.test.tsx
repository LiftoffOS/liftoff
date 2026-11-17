import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import PaymentFormPanel from './PaymentForm'
import { PAYMENT_FORM_POLL_CONFIG } from './paymentFormPollConfig'
import * as billingService from '../services/billing'
import { ApiError } from '../services/api'

vi.mock('@stripe/stripe-js', () => ({
  loadStripe: () => Promise.resolve({}),
}))

const fakeStripe = {
  confirmSetup: vi.fn(),
}
const fakeElements = {
  submit: vi.fn(),
}
vi.mock('@stripe/react-stripe-js', () => ({
  Elements: ({ children }: { children: ReactNode }) => <>{children}</>,
  PaymentElement: () => <div data-testid="payment-element" />,
  useStripe: () => fakeStripe,
  useElements: () => fakeElements,
}))

vi.mock('../services/billing', async () => {
  const actual = await vi.importActual<typeof import('../services/billing')>('../services/billing')
  return {
    ...actual,
    createSetupIntent: vi.fn(),
    setDefaultPaymentMethod: vi.fn(),
    retryOutstandingCharge: vi.fn(),
    getCurrentUsage: vi.fn(),
  }
})

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  })
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
  }
}

describe('PaymentFormPanel', () => {
  const originalPollConfig = { ...PAYMENT_FORM_POLL_CONFIG }

  beforeEach(() => {
    vi.clearAllMocks()
    fakeStripe.confirmSetup.mockResolvedValue({
      setupIntent: { payment_method: 'pm_test_123' },
    })
    fakeElements.submit.mockResolvedValue({})
    vi.mocked(billingService.createSetupIntent).mockResolvedValue({ clientSecret: 'seti_test_secret' })
    vi.mocked(billingService.setDefaultPaymentMethod).mockResolvedValue(undefined)
    // Shrink the polling window so the timeout-decline test completes in
    // milliseconds rather than 30 seconds. Each test that exercises the
    // polling loop relies on these short values.
    PAYMENT_FORM_POLL_CONFIG.intervalMs = 5
    PAYMENT_FORM_POLL_CONFIG.timeoutMs = 50
  })

  afterEach(() => {
    PAYMENT_FORM_POLL_CONFIG.intervalMs = originalPollConfig.intervalMs
    PAYMENT_FORM_POLL_CONFIG.timeoutMs = originalPollConfig.timeoutMs
  })

  it('does NOT call retryOutstandingCharge when chargeOutstandingOnSave is false', async () => {
    const onSuccess = vi.fn()
    const Wrapper = createWrapper()
    render(
      <Wrapper>
        <PaymentFormPanel tenantId="t_test" onSuccess={onSuccess} onClose={() => {}} />
      </Wrapper>,
    )
    await screen.findByTestId('payment-element')
    // Click the actual button (not fireEvent.submit on the form) so this guards
    // against the submit button lacking type="submit" — a type="button" default
    // silently no-ops the click and never triggers the form's onSubmit.
    fireEvent.click(screen.getByRole('button', { name: /save payment method/i }))
    await waitFor(() => expect(onSuccess).toHaveBeenCalled())
    expect(billingService.retryOutstandingCharge).not.toHaveBeenCalled()
  })

  it('calls retryOutstandingCharge and closes when executionBlocked clears', async () => {
    vi.mocked(billingService.retryOutstandingCharge).mockResolvedValue({ ok: true, invoiceId: 'in_x' })
    vi.mocked(billingService.getCurrentUsage).mockResolvedValue({
      executionBlocked: false, outstandingBalanceUsd: 0,
    } as never)
    const onSuccess = vi.fn()
    const Wrapper = createWrapper()
    render(
      <Wrapper>
        <PaymentFormPanel tenantId="t_test" chargeOutstandingOnSave onSuccess={onSuccess} onClose={() => {}} />
      </Wrapper>,
    )
    await screen.findByTestId('payment-element')
    fireEvent.submit(screen.getByRole('button', { name: /save card/i }).closest('form')!)
    await waitFor(() => expect(billingService.retryOutstandingCharge).toHaveBeenCalledWith('t_test'))
    await waitFor(() => expect(onSuccess).toHaveBeenCalled())
  })

  it('treats 400 no_outstanding_balance as a benign success', async () => {
    vi.mocked(billingService.retryOutstandingCharge).mockRejectedValue(new ApiError('no_outstanding_balance', 400))
    vi.mocked(billingService.getCurrentUsage).mockResolvedValue({
      executionBlocked: false, outstandingBalanceUsd: 0,
    } as never)
    const onSuccess = vi.fn()
    const Wrapper = createWrapper()
    render(
      <Wrapper>
        <PaymentFormPanel tenantId="t_test" chargeOutstandingOnSave onSuccess={onSuccess} onClose={() => {}} />
      </Wrapper>,
    )
    await screen.findByTestId('payment-element')
    fireEvent.submit(screen.getByRole('button', { name: /save card/i }).closest('form')!)
    await waitFor(() => expect(onSuccess).toHaveBeenCalled())
  })

  it('surfaces a 500 retry error and keeps the modal open', async () => {
    vi.mocked(billingService.retryOutstandingCharge).mockRejectedValue(new ApiError('retry_charge_failed', 500))
    const onSuccess = vi.fn()
    const Wrapper = createWrapper()
    render(
      <Wrapper>
        <PaymentFormPanel tenantId="t_test" chargeOutstandingOnSave onSuccess={onSuccess} onClose={() => {}} />
      </Wrapper>,
    )
    await screen.findByTestId('payment-element')
    fireEvent.submit(screen.getByRole('button', { name: /save card/i }).closest('form')!)
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/couldn't start the charge/i)
    })
    expect(onSuccess).not.toHaveBeenCalled()
  })

  it('shows "card declined" and refetches SetupIntent when executionBlocked stays true', async () => {
    vi.mocked(billingService.retryOutstandingCharge).mockResolvedValue({ ok: true, invoiceId: 'in_x' })
    vi.mocked(billingService.getCurrentUsage).mockResolvedValue({
      executionBlocked: true, outstandingBalanceUsd: 42.5,
    } as never)
    // First mount fetches the initial SetupIntent. onDeclinedRetry should
    // trigger a second fetch with a new client secret.
    vi.mocked(billingService.createSetupIntent)
      .mockResolvedValueOnce({ clientSecret: 'seti_first_secret' })
      .mockResolvedValueOnce({ clientSecret: 'seti_second_secret' })

    const onSuccess = vi.fn()
    const Wrapper = createWrapper()
    render(
      <Wrapper>
        <PaymentFormPanel tenantId="t_test" chargeOutstandingOnSave onSuccess={onSuccess} onClose={() => {}} />
      </Wrapper>,
    )
    await screen.findByTestId('payment-element')
    fireEvent.submit(screen.getByRole('button', { name: /save card/i }).closest('form')!)

    // The decline message must survive the inner form's remount.
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/couldn't be charged/i)
    })
    // onDeclinedRetry incremented the nonce, so createSetupIntent fired again.
    await waitFor(() => {
      expect(vi.mocked(billingService.createSetupIntent).mock.calls.length).toBe(2)
    })
    expect(onSuccess).not.toHaveBeenCalled()
  })
})
