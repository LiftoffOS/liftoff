import './StatusBadge.css'

type StatusVariant = 'active' | 'success' | 'paused' | 'neutral' | 'warning' | 'draft' | 'error' | 'external'

interface StatusBadgeProps {
  variant: StatusVariant
  children: React.ReactNode
  size?: 'sm' | 'md'
}

export default function StatusBadge({ variant, children, size = 'sm' }: StatusBadgeProps) {
  return (
    <span className={`status-badge status-badge--${variant} status-badge--${size}`}>
      {children}
    </span>
  )
}
