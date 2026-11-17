import { useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { auth } from '../config/firebase'
import { useTenant } from './useTenant'
import { ApiError } from '../services/api'
import {
  getBillingOverview,
  getInvoices,
  getUpcomingInvoice,
  getCurrentUsage,
  getPaymentMethods,
  getActiveSubscription,
  getAutoReload,
  updateAutoReload,
  disableAutoReload,
  purchaseCredits,
  cancelSubscription,
  lookupPromoCode,
  subscribePlan,
  changePlan,
  replaceSubscription,
  type AutoReloadSettings,
  type BillingInvoicesPage,
  type CurrentUsage,
} from '../services/billing'
import { track } from '../lib/analytics'
import { stripePromise } from '../components/stripeClient'
import { PAYMENT_FORM_POLL_CONFIG } from '../components/paymentFormPollConfig'

// Don't retry on 4xx client errors — they indicate missing routes or bad
// requests that won't succeed on retry, and only add console noise.
const retryOnServerError = (_: number, error: unknown) =>
  !(error instanceof ApiError && error.status < 500)

const API_BASE_URL =
  import.meta.env.DEV && import.meta.env.VITE_DISABLE_MSW?.toLowerCase() !== 'true'
    ? ''
    : (import.meta.env.VITE_API_URL || 'http://localhost:8080')

export function useBillingOverview() {
  const { currentTenant: tenant } = useTenant()
  return useQuery({
    queryKey: ['billing-overview', tenant?.id],
    queryFn: () => getBillingOverview(tenant!.id),
    enabled: !!tenant?.id,
    staleTime: 300_000,
    retry: retryOnServerError,
  })
}

export function useInvoices() {
  const { currentTenant: tenant } = useTenant()
  return useQuery({
    queryKey: ['billing-invoices', tenant?.id],
    queryFn: () => getInvoices(tenant!.id, { limit: 20 }),
    enabled: !!tenant?.id,
    staleTime: 300_000,
    retry: retryOnServerError,
  })
}

export function useLoadMoreInvoices() {
  const queryClient = useQueryClient();
  const { currentTenant: tenant } = useTenant();
  return useMutation({
    mutationFn: (cursor: string) => getInvoices(tenant!.id, { limit: 20, cursor }),
    onSuccess: (newPage: BillingInvoicesPage) => {
      queryClient.setQueryData(
        ['billing-invoices', tenant?.id],
        (old: BillingInvoicesPage | undefined) => {
          if (!old) return newPage;
          return {
            invoices: [...old.invoices, ...newPage.invoices],
            hasMore: newPage.hasMore,
            nextCursor: newPage.nextCursor,
          };
        },
      );
    },
  });
}

export function useUpcomingInvoice() {
  const { currentTenant: tenant } = useTenant()
  return useQuery({
    queryKey: ['billing-upcoming-invoice', tenant?.id],
    queryFn: () => getUpcomingInvoice(tenant!.id),
    enabled: !!tenant?.id,
    staleTime: 60_000,
    retry: retryOnServerError,
  })
}

function useBillingLiveState(tenantId: string | undefined) {
  const queryClient = useQueryClient()
  useEffect(() => {
    if (!tenantId) return
    let closed = false
    let abortController: AbortController | null = null

    async function connect() {
      const token = await auth.currentUser?.getIdToken()
      if (closed) return
      abortController = new AbortController()
      try {
        const response = await fetch(
          `${API_BASE_URL}/api/billing/accounts/${tenantId}/live-state`,
          {
            headers: token ? { Authorization: `Bearer ${token}` } : {},
            signal: abortController.signal,
          },
        )
        if (!response.ok || !response.body) return
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        while (!closed) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          let eventType = ''
          for (const line of lines) {
            if (line.startsWith('event: ')) {
              eventType = line.slice(7).trim()
            } else if (line.startsWith('data: ') && eventType === 'billing_state') {
              try {
                const data = JSON.parse(line.slice(6))
                queryClient.setQueryData(['billing-current-usage', tenantId], (old: unknown) =>
                  old ? { ...(old as object), ...data } : data,
                )
              } catch {
                // ignore parse errors
              }
              eventType = ''
            }
          }
        }
      } catch {
        // fall through to refetchInterval on any error
      }
    }

    connect()
    return () => {
      closed = true
      abortController?.abort()
    }
  }, [tenantId, queryClient])
}

export function useCurrentUsage() {
  const { currentTenant: tenant } = useTenant()
  useBillingLiveState(tenant?.id)
  return useQuery({
    queryKey: ['billing-current-usage', tenant?.id],
    queryFn: () => getCurrentUsage(tenant!.id),
    enabled: !!tenant?.id,
    staleTime: 10_000,
    refetchInterval: 60_000,
    retry: retryOnServerError,
  })
}

