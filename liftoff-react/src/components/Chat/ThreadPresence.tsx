import Tooltip from '../Tooltip'
import { UserAvatar } from '../UserAvatar'
import { getDisplayName } from '../../utils/avatar'
import type { ThreadPresenceEntry } from '../../services/presence'
import './ThreadPresence.css'

const MAX_FACES = 4

interface ThreadPresenceProps {
  viewers: ThreadPresenceEntry[]
  /** Excluded from the row: you already know you are here. */
  viewerAccountId: string
}

/**
 * Overlapping avatars for everyone else currently on this thread. Renders
 * nothing when you are alone, which is the common case, so a single-person
 * thread looks exactly as it did before.
 */
export function ThreadPresence({ viewers, viewerAccountId }: ThreadPresenceProps) {
  const others = viewers.filter(v => v.accountId !== viewerAccountId)
  if (others.length === 0) return null

  const shown = others.slice(0, MAX_FACES)
  const overflow = others.length - shown.length

  return (
    <div className="thread-presence" aria-label={`${others.length} other people on this thread`}>
      {shown.map(person => (
        <Tooltip key={person.accountId} text={getDisplayName(person)} position="bottom">
          <UserAvatar person={person} className="thread-presence__avatar" iconSize={14} />
        </Tooltip>
      ))}
      {overflow > 0 && (
        <Tooltip text={`${overflow} more`} position="bottom">
          <div className="thread-presence__avatar thread-presence__avatar--more">
            +{overflow}
          </div>
        </Tooltip>
      )}
    </div>
  )
}

interface TypingIndicatorProps {
  viewers: ThreadPresenceEntry[]
  viewerAccountId: string
}

/**
 * A message being composed, drawn the way a real one is: the bubble on top,
 * the avatar in the meta row beneath it where a sent message puts its
 * timestamp and avatar. No prose — the avatar already says who, and hovering
 * it gives the name. Several people typing means several avatars.
 *
 * Lives inside the conversation element, which is remounted per thread, so it
 * clears itself on a switch.
 */
export function TypingIndicator({ viewers, viewerAccountId }: TypingIndicatorProps) {
  const typists = viewers.filter(v => v.typing && v.accountId !== viewerAccountId)
  if (typists.length === 0) return null

  return (
    <div className="chat-message chat-message--user thread-typing" aria-live="polite">
      <div className="chat-message__bubble chat-message__bubble--user thread-typing__bubble">
        {/* Same three dots the agent shows while it works. */}
        <div className="chat-message__typing">
          <span className="chat-message__dot" />
          <span className="chat-message__dot" />
          <span className="chat-message__dot" />
        </div>
      </div>
      <div className="chat-message__meta">
        {typists.map(person => (
          <Tooltip key={person.accountId} text={getDisplayName(person)} position="top">
            <UserAvatar
              person={person}
              className="chat-message__sender-avatar"
              iconSize={12}
            />
          </Tooltip>
        ))}
      </div>
    </div>
  )
}
