import { track } from '../../../lib/analytics'
import PlanCard from '../Pricing/PlanCard'
import { pricingPlans, PLAN_SLIDER_VALUES, type BillingPeriod } from '../Pricing/data'

interface Props {
  value: string | null
  onChange: (v: string) => void
  billingPeriod: BillingPeriod
  onBillingPeriodChange: (v: BillingPeriod) => void
  planOuValues: Record<string, number>
  onPlanOuChange: (planId: string, v: number) => void
  onContinue: () => void
  canContinue: boolean
  /** Renders the top-right Skip control. Onboarding passes it so a user can
   *  reach the product without paying; the launch-blocker modal does NOT, so
   *  no escape hatch appears on the paywall.
   *
   *  A callback rather than a `showSkip` boolean on purpose: the modal has no
   *  skip behaviour to supply, so there is nothing it can forget to turn off. */
  onSkip?: () => void
}

/**
 * Verbatim port of the legacy inline PlanStep (OnboardingPage.tsx:490-551),
 * minus the Enterprise row, whose only action was to open a sales enquiry page
 * that no longer exists.
 */
export default function PlanStep({
  onChange,
  billingPeriod,
  onBillingPeriodChange,
  planOuValues,
  onPlanOuChange,
  onContinue,
  onSkip,
}: Props) {

  const handleSelectPlan = (planId: string) => {
    track('onboarding_plan_selected', { plan_id: planId, billing_period: billingPeriod })
    onChange(planId)
    onContinue()
  }

  return (
    <div className="onboarding__content onboarding__content--wide">
      {/* Absolutely positioned against `.onboarding` (position: fixed; inset: 0),
          the same context BackButton resolves against, so this lands in the
          viewport's top right rather than inside the content column. Rendered
          only when a handler is supplied — see the `onSkip` prop comment. */}
      {onSkip && (
        <button type="button" className="onboarding__skip" onClick={onSkip}>
          Skip
        </button>
      )}
      <div className="onboarding__heading">
        <h1 className="onboarding__title">Choose your plan</h1>
        <p className="onboarding__subtitle">
          You can change or cancel anytime from Settings.
        </p>
      </div>

      <div className="pricing-page__plans-grid">
        {pricingPlans.filter((p) => !p.isEnterprise).map((plan) => {
          const sliderValues = PLAN_SLIDER_VALUES[plan.id]
          const currentOus = planOuValues[plan.id] ?? sliderValues[0]
          return (
            <PlanCard
              key={plan.id}
              plan={plan}
              billingPeriod={billingPeriod}
              onBillingPeriodChange={onBillingPeriodChange}
              ouValue={currentOus}
              onOuChange={(v) => onPlanOuChange(plan.id, v)}
              ctaText="Get Started"
              onCtaClick={() => handleSelectPlan(plan.id)}
            />
          )
        })}
      </div>
    </div>
  )
}
