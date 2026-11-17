import XIcon from '../../assets/icons/x.svg?react'
import './DashboardBanner.css'

// The dashboard's notice: one sentence, one action, above the route outlet.
//
// Presentational only. It was PaymentBlockedBanner's markup until browser
// notifications needed the same shell, so that component now renders this and
// keeps its own data binding. Nothing here fetches or decides anything.

export interface DashboardBannerProps {
  /** The single sentence. Says what is true, not what to do: the action is the
   *  CTA's job. */
  message: string
  ctaLabel: string
  onCta: () => void
  /**
   * `critical` is black and cannot be dismissed, for a workspace that has
   * stopped. `quiet` is grey, for something optional.
   *
   * The distinction is not decoration. A person who has seen one black banner
   * learns what black costs them, which is worth more than the black bar was
   * ever buying on an optional prompt.
   */
  tone?: 'critical' | 'quiet'
  /** Supplying this renders the dismiss control. A critical banner should not:
   *  hiding it does not make the problem go away. */
  onDismiss?: () => void
  /** Renders inside page content rather than in the layout's slot, dropping the
   *  slot's outer margins. */
  inline?: boolean
}

export function DashboardBanner({
  message,
  ctaLabel,
  onCta,
  tone = 'critical',
  onDismiss,
  inline = false,
}: DashboardBannerProps) {
  const classes = [
    'dashboard-banner',
    tone === 'quiet' ? 'dashboard-banner--quiet' : '',
    inline ? 'dashboard-banner--inline' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={classes} role="alert">
      <span className="dashboard-banner__message">{message}</span>
      <span className="dashboard-banner__actions">
        <button type="button" className="dashboard-banner__cta" onClick={onCta}>
          {ctaLabel}
        </button>
        {onDismiss && (
          <button
            type="button"
            className="dashboard-banner__close"
            onClick={onDismiss}
            aria-label="Dismiss"
          >
            <XIcon width={16} height={16} />
          </button>
        )}
      </span>
    </div>
  )
}

export default DashboardBanner
