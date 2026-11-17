import { useAvatarImage } from '../hooks/useAvatarImage'
import { getAvatarColor, getDisplayName, getInitials } from '../utils/avatar'
import PersonIcon from '../assets/icons/person.svg?react'
import './UserAvatar.css'

export interface AvatarPerson {
  accountId: string
  firstName?: string | null
  lastName?: string | null
  email: string
  avatarUrl?: string | null
}

interface UserAvatarProps {
  person: AvatarPerson
  /** Surface-specific class carrying size, and a ring where the avatars overlap. */
  className?: string
  /** Pixel size of the fallback person icon. */
  iconSize?: number
}

/**
 * One person, rendered as a circle: their uploaded photo, or their initials on
 * a colour drawn from their account, or a person icon when we hold no name. A
 * photo that fails to load falls back the same way as one we never had.
 *
 * The colour is seeded here rather than by the caller, so the same person is
 * always the same colour on every surface.
 */
export function UserAvatar({ person, className = '', iconSize = 16 }: UserAvatarProps) {
  const displayName = getDisplayName(person)
  const initials = getInitials(person.firstName, person.lastName)
  const photo = useAvatarImage(person.avatarUrl)

  if (photo.src) {
    return (
      <img
        src={photo.src}
        alt={displayName}
        className={`user-avatar user-avatar--image ${className}`.trim()}
        onError={photo.onError}
      />
    )
  }

  if (initials) {
    const colors = getAvatarColor(person.accountId)
    return (
      <div
        className={`user-avatar ${className}`.trim()}
        style={{ backgroundColor: colors.bg, color: colors.text }}
        role="img"
        aria-label={displayName}
      >
        {initials}
      </div>
    )
  }

  return (
    <div
      className={`user-avatar user-avatar--icon ${className}`.trim()}
      role="img"
      aria-label={displayName}
    >
      <PersonIcon width={iconSize} height={iconSize} />
    </div>
  )
}

export default UserAvatar
