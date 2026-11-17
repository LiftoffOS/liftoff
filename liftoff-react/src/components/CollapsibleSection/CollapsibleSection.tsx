import { ReactNode } from 'react'
import ChevronDownIcon from '../../assets/icons/chevron-down.svg?react'
import './CollapsibleSection.css'

interface CollapsibleSectionProps {
  title: string
  isOpen: boolean
  onToggle: () => void
  disabled?: boolean
  /** Show circular checkbox indicator (for first-time setup flows) */
  showCheck?: boolean
  /** Whether this section is completed (fills the checkbox) */
  isComplete?: boolean
  /** Summary text shown when collapsed */
  summary?: string
  children: ReactNode
}

export default function CollapsibleSection({
  title,
  isOpen,
  onToggle,
  disabled = false,
  showCheck = false,
  isComplete = false,
  summary,
  children,
}: CollapsibleSectionProps) {
  return (
    <div className={`collapsible-section ${disabled ? 'collapsible-section--disabled' : ''}`}>
      <button
        type="button"
        className="collapsible-section__header"
        onClick={onToggle}
        disabled={disabled}
      >
        <div className="collapsible-section__header-left">
          {showCheck && (
            <span className={`collapsible-section__check ${isComplete ? 'collapsible-section__check--done' : ''}`}>
              {isComplete && <span className="collapsible-section__check-icon" />}
            </span>
          )}
          <div className="collapsible-section__title-group">
            <h2 className="collapsible-section__title">{title}</h2>
            {!isOpen && summary && (
              <span className="collapsible-section__summary">{summary}</span>
            )}
          </div>
        </div>
        <ChevronDownIcon className={`collapsible-section__chevron ${isOpen ? 'collapsible-section__chevron--open' : ''}`} />
      </button>
      {isOpen && (
        <div className="collapsible-section__content">
          {children}
        </div>
      )}
    </div>
  )
}
