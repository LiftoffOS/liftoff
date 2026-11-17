import { Link } from 'react-router'
import './WorkflowCard.css'

interface WorkflowCardProps {
  id: string
  name: string
  volume: number
  medianTime: string
  automationRate: number
  reviewRate: number
  exceptionRate: number
  trend: number
}

export default function WorkflowCard({
  id,
  name,
  volume,
  medianTime,
  automationRate,
  reviewRate,
  exceptionRate,
  trend
}: WorkflowCardProps) {
  return (
    <Link to={`/dashboard/workflows/${id}`} className="workflow-card">
      <div className="workflow-card__header">
        <h4 className="workflow-card__name">{name}</h4>
        <span className={`workflow-card__trend ${trend >= 0 ? 'workflow-card__trend--positive' : 'workflow-card__trend--negative'}`}>
          {trend >= 0 ? '↑' : '↓'} {Math.abs(trend)}%
        </span>
      </div>

      <div className="workflow-card__stats">
        <div className="workflow-card__stat">
          <span className="workflow-card__stat-value">{volume.toLocaleString()}</span>
          <span className="workflow-card__stat-label">Volume</span>
        </div>
        <div className="workflow-card__stat">
          <span className="workflow-card__stat-value">{medianTime}</span>
          <span className="workflow-card__stat-label">Median Time</span>
        </div>
      </div>

      <div className="workflow-card__rates">
        <div className="workflow-card__rate">
          <div className="workflow-card__rate-bar">
            <div className="workflow-card__rate-fill workflow-card__rate-fill--automation" style={{ width: `${automationRate}%` }} />
          </div>
          <span className="workflow-card__rate-label">{automationRate}% auto</span>
        </div>
        <div className="workflow-card__rate-secondary">
          <span>{reviewRate}% review</span>
          <span>{exceptionRate}% exception</span>
        </div>
      </div>
    </Link>
  )
}
