import { useState } from 'react'
import Button from '../../../components/Button'
import RocketIcon from '../../../assets/icons/rocket.svg?react'
import CheckCircleIcon from '../../../assets/icons/check-circle.svg?react'
import ChevronDownIcon from '../../../assets/icons/chevron-down.svg?react'
import OuSlider from './OuSlider'
import {
  type PricingPlan,
  type BillingPeriod,
  PLAN_SLIDER_VALUES,
  EXTRA_OU_PRICE,
} from './data'

interface PlanCardProps {
  plan: PricingPlan
  billingPeriod: BillingPeriod
  onBillingPeriodChange: (v: BillingPeriod) => void
  ouValue: number
  onOuChange: (v: number) => void
  ctaText: string
  onCtaClick: () => void
  ctaDisabled?: boolean
  ctaLoading?: boolean
  ctaClassName?: string
}

export default function PlanCard({
  plan,
  billingPeriod,
  onBillingPeriodChange,
  ouValue,
  onOuChange,
  ctaText,
  onCtaClick,
  ctaDisabled,
  ctaLoading,
  ctaClassName,
}: PlanCardProps) {
  const [isSliderOpen, setIsSliderOpen] = useState(false)
  const sliderValues = PLAN_SLIDER_VALUES[plan.id]
  const extraOus = ouValue - sliderValues[0]
  const extraCostMonthly = extraOus * EXTRA_OU_PRICE
  const monthlyTotal = (plan.monthlyPrice ?? 0) + extraCostMonthly
  const annualTotal = monthlyTotal * 10
  const effectiveMonthly = Math.round(annualTotal / 12)
  const rawDisplay = billingPeriod === 'monthly' ? monthlyTotal : annualTotal
  const displayPrice = rawDisplay % 1 === 0 ? rawDisplay.toLocaleString() : rawDisplay.toFixed(2)

  const classes = `pricing-plan-card${plan.isPopular ? ' pricing-plan-card--popular' : ''}`

  return (
    <div className={classes}>
      {plan.isPopular && (
        <span className="pricing-plan-card__badge">Most Popular</span>
      )}
      <div className="pricing-plan-card__header">
        <h3 className="pricing-plan-card__name">{plan.name}</h3>
        <div className="pricing-plan-card__price-block">
          <span className="pricing-plan-card__currency">$</span>
          <span className="pricing-plan-card__amount">{displayPrice}</span>
          <span className="pricing-plan-card__period">/{billingPeriod === 'monthly' ? 'month' : 'year'}</span>
        </div>
        <div className="pricing-plan-card__toggle">
          <div className="pricing-page__billing-toggle">
            <button
              className={`pricing-page__billing-btn${billingPeriod === 'monthly' ? ' pricing-page__billing-btn--active' : ''}`}
              onClick={() => onBillingPeriodChange('monthly')}
            >
              Monthly
            </button>
            <button
              className={`pricing-page__billing-btn${billingPeriod === 'yearly' ? ' pricing-page__billing-btn--active' : ''}`}
              onClick={() => onBillingPeriodChange('yearly')}
            >
              Yearly
            </button>
          </div>
        </div>
      </div>
      <div className="pricing-plan-card__cta-group">
        <Button
          variant="primary"
          className={`pricing-plan-card__cta${ctaClassName ? ` ${ctaClassName}` : ''}`}
          onClick={onCtaClick}
          disabled={ctaDisabled}
          loading={ctaLoading}
        >
          {ctaText}
        </Button>
        <p className="pricing-plan-card__savings" style={{ visibility: billingPeriod === 'yearly' ? 'visible' : 'hidden' }}>
          ~${effectiveMonthly}/month · Save 17%
        </p>
      </div>
      <div className="pricing-plan-card__body" style={{ flex: 1, alignSelf: 'center', display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
          <button
            type="button"
            onClick={() => setIsSliderOpen(!isSliderOpen)}
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              width: '100%', background: 'none', border: 'none',
              cursor: 'pointer', padding: '10px 0', margin: '-10px 0',
              color: 'var(--color-gray-400)', font: 'inherit', textAlign: 'left',
              fontSize: 'var(--text-sm)',
            }}
          >
            <RocketIcon width="16" height="16" style={{ flexShrink: 0, color: '#FB411F' }} />
            <span style={{ flex: 1 }}>{ouValue.toLocaleString()} Operating Units</span>
            <span className="pricing-plan-card__ou-chevron">
              <ChevronDownIcon
                width="14" height="14"
                style={{
                  display: 'block',
                  transform: isSliderOpen ? 'rotate(180deg)' : 'none',
                  transition: 'transform 0.2s',
                }}
              />
            </span>
          </button>
          {isSliderOpen && (
            <div style={{ paddingTop: 'var(--space-3)' }}>
              <OuSlider values={sliderValues} value={ouValue} onChange={onOuChange} />
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--text-xs)', opacity: 0.5, marginTop: 2 }}>
                <span>{sliderValues[0].toLocaleString()}</span>
                <span>{sliderValues[sliderValues.length - 1].toLocaleString()}</span>
              </div>
            </div>
          )}
        </div>

        <ul className="pricing-plan-card__features" style={{ alignSelf: 'stretch', width: 'auto' }}>
          {plan.features.filter((f) => !f.includes('Operating Units')).map((feature, i) => (
            <li key={i} className="pricing-plan-card__feature">
              <CheckCircleIcon width="16" height="16" />
              {feature}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
