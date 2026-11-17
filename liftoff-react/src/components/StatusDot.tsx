import './StatusDot.css'

type DotVariant = 'connected' | 'success' | 'warning' | 'error' | 'neutral' | 'info' | 'accent'

interface StatusDotProps {
  variant?: DotVariant
  color?: string
  size?: 'sm' | 'md' | 'lg'
  pulse?: boolean
}

export default function StatusDot({ variant, color, size = 'sm', pulse = false }: StatusDotProps) {
  return (
    <span
      className={`status-dot ${variant ? `status-dot--${variant}` : ''} status-dot--${size} ${pulse ? 'status-dot--pulse' : ''}`}
      style={color ? { background: color } : undefined}
      aria-hidden="true"
    />
  )
}
