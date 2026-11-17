import './EmptyState.css'

interface EmptyStateProps {
  icon?: React.ReactNode
  title: string
  description?: string
  action?: React.ReactNode
  className?: string
}

export default function EmptyState({ icon, title, description, action, className = '' }: EmptyStateProps) {
  return (
    <div className={`empty-state ${className}`.trim()}>
      {icon && <div className="empty-state__icon">{icon}</div>}
      <p className="empty-state__title">{title}</p>
      {description && <span className="empty-state__description">{description}</span>}
      {action && <div className="empty-state__action">{action}</div>}
    </div>
  )
}
