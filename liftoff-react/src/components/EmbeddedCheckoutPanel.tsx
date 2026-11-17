import { useState, useEffect, useCallback } from 'react'
import { loadStripe } from '@stripe/stripe-js'
import { EmbeddedCheckoutProvider, EmbeddedCheckout } from '@stripe/react-stripe-js'
import { useQueryClient } from '@tanstack/react-query'
import { createCheckoutSession, type CreateCheckoutSessionInput } from '../services/billing'
import './PaymentForm.css'

const stripePromise = loadStripe(import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY ?? '')

interface EmbeddedCheckoutPanelProps {
  tenantId: string
  planId: string
  billingPeriod: 'monthly' | 'yearly'
  committedOus?: number
  returnUrl: string
  // Dev-only flag — see CreateCheckoutSessionInput.replaceExisting.
  replaceExisting?: boolean
  onComplete?: () => void
}

export default function EmbeddedCheckoutPanel({
  tenantId,
  planId,
  billingPeriod,
  committedOus,
  returnUrl,
  replaceExisting,
  onComplete,
}: EmbeddedCheckoutPanelProps) {
  const queryClient = useQueryClient()
  const [clientSecret, setClientSecret] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    if (!tenantId || !planId) return
    const input: CreateCheckoutSessionInput = {
      planId,
      billingPeriod,
      committedOus,
      returnUrl,
      replaceExisting,
    }
    createCheckoutSession(tenantId, input)
      .then(({ clientSecret: cs }) => setClientSecret(cs))
      .catch(() => setLoadError('Could not initialise checkout. Please try again.'))
  }, [tenantId, planId, billingPeriod, committedOus, returnUrl, replaceExisting])

  const fetchClientSecret = useCallback(() => Promise.resolve(clientSecret ?? ''), [clientSecret])

  const handleComplete = () => {
    queryClient.invalidateQueries({ queryKey: ['billing-overview'] })
    queryClient.invalidateQueries({ queryKey: ['billing-payment-methods'] })
    queryClient.invalidateQueries({ queryKey: ['billing-current-usage'] })
    queryClient.invalidateQueries({ queryKey: ['active-subscription'] })
    onComplete?.()
  }

  if (loadError) {
    return (
      <div className="payment-form__panel">
        <p className="payment-form__subtitle">{loadError}</p>
      </div>
    )
  }

  if (!clientSecret) {
    return (
      <div className="payment-form__panel">
        <div className="payment-form__loading">
          <div className="loading-spinner" role="status" aria-label="Loading checkout" />
        </div>
      </div>
    )
  }

  return (
    <div className="payment-form__panel">
      <EmbeddedCheckoutProvider
        stripe={stripePromise}
        options={{ fetchClientSecret, onComplete: handleComplete }}
      >
        <EmbeddedCheckout />
      </EmbeddedCheckoutProvider>
    </div>
  )
}
