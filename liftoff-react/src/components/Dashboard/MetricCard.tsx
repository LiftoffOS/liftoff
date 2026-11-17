import Tooltip from '../Tooltip'
import './MetricCard.css'

interface MetricCardProps {
  label: string
  value: string | number
  change?: number
  trend?: 'up' | 'down' | 'flat'
  trendText?: string
  period?: string
  size?: 'default' | 'large'
  className?: string
  /** When true, an "up" trend is bad (e.g. cost) and renders red instead of green. */
  lowerIsBetter?: boolean
  /** Shown when the label is hovered; explains what the metric means. */
  tooltip?: React.ReactNode
}

function trendVariant(trend: 'up' | 'down' | 'flat' | undefined, lowerIsBetter: boolean): 'positive' | 'negative' | 'neutral' | null {
  if (trend === 'flat') return 'neutral'
  if (trend === 'up') return lowerIsBetter ? 'negative' : 'positive'
  if (trend === 'down') return lowerIsBetter ? 'positive' : 'negative'
  return null
}

export default function MetricCard({ label, value, change, trend, trendText, period, size = 'default', className = '', lowerIsBetter = false, tooltip }: MetricCardProps) {
  const directionUp = trend === 'up' || (change !== undefined && change > 0)
  const variant = trendVariant(trend, lowerIsBetter)
  const variantClass = variant ? `metric-card__change-value--${variant}` : ''
  const displayTrendText = trendText ?? (trend === 'flat' ? 'Same as previous period' : undefined)
  const changeVariant: 'positive' | 'negative' = (lowerIsBetter ? !directionUp : directionUp) ? 'positive' : 'negative'

  const content = (
    <>
      <span className="metric-card__label">{label}</span>
      <span className="metric-card__value">{value}</span>
      {displayTrendText && (
        <span className={`metric-card__change-value ${variantClass}`}>
          {displayTrendText}
        </span>
      )}
      {change !== undefined && !displayTrendText && (
        <div className="metric-card__change">
          <span className={`metric-card__change-value metric-card__change-value--${changeVariant}`}>
            {directionUp ? '↑' : '↓'} {Math.abs(change)}%
          </span>
          {period && <span className="metric-card__period">{period}</span>}
        </div>
      )}
    </>
  )

  return (
    <div className={`metric-card metric-card--${size} ${className}`.trim()}>
      {tooltip ? <Tooltip text={tooltip} position="top">{content}</Tooltip> : content}
    </div>
  )
}
