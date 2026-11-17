import { useState, useEffect, useRef } from 'react'
import { useNavigate, useLocation, useSearchParams } from 'react-router'
import { BackButton } from '../../components'
import { PageHead } from '../../components/common'
import { useActiveSubscription, useChangePlan, useReplaceSubscription, useSubscribePlan } from '../../hooks/useBilling'
import { useAuth } from '../../contexts/AuthContext'
import { useToast } from '../../contexts/ToastContext'
import PaymentUpdateModal from '../../components/PaymentUpdateModal'
import { useTenant } from '../../hooks/useTenant'
import PlanCard from './Pricing/PlanCard'
import {
  pricingPlans,
  PLAN_HIERARCHY,
  PLAN_SLIDER_VALUES,
  EXTRA_OU_PRICE,
  type BillingPeriod,
  type PricingPlan,
} from './Pricing/data'
import './PricingPage.css'
import { track } from '../../lib/analytics'

export default function PricingPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const [billingPeriod, setBillingPeriod] = useState<BillingPeriod>('monthly')
  const [planOuValues, setPlanOuValues] = useState<Record<string, number>>({})
  const { user } = useAuth()
  const [searchParams] = useSearchParams()
  const planParam = searchParams.get('plan')
  const { currentTenant: tenant } = useTenant()
  const { data: activeSubscription, isLoading: subscriptionLoading } = useActiveSubscription()
  const currentPlanId = activeSubscription?.planId ?? null
  const { mutateAsync: doChangePlan } = useChangePlan()
  const { mutateAsync: doSubscribe } = useSubscribePlan()
  const { mutateAsync: doReplaceSubscription } = useReplaceSubscription()
  const { showToast } = useToast()
  const [pendingPlan, setPendingPlan] = useState<{ planId: string; name: string; committedOus: number } | null>(null)
  const [consumedPlanParam, setConsumedPlanParam] = useState<string | null>(null)
  const viewedRef = useRef(false)
  useEffect(() => {
    if (viewedRef.current) return
    viewedRef.current = true
    track('pricing_viewed', { surface: 'dashboard' })
  }, [])

  // After a login redirect, open the modal on the plan that was picked before
  // signing in. Opening it is state, so it happens while rendering; stripping
  // ?plan= from the URL is navigation, so it happens in the effect below.
  const autoOpenPlan =
    user && planParam && !subscriptionLoading && !currentPlanId && consumedPlanParam !== planParam
      ? pricingPlans.find(p => p.id === planParam && !p.isEnterprise)
      : undefined
  if (autoOpenPlan && planParam) {
    setConsumedPlanParam(planParam)
    setPendingPlan({
      planId: autoOpenPlan.id,
      name: autoOpenPlan.name,
      committedOus: PLAN_SLIDER_VALUES[autoOpenPlan.id][0],
    })
  }

  // Remove ?plan= from the URL so a remount doesn't re-open the modal.
  useEffect(() => {
    if (!consumedPlanParam) return
    const next = new URLSearchParams(searchParams)
    if (!next.has('plan')) return
    next.delete('plan')
    navigate(`${location.pathname}${next.size ? `?${next}` : ''}`, { replace: true })
  }, [consumedPlanParam, searchParams, navigate, location.pathname])

  const getButtonText = (plan: PricingPlan): string => {
    if (!currentPlanId) return 'Get Started'
    if (plan.id === currentPlanId) return 'Current Plan'
    const currentLevel = PLAN_HIERARCHY[currentPlanId] ?? 0
    const targetLevel = PLAN_HIERARCHY[plan.id] ?? 0
    if (targetLevel > currentLevel) return `Upgrade to ${plan.name}`
    return `Downgrade to ${plan.name}`
  }

  const [loadingPlanId, setLoadingPlanId] = useState<string | null>(null)

  const handlePlanSelect = async (plan: PricingPlan) => {
    track('pricing_plan_cta_clicked', { plan_id: plan.id, is_current_plan: plan.id === currentPlanId })
    if (plan.id === currentPlanId || loadingPlanId) return

    if (!user) {
      navigate(`/login?redirect=/dashboard/pricing&plan=${plan.id}`)
      return
    }

    const committedOus = planOuValues[plan.id] ?? PLAN_SLIDER_VALUES[plan.id][0]

    if (!currentPlanId) {
      setPendingPlan({ planId: plan.id, name: plan.name, committedOus })
      return
    }

    setLoadingPlanId(plan.id)
    try {
      await doChangePlan({ planId: plan.id, billingPeriod, committedOus })
      track('plan_changed', {
        from_plan_id: currentPlanId,
        to_plan_id: plan.id,
        billing_period: billingPeriod,
      })
      showToast('Your plan has been updated.', 'success')
    } catch {
      showToast('We could not process your plan update. Please try again.', 'error')
    } finally {
      setLoadingPlanId(null)
    }
  }

  const pendingPlanData = pendingPlan ? pricingPlans.find(p => p.id === pendingPlan.planId) : null
  const pendingPlanMonthly = pendingPlanData?.monthlyPrice ?? 0
  const pendingExtraOuCost = pendingPlan
    ? (pendingPlan.committedOus - PLAN_SLIDER_VALUES[pendingPlan.planId][0]) * EXTRA_OU_PRICE
    : 0
  const pendingMonthlyTotal = pendingPlanMonthly + pendingExtraOuCost
  const pendingPlanPrice = billingPeriod === 'yearly' ? pendingMonthlyTotal * 10 : pendingMonthlyTotal
  const pendingPlanPeriod = billingPeriod === 'yearly' ? 'year' : 'month'

  return (
    <div className="pricing-page pricing-page--sections">
      {/* Plan management inside the app. */}
      <PageHead
        title="Pricing"
        description="Compare Liftoff plans and pricing. agents give you the capacity to move faster, handle more, and scale more efficiently."
        noindex
      />
      <BackButton onClick={() => navigate('/dashboard/settings/billing')} />

      {/* Section 1: Hero - Dark */}
      <section className="pricing-page__section pricing-page__section--dark pricing-page__section--hero section--dark">
        <div className="pricing-page__section-inner">
          <div className="pricing-page__header">
            <h1 className="pricing-page__title">Operational Advantage</h1>
            <p className="pricing-page__subtitle">
              agents give you the capacity to move faster, handle more, and scale more efficiently.
            </p>
          </div>

          {/* Pricing Plan Cards */}
          <div className="pricing-page__plans-grid">
            {pricingPlans.filter(p => !p.isEnterprise).map((plan) => {
              const sliderValues = PLAN_SLIDER_VALUES[plan.id]
              const currentOus = planOuValues[plan.id] ?? sliderValues[0]
              const isCurrent = plan.id === currentPlanId
              return (
                <PlanCard
                  key={plan.id}
                  plan={plan}
                  billingPeriod={billingPeriod}
                  onBillingPeriodChange={(p) => {
                    track('pricing_period_changed', { period: p })
                    setBillingPeriod(p)
                  }}
                  ouValue={currentOus}
                  onOuChange={(v) => setPlanOuValues(prev => ({ ...prev, [plan.id]: v }))}
                  ctaText={getButtonText(plan)}
                  onCtaClick={() => handlePlanSelect(plan)}
                  ctaDisabled={isCurrent || !!loadingPlanId}
                  ctaLoading={loadingPlanId === plan.id}
                  ctaClassName={isCurrent ? 'pricing-plan-card__cta--current' : undefined}
                />
              )
            })}
          </div>
        </div>
      </section>

      {pendingPlan && tenant?.id && (
        <PaymentUpdateModal
          tenantId={tenant.id}
          title={`Subscribe to ${pendingPlan.name}`}
          subtitle={`Your ${pendingPlan.name} plan will auto-renew for $${pendingPlanPrice.toLocaleString()}/${pendingPlanPeriod} until canceled.`}
          submitLabel="Subscribe"
          onAfterSave={async () => {
            // PR 2: pick the right endpoint. With an active sub, /subscribe 409s
            // (one-active-per-tenant invariant) — we must cancel-then-provision
            // via /replace-subscription. Without one, /subscribe is the path.
            const planId = pendingPlan.planId as 'core' | 'growth' | 'scale';
            if (currentPlanId) {
              await doReplaceSubscription({ planId, billingPeriod, committedOus: pendingPlan.committedOus });
            } else {
              await doSubscribe({ planId, billingPeriod, committedOus: pendingPlan.committedOus });
            }
          }}
          onSuccess={() => {
            if (currentPlanId) {
              track('subscription_replaced', {
                from_plan_id: currentPlanId,
                to_plan_id: pendingPlan.planId,
                billing_period: billingPeriod,
              })
            } else {
              track('subscription_started', {
                plan_id: pendingPlan.planId,
                billing_period: billingPeriod,
                committed_ous: pendingPlan.committedOus,
                promo_applied: false,
              })
            }
            showToast('Your plan has been activated.', 'success')
          }}
          onClose={() => setPendingPlan(null)}
        />
      )}
    </div>
  )
}
