import { useState, ReactNode } from 'react'
import ChevronDownIcon from '../../assets/icons/chevron-down.svg?react'
import './Collapsible.css'

interface CollapsibleProps {
  title: string
  children: ReactNode
  defaultOpen?: boolean
  count?: number
  className?: string
}

export default function Collapsible({
  title,
  children,
  defaultOpen = false,
  count,
  className = ''
}: CollapsibleProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen)

  return (
    <div className={`collapsible ${isOpen ? 'collapsible--open' : ''} ${className}`}>
      <button
        className="collapsible__header"
        onClick={() => setIsOpen(!isOpen)}
        aria-expanded={isOpen}
      >
        <span className="collapsible__title">
          {title}
          {count !== undefined && (
            <span className="collapsible__count">{count}</span>
          )}
        </span>
        <ChevronDownIcon className="collapsible__icon" width={16} height={16} />
      </button>
      <div className="collapsible__content">
        <div className="collapsible__inner">
          {children}
        </div>
      </div>
    </div>
  )
}
