import { useState, useRef, useEffect } from 'react'
import PlugIcon from '../assets/icons/plug.svg?react'
import EllipsisVerticalIcon from '../assets/icons/ellipsis-vertical.svg?react'

function getInitials(name: string): string {
  return name
    .split(' ')
    .map(word => word.charAt(0).toUpperCase())
    .join('')
}

export type ItemStatus = 'active' | 'paused' | 'draft'

interface RecentItemCardProps {
  id: string
  name: string
  status: ItemStatus
  timeLabel: string
  onUpdate: () => void
  onToggleStatus: () => void
  onArchive: () => void
  onMessage?: () => void
  /** This team has replied in a thread nobody has read. Same indicator, same
   *  meaning, as the one beside Message Team on the teams list. */
  hasUnread?: boolean
  toggleStatusLabel: string
  isUpdating?: boolean
  isExternal?: boolean
}

export function RecentItemCard({
  name,
  status,
  timeLabel,
  onUpdate,
  onMessage,
  hasUnread,
  onToggleStatus,
  onArchive,
  toggleStatusLabel,
  isUpdating,
  isExternal,
}: RecentItemCardProps) {
  const [isMenuOpen, setIsMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setIsMenuOpen(false)
      }
    }
    if (isMenuOpen) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isMenuOpen])

  return (
    <div className="recent-agent-card">
      <div className={`recent-agent-card__avatar recent-agent-card__avatar--${status}`}>
        {getInitials(name)}
      </div>
      <h3 className="recent-agent-card__name">
        {name}
        {isExternal && <span className="recent-agent-card__external-icon"><PlugIcon /></span>}
      </h3>
      <span className="recent-agent-card__time">{timeLabel}</span>
      <div className="recent-agent-card__menu-wrapper" ref={menuRef}>
        <button
          className="recent-agent-card__menu"
          onClick={() => setIsMenuOpen(!isMenuOpen)}
          disabled={isUpdating}
        >
          <EllipsisVerticalIcon width={16} height={16} />
        </button>
        {isMenuOpen && (
          <div className="recent-agent-card__dropdown">
            {!isExternal && onMessage && (
              <button onClick={() => { onMessage(); setIsMenuOpen(false); }}>
                <span className="recent-agent-card__dropdown-label">Message Team</span>
                {hasUnread && (
                  <>
                    <span className="recent-agent-card__unread-dot" aria-hidden="true" />
                    {/* Colour alone reaches neither a screen reader nor a
                      * colour-blind reader. */}
                    <span className="sr-only">Unread replies</span>
                  </>
                )}
              </button>
            )}
            <button onClick={() => { onUpdate(); setIsMenuOpen(false); }}>
              Update Team
            </button>
            <button onClick={() => { onToggleStatus(); setIsMenuOpen(false); }} disabled={isUpdating}>
              {isUpdating ? 'Updating...' : toggleStatusLabel}
            </button>
            <button onClick={() => { onArchive(); setIsMenuOpen(false); }}>
              Archive Team
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
