import AiCircleIcon from '../../assets/icons/ai-circle.svg?react'
import PersonIcon from '../../assets/icons/person.svg?react'
import MonitorIcon from '../../assets/icons/monitor.svg?react'
import './ActivityFeed.css'

interface ActivityItem {
  id: string
  type: 'ai' | 'human' | 'system'
  title: string
  timestamp: string
  details: string
}

interface ActivityFeedProps {
  items: ActivityItem[]
}

const typeIcons: Record<string, React.ReactNode> = {
  ai: <AiCircleIcon width="14" height="14" />,
  human: <PersonIcon width="14" height="14" />,
  system: <MonitorIcon width="14" height="14" />,
}

function formatTime(timestamp: string): string {
  const date = new Date(timestamp)
  return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

export default function ActivityFeed({ items }: ActivityFeedProps) {
  return (
    <div className="activity-feed">
      <div className="activity-feed__header">
        <h3 className="activity-feed__title">Recent Activity</h3>
      </div>
      <div className="activity-feed__list">
        {items.map((item) => (
          <div key={item.id} className={`activity-feed__item activity-feed__item--${item.type}`}>
            <span className="activity-feed__icon">{typeIcons[item.type]}</span>
            <div className="activity-feed__content">
              <span className="activity-feed__item-title">{item.title}</span>
              <span className="activity-feed__item-details">{item.details}</span>
            </div>
            <span className="activity-feed__time">{formatTime(item.timestamp)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
