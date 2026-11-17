import './OperatingHealth.css'

interface OperatingHealthProps {
  entering: number
  autonomous: number
  awaitingReview: number
  exceptions: number
  completed: number
  stuck: number
}

export default function OperatingHealth({
  entering,
  autonomous,
  awaitingReview,
  exceptions,
  completed,
  stuck
}: OperatingHealthProps) {
  const total = entering + autonomous + awaitingReview + exceptions + completed + stuck

  const segments = [
    { label: 'Entering', value: entering, color: '#3b82f6' },
    { label: 'Autonomous', value: autonomous, color: '#22c55e' },
    { label: 'Awaiting Review', value: awaitingReview, color: '#eab308' },
    { label: 'Exceptions', value: exceptions, color: '#f97316' },
    { label: 'Completed', value: completed, color: '#10b981' },
    { label: 'Stuck', value: stuck, color: '#ef4444' },
  ]

  return (
    <div className="operating-health">
      <div className="operating-health__header">
        <h3 className="operating-health__title">Live Operating Health</h3>
      </div>

      <div className="operating-health__bar">
        {segments.map((segment) => (
          <div
            key={segment.label}
            className="operating-health__segment"
            style={{
              width: `${(segment.value / total) * 100}%`,
              backgroundColor: segment.color
            }}
            title={`${segment.label}: ${segment.value}`}
          />
        ))}
      </div>

      <div className="operating-health__legend">
        {segments.map((segment) => (
          <div key={segment.label} className="operating-health__legend-item">
            <span className="operating-health__legend-dot" style={{ backgroundColor: segment.color }} />
            <span className="operating-health__legend-label">{segment.label}</span>
            <span className="operating-health__legend-value">{segment.value}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
