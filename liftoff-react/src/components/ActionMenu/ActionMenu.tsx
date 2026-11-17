import { useState, useRef, useEffect } from 'react'
import EllipsisVerticalIcon from '../../assets/icons/ellipsis-vertical.svg?react'
import Tooltip from '../Tooltip'
import './ActionMenu.css'

export interface ActionMenuItem {
  label: string
  onClick: () => void
  disabled?: boolean
  variant?: 'default' | 'danger'
  /** Draws a dot to the right of the label, with "Unread replies" carried in
   *  the item's accessible name. Optional, so every existing call site is
   *  unaffected. */
  badge?: boolean
}

interface ActionMenuProps {
  items: ActionMenuItem[]
  disabled?: boolean
  /** Overrides the trigger's accessible name. Worth setting when several of
   *  these sit in one row, so each one names what it acts on. */
  ariaLabel?: string
}

export default function ActionMenu({ items, disabled, ariaLabel = 'More options' }: ActionMenuProps) {
  const [isOpen, setIsOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isOpen])

  return (
    <div className="action-menu" ref={menuRef}>
      {/* An icon-only trigger says nothing on its own. The hint sits above the
        * button, the same place and treatment as the one on the icon button
        * beside it in a teams row, and clear of the dropdown below. */}
      <Tooltip text="More Options" position="top">
        <button
          type="button"
          className="action-menu__trigger"
          onClick={() => setIsOpen(!isOpen)}
          disabled={disabled}
          aria-label={ariaLabel}
        >
          <EllipsisVerticalIcon />
        </button>
      </Tooltip>
      {isOpen && (
        <div className="action-menu__dropdown">
          {items.map((item, index) => (
            <button
              key={index}
              type="button"
              className={`action-menu__item ${item.variant === 'danger' ? 'action-menu__item--danger' : ''}`}
              onClick={() => {
                item.onClick()
                setIsOpen(false)
              }}
              disabled={item.disabled}
            >
              <span className="action-menu__item-label">{item.label}</span>
              {item.badge && (
                <>
                  <span className="action-menu__item-dot" aria-hidden="true" />
                  {/* The dot is the whole signal otherwise, and colour alone
                    * reaches neither a screen reader nor a colour-blind
                    * reader. */}
                  <span className="sr-only">Unread replies</span>
                </>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