export function usePaymentMethods() {
  const { currentTenant: tenant } = useTenant()
  return useQuery({
    queryKey: ['billing-payment-methods', tenant?.id],
    queryFn: () => getPaymentMethods(tenant!.id),
    enabled: !!tenant?.id,
    staleTime: 300_000,
    retry: retryOnServerError,
  })
}

export function useActiveSubscription() {
  const { currentTenant: tenant } = useTenant()
  return useQuery({
    queryKey: ['billing-active-subscription', tenant?.accountId],
    queryFn: () => getActiveSubscription(tenant!.accountId),
    enabled: !!tenant?.accountId,
    staleTime: 300_000,
    retry: retryOnServerError,
  })
}

export function useAutoReload() {
  const { currentTenant: tenant } = useTenant()
  return useQuery({
    queryKey: ['billing-auto-reload', tenant?.id],
    queryFn: () => getAutoReload(tenant!.id),
    enabled: !!tenant?.id,
    staleTime: 300_000,
    retry: retryOnServerError,
  })
}

export function useUpdateAutoReload() {
  const queryClient = useQueryClient()
  const { currentTenant: tenant } = useTenant()
  return useMutation({
    mutationFn: (settings: { thresholdUsd: number; reloadAmountUsd: number }) =>
      updateAutoReload(tenant!.id, settings),
    onSuccess: (_data, settings) => {
      track('auto_reload_enabled', {
        threshold_usd: settings.thresholdUsd,
        reload_amount_usd: settings.reloadAmountUsd,
      })
      queryClient.setQueryData<AutoReloadSettings>(['billing-auto-reload', tenant?.id], { enabled: true, ...settings })
    },
  })
}

export function useDisableAutoReload() {
  const queryClient = useQueryClient()
  const { currentTenant: tenant } = useTenant()
  return useMutation({
    mutationFn: () => disableAutoReload(tenant!.id),
    onSuccess: () => {
      track('auto_reload_disabled', {})
      queryClient.setQueryData(['billing-auto-reload', tenant?.id], null)
    },
  })
}

/**
 * Buy credit, from the request through to the balance the person sees next.
 *
 * Three steps rather than one call, because the charge no longer happens on
 * the server. The server finalizes an invoice and hands back its client
 * secret; the browser confirms it, which is the only way the card's issuer can
 * present a 3D Secure challenge and therefore the only way the liability for a
 * fraudulent dispute moves to the issuer. The wallet is then credited by the
 * `invoice.paid` webhook, not by the confirmation, so the balance arrives a
 * moment later and is waited for.
 *
 * A throw here is what the modal shows: the issuer's own decline or
 * authentication message, rather than a generic failure.
 */
export function usePurchaseCredits() {
  const queryClient = useQueryClient()
  const { currentTenant: tenant } = useTenant()
  return useMutation({
    mutationFn: async (amountUsd: number) => {
      const tenantId = tenant!.id
      // Read before buying: the webhook credits an amount, and the only
      // reliable sign it has landed is the balance moving off what it was.
      const before = (await getCurrentUsage(tenantId).catch(() => null))?.creditBalanceUsd ?? 0

      const result = await purchaseCredits(tenantId, amountUsd)
      if (!('status' in result)) return { confirmed: false as const }

      const stripe = await stripePromise
      if (!stripe) throw new Error('The payment form could not be loaded. Please refresh the page and try again.')

      // Stripe.js opens the issuer's authentication dialog itself when one is
      // required, and resolves once the person is through it.
      const { error } = await stripe.confirmCardPayment(result.clientSecret, {
        payment_method: result.paymentMethodId,
      })
      if (error) throw new Error(error.message ?? 'Your card could not be charged.')

      await waitForCreditedBalance(tenantId, before, queryClient)
      return { confirmed: true as const }
    },
    onSuccess: (_data, amountUsd) => {
      track('credits_purchased', { amount_usd: amountUsd })
      queryClient.invalidateQueries({ queryKey: ['billing-current-usage', tenant?.id] })
    },
  })
}

/**
 * Wait for the webhook that credits the wallet, bounded.
 *
 * Same cadence the card form already polls on. Resolves either way and never
 * throws: the payment has succeeded by this point, so a webhook slower than
 * the deadline is a late balance, not a failed purchase, and reporting it as
 * one would tell the person to buy the credit twice.
 */
async function waitForCreditedBalance(
  tenantId: string,
  before: number,
  queryClient: ReturnType<typeof useQueryClient>,
): Promise<boolean> {
  const deadline = Date.now() + PAYMENT_FORM_POLL_CONFIG.timeoutMs
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, PAYMENT_FORM_POLL_CONFIG.intervalMs))
    try {
      const fresh = await getCurrentUsage(tenantId)
      if (fresh) {
        queryClient.setQueryData<CurrentUsage>(['billing-current-usage', tenantId], fresh)
        if ((fresh.creditBalanceUsd ?? 0) > before) return true
      }
    } catch {
      // Transient — keep polling until the deadline.
    }
  }
  return false
}

