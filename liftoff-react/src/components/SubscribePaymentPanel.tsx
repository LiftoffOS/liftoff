// Stripe Payment Element variant of the embedded onboarding checkout.
//
// Unlike <EmbeddedCheckoutPanel /> (which renders Stripe's all-in-one Checkout
// iframe), this uses Stripe's <PaymentElement /> embedded directly in our
// layout, giving:
//   - faster first paint (one SetupIntent call vs. price + checkout-session)
//   - wallet methods (Apple Pay, Link, Google Pay) auto-included
//   - layout integrates with the Liftoff design system
//   - email pre-filled from the signed-in user; no editable field
//
// Subscription creation is decoupled: we save the card via SetupIntent, then
// call useSubscribePlan once the card is confirmed. The existing
// customer.subscription.created webhook will upsert the local subscription
// row, matching the rest of the self-serve flow.
import { useState, useEffect } from 'react'
import { loadStripe } from '@stripe/stripe-js'
import { Elements, PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js'
import { useQueryClient } from '@tanstack/react-query'
import { createSetupIntent, setDefaultPaymentMethod } from '../services/billing'
import { useLookupPromoCode, useSubscribePlan } from '../hooks/useBilling'
import { useToast } from '../contexts/ToastContext'
import { ApiError } from '../services/api'
import Button from './Button'
import { stripeAppearance } from './stripeAppearance'
import './PaymentForm.css'

// One object, so an idle panel does not get a new value every render.
const IDLE_PROMO = { status: 'idle' } as const

// Toast copy for the /subscribe submit flow. The debounced /promo/lookup
// validation deliberately does NOT toast — it surfaces the result via the
// inline check/cross icon — so this function is only called when the user
// has pressed Subscribe and a redemption attempt actually failed.
function subscribeErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.message) {
      case 'already_subscribed':
        return 'You already have an active subscription.'
      case 'no_stripe_customer':
        return 'Your account is not fully set up for billing yet. Contact support.'
      case 'no_payment_method':
        return 'Add a payment method to continue.'
      case 'invalid_promo_code':
        return 'The promo code is invalid or expired.'
      case 'promo_code_not_applicable':
        return 'The selected plan is excluded from promotion.'
      default:
        return 'Could not start your subscription. Please try again.'
    }
  }
  return err instanceof Error ? err.message : 'Something went wrong. Please try again.'
}

const stripePromise = loadStripe(import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY ?? '')

// `planId` and `billingPeriod` are required and must be non-empty/non-null
// to mount the form. The /subscribe and /promo/lookup endpoints both reject
// empty values with invalid_plan_id / invalid_billing_period (silent 400),
// which surfaces as a misleading toast — see the early-return below.
interface SubscribePaymentPanelProps {
  tenantId: string
  planId: 'core' | 'growth' | 'scale'
  billingPeriod: 'monthly' | 'yearly'
  committedOus?: number
  onComplete?: () => void
}

interface SubscribeFormProps {
  clientSecret: string
  tenantId: string
  planId: 'core' | 'growth' | 'scale'
  billingPeriod: 'monthly' | 'yearly'
  committedOus?: number
  onSuccess: () => void
}

// Promo state machine — `validatedCode` is the last code we successfully ran
// through /promo/lookup. The green check renders only when the current input
// (after trim) matches `validatedCode`, so any subsequent edit drops the
// affirmation until the user blurs again.
//
// `reason` on the invalid branch is the backend error code (`invalid_promo_code`,
// `promo_code_not_applicable`, or `unknown`), used to render an inline message
// below the input. Without this the user would only see the red ✕ icon and
// couldn't tell whether they typed a wrong code, the promo is for a different
// plan, or the request just failed.
type PromoInvalidReason = 'invalid_promo_code' | 'promo_code_not_applicable' | 'unknown'
type PromoValidation =
  | { status: 'idle' }
  | { status: 'validating' }
  | { status: 'valid'; validatedCode: string }
  | { status: 'invalid'; reason: PromoInvalidReason }

function promoInlineErrorText(reason: PromoInvalidReason): string {
  switch (reason) {
    case 'invalid_promo_code':
      return 'This code is invalid or expired.'
    case 'promo_code_not_applicable':
      return "This code doesn't apply to the selected plan."
    case 'unknown':
      return "Couldn't validate this promo code. Please try again."
  }
}

