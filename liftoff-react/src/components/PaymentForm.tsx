import { useState, useEffect, useRef } from 'react'
import { Elements, PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js'
import { useQueryClient } from '@tanstack/react-query'
import { createSetupIntent, setDefaultPaymentMethod, retryOutstandingCharge, getCurrentUsage, type CurrentUsage } from '../services/billing'
import { ApiError } from '../services/api'
import Button from './Button'
import { stripeAppearance } from './stripeAppearance'
import { track } from '../lib/analytics'
import './PaymentForm.css'
import { PAYMENT_FORM_POLL_CONFIG } from './paymentFormPollConfig'
import { stripePromise } from './stripeClient'

interface InnerPaymentFormProps {
  tenantId: string
  title?: string
  subtitle?: string
  submitLabel?: string
  chargeOutstandingOnSave?: boolean
  error: string | null
  onError: (message: string | null) => void
  onAfterSave?: () => Promise<void>
  onSuccess: () => void
  onClose?: () => void
  onDeclinedRetry?: () => void
}

function PaymentForm({
  tenantId,
  title,
  subtitle,
  submitLabel,
  chargeOutstandingOnSave,
  error,
  onError,
  onAfterSave,
  onSuccess,
  onClose,
  onDeclinedRetry,
}: InnerPaymentFormProps) {
  const stripe = useStripe()
  const elements = useElements()
  const queryClient = useQueryClient()
  const [phase, setPhase] = useState<'idle' | 'confirming' | 'charging'>('idle')
  const cancelledRef = useRef(false)
  useEffect(() => () => { cancelledRef.current = true }, [])

  // Poll current-usage until executionBlocked === false, bounded by the
  // configured timeout. Returns true on success, false on timeout. The
  // retry-outstanding-charge backend returns ok:true even on card decline —
  // only a fresh executionBlocked=false from current-usage proves recovery.
  async function waitForUnsuspend(): Promise<boolean> {
    const deadline = Date.now() + PAYMENT_FORM_POLL_CONFIG.timeoutMs
    while (Date.now() < deadline) {
      if (cancelledRef.current) return false
      await new Promise(r => setTimeout(r, PAYMENT_FORM_POLL_CONFIG.intervalMs))
      if (cancelledRef.current) return false
      try {
        const fresh = await getCurrentUsage(tenantId)
        if (fresh) {
          queryClient.setQueryData<CurrentUsage>(['billing-current-usage', tenantId], fresh)
          if (!fresh.executionBlocked) return true
        }
      } catch {
        // transient — keep polling until the deadline
      }
    }
    return false
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!stripe || !elements) return

    setPhase('confirming')
    onError(null)

    const submitResult = await elements.submit()
    if (submitResult.error) {
      onError(submitResult.error.message ?? 'Please complete all required fields.')
      setPhase('idle')
      return
    }

    const { error: confirmError, setupIntent } = await stripe.confirmSetup({
      elements,
      confirmParams: { return_url: window.location.href },
      redirect: 'if_required',
    })

    if (confirmError) {
      onError(confirmError.message ?? 'Failed to save payment method')
      setPhase('idle')
      return
    }

    const pmId = typeof setupIntent?.payment_method === 'string'
      ? setupIntent.payment_method
      : setupIntent?.payment_method?.id

    // Fired the moment Stripe's confirmSetup resolves cleanly with a
    // payment_method — i.e., the card is saved at Stripe and bound to the
    // SetupIntent. Pairs with payment_method_modal_opened to give us a
    // real conversion rate for the "add card" funnel. Fires before
    // setDefaultPaymentMethod / retryOutstandingCharge because those
    // can fail independently — the card itself IS added at this point.
    track('payment_method_added', {})

    if (pmId) {
      try {
        await setDefaultPaymentMethod(tenantId, pmId)
      } catch {
        // In the suspended flow, default-PM is load-bearing: stripe.invoices.pay()
        // charges the customer's invoice_settings.default_payment_method. If we
        // didn't update it, the retry will charge the OLD declined card and our
        // decline UI would blame the new card — wrong root cause shown.
        if (chargeOutstandingOnSave) {
          onError("We saved your card but couldn't make it the default. Please refresh and try again.")
          setPhase('idle')
          return
        }
        // Non-suspended flow: non-fatal, payment method is saved.
      }
    }

    if (chargeOutstandingOnSave) {
      setPhase('charging')
      try {
        await retryOutstandingCharge(tenantId)
      } catch (err) {
        if (err instanceof ApiError && err.status === 400) {
          // no_outstanding_balance — nothing to charge, treat as success
        } else {
          onError("We saved your card but couldn't start the charge. Please try again or contact support.")
          setPhase('idle')
          return
        }
      }

      const cleared = await waitForUnsuspend()
      if (cancelledRef.current) return
      if (!cleared) {
        // SetupIntents are single-use; confirmSetup consumed the one bound to
        // this <Elements>. Surface the decline via the panel's error state
        // (which survives the remount) and ask the panel for a new SetupIntent
        // so the user can try a different card without re-opening the modal.
        onError("That card couldn't be charged. Please try a different card.")
        onDeclinedRetry?.()
        return
      }
    }

    if (onAfterSave) {
      try {
        await onAfterSave()
      } catch (err) {
        onError(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
        setPhase('idle')
        return
      }
    }

    onSuccess()
  }

  const processing = phase !== 'idle'
  const buttonLabel = (() => {
    if (phase === 'charging') return 'Charging your card…'
    if (phase === 'confirming') return 'Saving card…'
    return submitLabel ?? (chargeOutstandingOnSave ? 'Save card & pay balance' : 'Save payment method')
  })()

  return (
    <form className="payment-form" onSubmit={handleSubmit}>
      {title && (
        <h2 id="payment-modal-title" className="payment-form__title">
          {title}
        </h2>
      )}
      {subtitle && <p className="payment-form__subtitle">{subtitle}</p>}

      {error && (
        <div role="alert" className="payment-form__error">
          {error}
        </div>
      )}

      <PaymentElement options={{ layout: 'tabs' }} />

      <div className="payment-form__actions">
        <Button type="submit" variant="primary" disabled={!stripe || processing} loading={processing}>
          {buttonLabel}
        </Button>
        {onClose && (
          <Button variant="outline" disabled={processing} onClick={onClose}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  )
}

export interface PaymentFormPanelProps {
  tenantId: string
  title?: string
  subtitle?: string
  submitLabel?: string
  chargeOutstandingOnSave?: boolean
  onAfterSave?: () => Promise<void>
  onSuccess?: () => void
  onClose?: () => void
}

export default function PaymentFormPanel({
  tenantId,
  title,
  subtitle,
  submitLabel,
  chargeOutstandingOnSave,
  onAfterSave,
  onSuccess,
  onClose,
}: PaymentFormPanelProps) {
  const queryClient = useQueryClient()
  const [clientSecret, setClientSecret] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [setupIntentNonce, setSetupIntentNonce] = useState(0)
  // Lifted from the inner form so a decline message survives the SetupIntent
  // remount triggered by onDeclinedRetry. Inner form is keyed by clientSecret
  // and unmounts when we refetch — its local state is destroyed; panel state
  // is not.
  const [error, setError] = useState<string | null>(null)

  // Dropping the previous secret is a reset, so it happens during render: the
  // inner form is keyed by clientSecret, and clearing it in the effect let one
  // frame keep the old form mounted against the new tenant.
  const [secretRequest, setSecretRequest] = useState(`${tenantId}:${setupIntentNonce}`)
  if (`${tenantId}:${setupIntentNonce}` !== secretRequest) {
    setSecretRequest(`${tenantId}:${setupIntentNonce}`)
    setClientSecret(null)
  }

  useEffect(() => {
    createSetupIntent(tenantId)
      .then(({ clientSecret: cs }) => setClientSecret(cs))
      .catch(() => setLoadError('Could not initialise payment form. Please try again.'))
  }, [tenantId, setupIntentNonce])

  const handleSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['billing-overview'] })
    queryClient.invalidateQueries({ queryKey: ['billing-payment-methods'] })
    queryClient.invalidateQueries({ queryKey: ['billing-current-usage'] })
    queryClient.invalidateQueries({ queryKey: ['billing-active-subscription'] })
    onSuccess?.()
    onClose?.()
  }

  return (
    <div className="payment-form__panel">
      {loadError ? (
        <>
          <p className="payment-form__subtitle">{loadError}</p>
          {onClose && (
            <Button variant="outline" onClick={onClose}>Close</Button>
          )}
        </>
      ) : !clientSecret ? (
        <>
          {error && (
            <div role="alert" className="payment-form__error">
              {error}
            </div>
          )}
          <div className="payment-form__loading">
            <div className="loading-spinner" role="status" aria-label="Loading payment form" />
          </div>
        </>
      ) : (
        <Elements
          stripe={stripePromise}
          options={{ clientSecret, appearance: stripeAppearance, loader: 'never' as const }}
          key={clientSecret}
        >
          <PaymentForm
            tenantId={tenantId}
            title={title}
            subtitle={subtitle}
            submitLabel={submitLabel}
            chargeOutstandingOnSave={chargeOutstandingOnSave}
            error={error}
            onError={setError}
            onAfterSave={onAfterSave}
            onSuccess={handleSuccess}
            onClose={onClose}
            onDeclinedRetry={() => setSetupIntentNonce(n => n + 1)}
          />
        </Elements>
      )}
    </div>
  )
}
