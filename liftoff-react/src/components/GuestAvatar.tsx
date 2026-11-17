import Tooltip from './Tooltip'
import { getAvatarColor, getInitialsFromName } from '../utils/avatar'
import PersonIcon from '../assets/icons/person.svg?react'
import './UserAvatar.css'

interface GuestAvatarProps {
  /** Display name from the sending channel — a Slack or Teams name. */
  label: string
  /** Surface-specific class carrying the size. */
  className?: string
  iconSize?: number
}

/**
 * Someone who sent a message through Slack or Teams without a Liftoff account.
 *
 * We hold their channel display name and nothing else: no email, no photo, and
 * no account id to key a colour off, so the colour is seeded from the name
 * instead. It renders exactly like a member avatar on purpose — inside a
 * shared thread the useful question is "who said this", and marking guests as
 * second-class answers a question nobody asked.
 */
export function GuestAvatar({ label, className = '', iconSize = 12 }: GuestAvatarProps) {
  const initials = getInitialsFromName(label)
  const colors = getAvatarColor(label)

  if (!initials) {
    return (
      <Tooltip text={label} position="top">
        <div
          className={`user-avatar user-avatar--icon ${className}`.trim()}
          role="img"
          aria-label={label}
        >
          <PersonIcon width={iconSize} height={iconSize} />
        </div>
      </Tooltip>
    )
  }

  return (
    <Tooltip text={label} position="top">
      <div
        className={`user-avatar ${className}`.trim()}
        style={{ backgroundColor: colors.bg, color: colors.text }}
        role="img"
        aria-label={label}
      >
        {initials}
      </div>
    </Tooltip>
  )
}

export default GuestAvatar
