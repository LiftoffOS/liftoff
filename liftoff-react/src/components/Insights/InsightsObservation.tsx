import type { ObservationBlock } from '../../types/insights'

interface InsightsObservationProps {
  block: ObservationBlock
}

const ICON_VARIANT: Record<ObservationBlock['icon'], string> = {
  '+': 'success',
  '!': 'warning',
  '-': 'error',
  '?': 'neutral',
}

export default function InsightsObservation({ block }: InsightsObservationProps) {
  const variant = ICON_VARIANT[block.icon]
  return (
    <div className="insights-report__observation">
      <span className={`insights-report__observation-icon insights-report__observation-icon--${variant}`}>
        {block.icon}
      </span>
      <p>{block.content}</p>
    </div>
  )
}
