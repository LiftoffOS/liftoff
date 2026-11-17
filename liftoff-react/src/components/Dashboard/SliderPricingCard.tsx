import { useState } from 'react'
import Button from '../Button'
import './SliderPricingCard.css'

type BillingPeriod = 'monthly' | 'yearly'

const teamTiers = [
  { teams: 5, multiplier: 5, label: '5' },
  { teams: 10, multiplier: 10, label: '10' },
  { teams: 25, multiplier: 25, label: '25' },
  { teams: 50, multiplier: 60, label: '50' },
  { teams: 75, multiplier: 75, label: '75' },
  { teams: 100, multiplier: 100, label: '100' },
  { teams: 200, multiplier: 200, label: '200' },
  { teams: null, multiplier: null, label: 'Custom', isCustom: true },
]

export default function SliderPricingCard() {
  const [billingPeriod, setBillingPeriod] = useState<BillingPeriod>('yearly')
  const [teamTierIndex, setTeamTierIndex] = useState(1)

  const currentTier = teamTiers[teamTierIndex]
  const isCustom = currentTier.isCustom

  const basePrice = billingPeriod === 'monthly' ? 300 : 250
  const price = isCustom ? null : Math.round(basePrice * (currentTier.multiplier as number))

  const handleAddCapacity = () => {
    console.log('Add capacity')
  }

  return (
    <div className="pricing-page__hero">
      {/* Left: Slider */}
      <div className="pricing-page__hero-left">
        <div className="pricing-page__slider-header">
          <span className="pricing-page__slider-question">How much capacity should Liftoff add to your business?</span>
          <div className="pricing-page__slider-value-group">
            <span className="pricing-page__slider-value">
              {isCustom ? '200+' : currentTier.teams?.toLocaleString()}
            </span>
            <span className="pricing-page__slider-label">autonomous teams</span>
          </div>
        </div>
        <div className="pricing-page__slider-track">
          <input
            type="range"
            min="0"
            max={teamTiers.length - 1}
            value={teamTierIndex}
            onChange={(e) => setTeamTierIndex(Number(e.target.value))}
            className="pricing-page__slider-input"
            style={{ '--slider-fill': `${(teamTierIndex / (teamTiers.length - 1)) * 100}%` } as React.CSSProperties}
          />
          <div className="pricing-page__slider-ticks">
            {teamTiers.map((tier, index) => {
              const ratio = index / (teamTiers.length - 1)
              return (
                <button
                  key={index}
                  className={`pricing-page__slider-tick ${index === teamTierIndex ? 'pricing-page__slider-tick--active' : ''}`}
                  onClick={() => setTeamTierIndex(index)}
                  style={{ left: `calc(${ratio * 100}% - ${ratio * 20 - 10}px)` }}
                >
                  {tier.label}
                </button>
              )
            })}
          </div>
        </div>
      </div>

      {/* Divider */}
      <div className="pricing-page__hero-divider" />

      {/* Right: Pricing Info */}
      <div className="pricing-page__hero-right">
        <div className="pricing-card__header">
          <h2 className="pricing-card__name">{isCustom ? '200+' : currentTier.teams?.toLocaleString()} Autonomous Teams</h2>
          <p className="pricing-card__description">For your business</p>
        </div>
        <div className={`pricing-card__price ${isCustom ? 'pricing-card__price--custom' : ''}`}>
          {isCustom ? (
            <span className="pricing-card__custom-text">Custom Pricing</span>
          ) : (
            <>
              <span className="pricing-card__currency">$</span>
              <span className="pricing-card__amount">{price?.toLocaleString()}</span>
              <span className="pricing-card__period">/month</span>
            </>
          )}
        </div>
        {isCustom ? (
          <p className="pricing-card__custom-tagline">A plan tailored to your specific needs</p>
        ) : (
          <div className="pricing-card__toggle">
            <button
              className={`pricing-card__toggle-btn ${billingPeriod === 'monthly' ? 'pricing-card__toggle-btn--active' : ''}`}
              onClick={() => setBillingPeriod('monthly')}
            >
              Monthly
            </button>
            <button
              className={`pricing-card__toggle-btn ${billingPeriod === 'yearly' ? 'pricing-card__toggle-btn--active' : ''}`}
              onClick={() => setBillingPeriod('yearly')}
            >
              Yearly
            </button>
          </div>
        )}
        <p className="pricing-card__savings-note">
          {isCustom ? '\u00A0' : billingPeriod === 'yearly' ? `Billed annually, save 17%` : '\u00A0'}
        </p>
        <Button
          variant="primary"
          className="pricing-card__cta"
          onClick={handleAddCapacity}
        >
          {isCustom ? 'Contact Sales' : 'Add Capacity'}
        </Button>
        <p className="pricing-card__tax-note" style={{ visibility: isCustom ? 'hidden' : 'visible' }}>
          Prices shown do not include applicable taxes.
        </p>
      </div>
    </div>
  )
}
