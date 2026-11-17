import { useCallback, useMemo, useState } from 'react'
import { PlanGateContext } from './planGateContext'
import type { ReactNode } from 'react'
import ModalOverlay from '../ModalOverlay'
import XIcon from '../../assets/icons/x.svg?react'
import PlanStep from '../../pages/Dashboard/Onboarding/PlanStep'
import SubscribePaymentPanel from '../SubscribePaymentPanel'
import { useTenant } from '../../hooks/useTenant'
import { ApiError } from '../../services/api'
import { PLAN_SLIDER_VALUES, pricingPlans, type BillingPeriod } from '../../pages/Dashboard/Pricing/data'
// PlanStep renders the /pricing plan cards inside the onboarding content shell,
// but neither PlanStep nor PlanCard/EnterpriseRow/OuSlider imports a stylesheet.
// The rules that dress them live in PricingPage.css and OnboardingPage.css,
// which are imported only by PricingPage.tsx and OnboardingPage.tsx — lazy route
// chunks that are NOT mounted when this modal opens from /dashboard/agents. So
// the gate rendered the cards with no CSS at all: one stacked column, no card
// chrome, no billing toggle, nothing like /pricing. Importing both here makes
// the gate own its own appearance rather than depending on whether the person
// happened to visit another route first in the same session.
import '../../pages/Dashboard/PricingPage.css'
import '../../pages/Dashboard/OnboardingPage.css'
import './PlanGate.css'

/**
 * The launch-time payment gate (ADR-050).
 *
 * Paying is not required to finish onboarding — a workspace can browse, build a
 * team and save it as a draft with no subscription. Paying IS required to
 * launch. The server enforces that: `POST /api/internal-agents` with
 * `status:'active'` and `PATCH /api/internal-agents/:id/status → active` both
 * answer `402 payment_required`. This modal is the pleasant face of that
 * refusal, not the refusal itself.
 *
 * THE TRIGGER IS THE SERVER'S 402, NEVER A CLIENT GUESS. INV-PB-010 makes
 * billing_controls plus the OU buckets the one money authority; a local "did
 * this user skip the plan step" flag would be a second one, and it would be
 * wrong for billing-exempt tenants, enterprise contracts, and anyone whose
 * subscription activated by webhook after they skipped. So callers hand the
 * caught error to `openIfPaymentRequired` and it decides.
 */

export function PlanGateProvider({ children }: { children: ReactNode }) {
  const [reason, setReason] = useState<string | null>(null)

  const close = useCallback(() => setReason(null), [])

  const openIfPaymentRequired = useCallback((err: unknown): boolean => {
    // 402 is the whole signal. The body also carries error:'payment_required'
    // and a `reason`, but no other call on these paths answers 402, and keying
    // on the status alone means a future refusal variant still opens the gate
    // rather than falling through to a generic toast.
    if (!(err instanceof ApiError) || err.status !== 402) return false
    // The guard's own copy distinguishes "needs an active plan" from
    // "outstanding balance of $X" from "credit balance is $0". `message` is
    // where api.ts lands the body's `message`; fall back only if the server
    // sent nothing useful.
    const serverReason = err.message && err.message !== 'payment_required' ? err.message : null
    setReason(serverReason ?? 'This workspace needs an active plan before agents can run.')
    return true
  }, [])

  const value = useMemo(() => ({ openIfPaymentRequired }), [openIfPaymentRequired])

  // The modal body is a separate component so this provider stays inert until
  // it opens. It wraps the entire dashboard, and reading tenant/auth context up
  // here would make every consumer of that subtree depend on providers it does
  // not otherwise need.
  return (
    <PlanGateContext.Provider value={value}>
      {children}
      {/* `reason` is the open/closed state, not display copy. The guard's
          sentence used to be restated at the top of the modal; the heading and
          the plan cards already say what this is, so it is held but not
          rendered. */}
      {reason !== null && <PlanGateModal onClose={close} />}
    </PlanGateContext.Provider>
  )
}

function PlanGateModal({ onClose }: { onClose: () => void }) {
  const { currentTenant } = useTenant()
  const [planId, setPlanId] = useState<string | null>(null)
  const [billingPeriod, setBillingPeriod] = useState<BillingPeriod>('monthly')
  const [planOuValues, setPlanOuValues] = useState<Record<string, number>>({})

  const selfServePlanId =
    planId === 'core' || planId === 'growth' || planId === 'scale' ? planId : null
  const committedOus = selfServePlanId && PLAN_SLIDER_VALUES[selfServePlanId]
    ? (planOuValues[selfServePlanId] ?? PLAN_SLIDER_VALUES[selfServePlanId][0])
    : undefined
  // Named for the payment subtitle, which is onboarding's wording and includes
  // the plan the person just picked.
  const selectedPlan = pricingPlans.find((p) => p.id === selfServePlanId)

  return (
    <ModalOverlay
      onClose={onClose}
      ariaLabelledBy="plan-gate-title"
      contentClassName="modal-overlay__content--wide plan-gate-modal"
    >
      <div className="plan-gate">
        {/* Onboarding's heading, verbatim: the same markup, the same classes
            and the same words PlanStep and PaymentStep render in the wizard.
            The gate used to invent its own "Choose a plan to launch" and
            restate the server's refusal underneath it, which read as a
            different product from the flow the person had just come through.
            Owned here rather than left to PlanStep so one heading spans both
            halves of the modal and `ariaLabelledBy` has a stable target when
            the plan picker gives way to the payment panel. */}
        <div className="modal-header plan-gate__header">
          <div className="onboarding__heading">
            <h1 id="plan-gate-title" className="onboarding__title">
              {selfServePlanId ? 'Add a payment method' : 'Choose your plan'}
            </h1>
            <p className="onboarding__subtitle">
              {selfServePlanId && selectedPlan
                ? `Your ${selectedPlan.name} plan starts once your card is saved.`
                : 'You can change or cancel anytime from Settings.'}
            </p>
          </div>
          {/* The modal was already dismissible by clicking the overlay and by
              Escape, both of which ModalOverlay gives it for free. The only
              thing missing was somewhere to see that. This adds no escape
              hatch the person did not already have, and it takes nothing away
              from the gate: the refusal is the server's 402, and this modal is
              only how it is reported. Same .modal-header/.modal-close pair the
              other billing modals use. */}
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
            <XIcon width={16} height={16} />
          </button>
        </div>

        {/* PlanStep is mounted WITHOUT `onSkip`, so no Skip control renders
            here. There is nothing to forget to switch off: the modal has no
            skip behaviour to hand it. */}
        {!selfServePlanId && (
          <PlanStep
            value={planId}
            onChange={setPlanId}
            billingPeriod={billingPeriod}
            onBillingPeriodChange={setBillingPeriod}
            planOuValues={planOuValues}
            onPlanOuChange={(id, v) => setPlanOuValues((m) => ({ ...m, [id]: v }))}
            onContinue={() => { /* selecting a plan swaps this for the payment panel */ }}
            canContinue={!!planId}
          />
        )}

        {selfServePlanId && currentTenant?.id && (
          <SubscribePaymentPanel
            tenantId={currentTenant.id}
            planId={selfServePlanId}
            billingPeriod={billingPeriod}
            committedOus={committedOus}
            onComplete={onClose}
          />
        )}
      </div>
    </ModalOverlay>
  )
}