export function useCancelSubscription() {
  const queryClient = useQueryClient()
  const { currentTenant: tenant } = useTenant()
  return useMutation({
    mutationFn: () => cancelSubscription(tenant!.id),
    onSuccess: () => {
      const activeSub = queryClient.getQueryData<{ planId?: string } | null>(['billing-active-subscription', tenant?.accountId])
      track('subscription_canceled', { plan_id: activeSub?.planId ?? '' })
      queryClient.invalidateQueries({ queryKey: ['billing-overview', tenant?.id] })
    },
  })
}

// Blur-time promo-code validation. Fires when the input loses focus so the
// user gets a "Promo code applied" / "Invalid promo code" toast + green check
// before they hit Subscribe. The /subscribe endpoint re-validates on submit;
// this hook is purely for the affirmation UX.
export function useLookupPromoCode() {
  const { currentTenant: tenant } = useTenant()
  return useMutation({
    mutationFn: ({ code, planId, billingPeriod }: { code: string; planId: string; billingPeriod: 'monthly' | 'yearly' }) =>
      lookupPromoCode(tenant!.id, code, planId, billingPeriod),
    onSuccess: () => {
      // Service throws on invalid; valid:true is the only success shape.
      track('promo_code_looked_up', { result: 'applied' })
    },
    onError: (err) => {
      const code = err instanceof ApiError ? err.message : ''
      const result: 'applied' | 'invalid' | 'not_applicable' =
        code === 'promo_code_not_applicable' ? 'not_applicable' : 'invalid'
      track('promo_code_looked_up', { result })
    },
  })
}

export function useSubscribePlan() {
  const queryClient = useQueryClient()
  const { currentTenant: tenant } = useTenant()
  return useMutation({
    mutationFn: ({ planId, billingPeriod, committedOus, promoCode }: { planId: string; billingPeriod: 'monthly' | 'yearly'; committedOus?: number; promoCode?: string }) =>
      subscribePlan(tenant!.id, planId, billingPeriod, committedOus, promoCode),
    onSuccess: (_data, { planId, billingPeriod, committedOus, promoCode }) => {
      track('subscription_started', {
        plan_id: planId,
        billing_period: billingPeriod,
        committed_ous: committedOus ?? 0,
        promo_applied: !!promoCode,
      })
      queryClient.invalidateQueries({ queryKey: ['active-subscription', tenant?.accountId] })
      queryClient.invalidateQueries({ queryKey: ['billing-overview', tenant?.id] })
    },
  })
}

export function useChangePlan() {
  const queryClient = useQueryClient()
  const { currentTenant: tenant } = useTenant()
  return useMutation({
    mutationFn: ({ planId, billingPeriod, committedOus }: { planId: string; billingPeriod: 'monthly' | 'yearly'; committedOus?: number }) =>
      changePlan(tenant!.id, planId, billingPeriod, committedOus),
    onSuccess: (_data, { planId, billingPeriod }) => {
      const activeSub = queryClient.getQueryData<{ planId?: string } | null>(['billing-active-subscription', tenant?.accountId])
      track('plan_changed', {
        from_plan_id: activeSub?.planId ?? '',
        to_plan_id: planId,
        billing_period: billingPeriod,
      })
      queryClient.invalidateQueries({ queryKey: ['active-subscription', tenant?.accountId] })
      queryClient.invalidateQueries({ queryKey: ['billing-overview', tenant?.id] })
    },
  })
}

// PR 2: replace the current subscription via cancel-then-provision.
// Used by PricingPage when useActiveSubscription() reports an existing sub —
// the plain useSubscribePlan path 409s in that case because the one-active-
// per-tenant invariant from PR 5 step 8 forbids overlapping subs.
export function useReplaceSubscription() {
  const queryClient = useQueryClient()
  const { currentTenant: tenant } = useTenant()
  return useMutation({
    mutationFn: ({ planId, billingPeriod, committedOus }: { planId: 'core' | 'growth' | 'scale'; billingPeriod: 'monthly' | 'yearly'; committedOus?: number }) =>
      replaceSubscription(tenant!.id, planId, billingPeriod, committedOus),
    onSuccess: (_data, { planId, billingPeriod }) => {
      const activeSub = queryClient.getQueryData<{ planId?: string } | null>(['billing-active-subscription', tenant?.accountId])
      track('subscription_replaced', {
        from_plan_id: activeSub?.planId ?? '',
        to_plan_id: planId,
        billing_period: billingPeriod,
      })
      queryClient.invalidateQueries({ queryKey: ['active-subscription', tenant?.accountId] })
      queryClient.invalidateQueries({ queryKey: ['billing-overview', tenant?.id] })
    },
  })
}