function SubscribeForm({ clientSecret, tenantId, planId, billingPeriod, committedOus, onSuccess }: SubscribeFormProps) {
  const stripe = useStripe()
  const elements = useElements()
  const { mutateAsync: doSubscribe } = useSubscribePlan()
  const { mutateAsync: doLookupPromo } = useLookupPromoCode()
  const { showToast } = useToast()
  const [processing, setProcessing] = useState(false)
  const [promoCode, setPromoCode] = useState('')
  const [promoExpanded, setPromoExpanded] = useState(false)
  const [promoLookup, setPromoValidation] = useState<PromoValidation>(IDLE_PROMO)
  // An empty box, or no plan chosen yet, is idle by definition rather than by
  // an effect resetting it after the fact.
  const promoValidation: PromoValidation =
    promoCode.trim() && planId && billingPeriod ? promoLookup : IDLE_PROMO

  // Debounced live validation: 600ms after the last keystroke (or paste), we
  // hit /promo/lookup and update the inline icon (spinner → check or cross).
  // Only the SUCCESS transition toasts — invalid intermediate prefixes show
  // the red cross silently, because every pause >600ms while typing a longer
  // code would otherwise produce a stack of "invalid promo code" toasts the
  // user has to dismiss one by one. The /subscribe submit re-runs the same
  // lookup, so a redemption attempt against a still-invalid code surfaces
  // an authoritative error toast at the right moment.
  // Skips when:
  //   * input is blank,
  //   * planId or billingPeriod is missing — the parent guards against this
  //     but we double-check so we never fire a request the backend would
  //     reject with invalid_plan_id / invalid_billing_period,
  //   * the current trimmed code already matches the last successful lookup
  //     (the check is already showing — no need to re-hit Stripe).
  useEffect(() => {
    const trimmed = promoCode.trim()
    if (!trimmed || !planId || !billingPeriod) return
    if (promoValidation.status === 'valid' && promoValidation.validatedCode === trimmed) return
    const handle = setTimeout(async () => {
      setPromoValidation({ status: 'validating' })
      try {
        await doLookupPromo({ code: trimmed, planId, billingPeriod })
        setPromoValidation({ status: 'valid', validatedCode: trimmed })
        showToast('Promo code applied.', 'success')
      } catch (err) {
        const code = err instanceof ApiError ? err.message : ''
        const reason: PromoInvalidReason =
          code === 'invalid_promo_code' ? 'invalid_promo_code'
          : code === 'promo_code_not_applicable' ? 'promo_code_not_applicable'
          : 'unknown'
        setPromoValidation({ status: 'invalid', reason })
      }
    }, 600)
    return () => clearTimeout(handle)
    // doLookupPromo is stable across renders (react-query useMutation); we
    // intentionally exclude promoValidation from deps to avoid re-firing
    // when the status flips inside the timeout. eslint-disable-next-line.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [promoCode, planId, billingPeriod, showToast])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!stripe || !elements) return

    setProcessing(true)

    // Validate / collect everything in PaymentElement
    const submitResult = await elements.submit()
    if (submitResult.error) {
      showToast(submitResult.error.message ?? 'Please complete all required fields.', 'error')
      setProcessing(false)
      return
    }

    // Confirm the SetupIntent — saves the card to the customer
    const { error: confirmError, setupIntent } = await stripe.confirmSetup({
      elements,
      clientSecret,
      confirmParams: {
        // Stripe requires return_url even when redirect is suppressed
        return_url: `${window.location.origin}/onboarding`,
      },
      redirect: 'if_required',
    })

    if (confirmError) {
      showToast(confirmError.message ?? 'Failed to save card', 'error')
      setProcessing(false)
      return
    }

    const pmId = typeof setupIntent?.payment_method === 'string'
      ? setupIntent.payment_method
      : setupIntent?.payment_method?.id
    if (pmId) {
      try {
        await setDefaultPaymentMethod(tenantId, pmId)
      } catch {
        // Non-fatal — card is saved
      }
    }

    // Create the subscription server-side. The dev-only resubscribe escape
    // hatch lives on /checkout-session (used by SubscribeOnboardingPanel), not
    // /subscribe — so this code path always treats the call as a first-time
    // subscription. Existing subs cause the backend to 409 (one-active-per-tenant
    // invariant); the user is routed through PricingPage + useReplaceSubscription
    // for plan changes.
    try {
      await doSubscribe({ planId, billingPeriod, committedOus, promoCode: promoCode.trim() || undefined })
    } catch (err) {
      showToast(subscribeErrorMessage(err), 'error')
      setProcessing(false)
      return
    }

    onSuccess()
  }

  return (
    <form className="payment-form" onSubmit={handleSubmit}>
      {/* Suppress Stripe's auto-rendered mandate text — we render the
       *  equivalent disclaimer manually below the promo code so the visual
       *  order is: card → promo code → terms → Subscribe. */}
      <PaymentElement options={{ layout: 'tabs', terms: { card: 'never' } }} />
      {!promoExpanded && (
        <button
          type="button"
          className="payment-form__promo-toggle"
          onClick={() => setPromoExpanded(true)}
        >
          Have a promo code?
        </button>
      )}
      {promoExpanded && (
        <div className="payment-form__promo">
          <div className="payment-form__promo-field">
            <label htmlFor="promo-code" className="payment-form__label">Promo code</label>
            <div className="payment-form__promo-input-wrap">
              <input
                id="promo-code"
                type="text"
                value={promoCode}
                onChange={(e) => {
                  setPromoCode(e.target.value)
                  if (promoValidation.status !== 'idle') setPromoValidation({ status: 'idle' })
                }}
                placeholder="PROMO"
                autoComplete="off"
                className="payment-form__promo-input"
                aria-invalid={promoValidation.status === 'invalid' || undefined}
              />
              {promoValidation.status === 'validating' && (
                <div className="payment-form__promo-spinner" aria-label="Validating promo code" />
              )}
              {promoValidation.status === 'valid' && promoValidation.validatedCode === promoCode.trim() && (
                <svg
                  className="payment-form__promo-check"
                  viewBox="0 0 16 16"
                  aria-hidden="true"
                  focusable="false"
                >
                  <path
                    d="M3 8.5 7 12l6-7"
                    stroke="currentColor"
                    strokeWidth="2"
                    fill="none"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
              {promoValidation.status === 'invalid' && (
                <svg
                  className="payment-form__promo-cross"
                  viewBox="0 0 16 16"
                  aria-hidden="true"
                  focusable="false"
                  aria-label="Invalid promo code"
                >
                  <path
                    d="M4 4l8 8M12 4l-8 8"
                    stroke="currentColor"
                    strokeWidth="2"
                    fill="none"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
            </div>
            {promoValidation.status === 'invalid' && (
              <p className="payment-form__promo-error" role="alert">
                {promoInlineErrorText(promoValidation.reason)}
              </p>
            )}
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => { setPromoCode(''); setPromoExpanded(false); setPromoValidation({ status: 'idle' }); }}
          >
            Remove
          </Button>
        </div>
      )}
      <p className="payment-form__mandate">
        By providing your card information, you allow Liftoff OS, Inc. to charge your card for future payments in accordance with their terms.
      </p>
      <div className="payment-form__actions">
        <Button type="submit" variant="primary" disabled={!stripe || processing} loading={processing}>
          Subscribe
        </Button>
      </div>
    </form>
  )
}

export default function SubscribePaymentPanel({
  tenantId,
  planId,
  billingPeriod,
  committedOus,
  onComplete,
}: SubscribePaymentPanelProps) {
  const queryClient = useQueryClient()
  const { showToast } = useToast()
  const [clientSecret, setClientSecret] = useState<string | null>(null)

  useEffect(() => {
    if (!tenantId) return
    createSetupIntent(tenantId)
      .then(({ clientSecret: cs }) => setClientSecret(cs))
      .catch(() => showToast('Could not initialise checkout. Please try again.', 'error'))
  }, [tenantId, showToast])

  const handleSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['billing-overview'] })
    queryClient.invalidateQueries({ queryKey: ['billing-payment-methods'] })
    queryClient.invalidateQueries({ queryKey: ['billing-current-usage'] })
    queryClient.invalidateQueries({ queryKey: ['active-subscription'] })
    onComplete?.()
  }

  if (!clientSecret) {
    return (
      <div className="payment-form__panel">
        <div className="payment-form__loading">
          <div className="loading-spinner" aria-label="Loading payment form" />
        </div>
      </div>
    )
  }

  return (
    <div className="payment-form__panel">
      <Elements
        stripe={stripePromise}
        options={{
          clientSecret,
          appearance: stripeAppearance,
          loader: 'never',
        }}
        key={clientSecret}
      >
        <SubscribeForm
          clientSecret={clientSecret}
          tenantId={tenantId}
          planId={planId}
          billingPeriod={billingPeriod}
          committedOus={committedOus}
          onSuccess={handleSuccess}
        />
      </Elements>
    </div>
  )
}
