import { Link } from 'react-router'
import InfoCircleIcon from '../../assets/icons/info-circle.svg?react'
import TriangleAlertIcon from '../../assets/icons/triangle-alert.svg?react'
import './NeedsAttentionPanel.css'

interface AttentionItem {
  id: string
  type: string
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info'
  title: string
  description: string
  action: string
  link: string
}

interface NeedsAttentionPanelProps {
  items: AttentionItem[]
}

const severityIcons: Record<string, React.ReactNode> = {
  critical: <InfoCircleIcon width="16" height="16" />,
  high: <TriangleAlertIcon width="16" height="16" />,
  medium: <InfoCircleIcon width="16" height="16" />,
  low: <InfoCircleIcon width="16" height="16" />,
  info: <InfoCircleIcon width="16" height="16" />,
}

export default function NeedsAttentionPanel({ items }: NeedsAttentionPanelProps) {
  return (
    <div className="attention-panel">
      <div className="attention-panel__header">
        <h3 className="attention-panel__title">Needs Attention</h3>
        <span className="attention-panel__count">{items.length}</span>
      </div>
      <div className="attention-panel__list">
        {items.map((item) => (
          <Link key={item.id} to={item.link} className={`attention-item attention-item--${item.severity}`}>
            <span className="attention-item__icon">{severityIcons[item.severity]}</span>
            <div className="attention-item__content">
              <span className="attention-item__title">{item.title}</span>
              <span className="attention-item__description">{item.description}</span>
            </div>
            <span className="attention-item__action">{item.action} →</span>
          </Link>
        ))}
      </div>
    </div>
  )
}
