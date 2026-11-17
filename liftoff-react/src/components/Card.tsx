import { ReactNode } from 'react'
import './Card.css'

interface CardProps {
  icon?: ReactNode
  title: string
  description: string
  className?: string
  iconClassName?: string
  children?: ReactNode
}

export default function Card({
  icon,
  title,
  description,
  className = '',
  iconClassName = '',
  children,
}: CardProps) {
  return (
    <div className={`card ${className}`.trim()}>
      {icon && <div className={`card__icon ${iconClassName}`.trim()}>{icon}</div>}
      <div className="card__content">
        <h3 className="card__title">{title}</h3>
        <p className="card__description">{description}</p>
        {children}
      </div>
    </div>
  )
}
