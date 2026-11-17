import { useEffect, useRef } from 'react'
import Button from '../../../components/Button'
import SubscribePaymentPanel from '../../../components/SubscribePaymentPanel'
import { useTenant } from '../../../hooks/useTenant'
import { useActiveSubscription } from '../../../hooks/useBilling'
import { track } from '../../../lib/analytics'
import { pricingPlans, PLAN_SLIDER_VALUES, type BillingPeriod } from '../Pricing/data'

interface Props {
  selectedPlanId: string | null
  billingPeriod: BillingPeriod
  planOuValues: Record<string, number>
  onContinue: () => void
  previewMode: boolean
}

/**
 * Onboarding payment step. Enterprise plans skip Stripe; dev preview loads
 * the real <SubscribePaymentPanel> so payment + promo-code UI are
 * exercisable on localhost.
 *
 * Resume contract: if the tenant already has an active subscription (the
 * user got past /subscribe but the flow stalled somewhere downstream — e.g.
 * the provisioning loader), skip directly to the provisioning step. The
 * backend's /subscribe is idempotent (200 with alreadyActive when an active
 * sub exists), but rendering the payment form again would mislead the user
 * into paying twice.
 */
export default function PaymentStep({
  selectedPlanId,
  billingPeriod,
  planOuValues,
  onContinue,
  previewMode,
}: Props) {
  const { currentTenant: tenant } = useTenant()
  const { data: activeSub } = useActiveSubscription()
  const skippedRef = useRef(false)
  useEffect(() => {
    if (skippedRef.current) return
    if (previewMode) return
    if (!activeSub) return
    skippedRef.current = true
    onContinue()
  }, [activeSub, previewMode, onContinue])

  const selectedPlan = pricingPlans.find((p) => p.id === selectedPlanId)
  const isEnterprise = selectedPlan?.isEnterprise
  const committedOus = selectedPlanId && PLAN_SLIDER_VALUES[selectedPlanId]
    ? (planOuValues[selectedPlanId] ?? PLAN_SLIDER_VALUES[selectedPlanId][0])
    : undefined

  if (isEnterprise) {
    return (
      <div className="onboarding__content">
        <div className="onboarding__heading">
          <h1 className="onboarding__title">Add a payment method</h1>
          <p className="onboarding__subtitle">
            Our team will reach out to scope your plan. You can continue without entering a card.
          </p>
        </div>
        <div className="onboarding__actions">
          <Button
            variant="primary"
            onClick={() => {
              track('onboarding_payment_enterprise_skipped', {})
              onContinue()
            }}
          >
            Continue
          </Button>
        </div>
      </div>
    )
  }

  const selfServePlanId =
    selectedPlan && (selectedPlan.id === 'core' || selectedPlan.id === 'growth' || selectedPlan.id === 'scale')
      ? selectedPlan.id
      : null

  if (!selfServePlanId) {
    return (
      <div className="onboarding__content">
        <div className="onboarding__heading">
          <h1 className="onboarding__title">Choose a plan first</h1>
          <p className="onboarding__subtitle">
            Use the back arrow to pick a plan before adding payment.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="onboarding__content">
      <div className="onboarding__heading">
        <h1 className="onboarding__title">Add a payment method</h1>
        <p className="onboarding__subtitle">
          {`Your ${selectedPlan!.name} plan starts once your card is saved.`}
        </p>
      </div>
      <SubscribePaymentPanel
        tenantId={tenant?.id ?? ''}
        planId={selfServePlanId}
        billingPeriod={billingPeriod}
        committedOus={committedOus}
        onComplete={onContinue}
      />
      {previewMode && (
        <div className="onboarding__dev-bypass">
          <button type="button" className="onboarding__dev-bypass-link" onClick={onContinue}>
            Skip payment (dev preview)
          </button>
        </div>
      )}
    </div>
  )
}
