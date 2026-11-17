import { useCallback, useEffect, useRef, useState } from 'react'
import XIcon from '../../assets/icons/x.svg?react'
import Button from '../Button'
import { useEnableBrowserNotifications } from '../../hooks/useBrowserNotifications'
import {
  getPushPermissionState,
  type PushPermissionState,
} from '../../lib/pushNotifications'
import { dismissPrompt, isPromptDismissed } from '../../lib/notificationPrompt'
import { track } from '../../lib/analytics'

// The offer to turn browser notifications on, in the conversation it is about.
//
// Borrows HitlPendingIndicator's glass shell rather than the dashboard's black
// pill: this column has its own language for "something needs you", and chrome
// from another page reads as a bug here. Same sticky slot, so the two cannot
// both be shown — AgentChatPage suppresses this one while an approval is
// pending, because a stopped run outranks an offer.
//
// Shown whenever this browser has not granted permission, including to somebody
// who has never opted in: browser notifications cannot be turned on from the
// server, so an offer that waits for the preference can never be the thing that
// gets them enabled.

interface NotificationPromptBarProps {
  /** Who replies on this surface, so the offer names what it is offering.
   *
   *  Optional because not every chat surface has one to name. Agent chat has
   *  the team, and Liftoff and Insights answer as themselves. The team plan
   *  does not: its heading is "Plan", which is the artifact rather than the
   *  thing that replies, and "Get notified when Plan replies" claims a speaker
   *  that does not exist. Those fall back to naming nothing. */
  replierName?: string
  /** Opens the article explaining how to unblock in browser settings. */
  onOpenHelp: () => void
}

export function NotificationPromptBar({ replierName, onOpenHelp }: NotificationPromptBarProps) {
  const enableNotifications = useEnableBrowserNotifications()
  const [permission, setPermission] = useState<PushPermissionState>(() =>
    getPushPermissionState(),
  )
  const [dismissed, setDismissed] = useState(() => isPromptDismissed('chat'))
  // A ref, not state: this only guards a fire-once analytics call, and setting
  // state in the effect below would trigger a cascading render for nothing.
  // Same guard PaymentBlockedBanner uses.
  const shownRef = useRef(false)

  // Re-read BOTH on focus, not just permission.
  //
  // Each was read once at mount, which left this unable to notice its own
  // preconditions changing. Permission is owned by the browser and can be reset
  // from browser settings; the dismissal lives in sessionStorage and can be
  // cleared. Either one happening stranded the component in the decision it
  // made on first render: nothing shown, every underlying condition saying it
  // should show, and no way back except a full reload.
  useEffect(() => {
    const refresh = () => {
      setPermission(getPushPermissionState())
      setDismissed(isPromptDismissed('chat'))
    }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [])

  const visible = !dismissed && (permission === 'default' || permission === 'denied')

  useEffect(() => {
    if (!visible || shownRef.current) return
    shownRef.current = true
    track('chat_notification_prompt_shown', { permission })
  }, [visible, permission])

  const handleEnable = useCallback(async () => {
    track('chat_notification_prompt_enable_clicked', {})
    // Permission AND the delivery preference: the backend gates push on the
    // second, so granting alone would leave this looking on and sending nothing.
    setPermission(await enableNotifications())
  }, [enableNotifications])

  const handleDismiss = useCallback(() => {
    track('chat_notification_prompt_dismissed', { permission })
    dismissPrompt('chat')
    setDismissed(true)
  }, [permission])

  if (!visible) return null

  const blocked = permission === 'denied'

  return (
    <div className="chat-page__notification-prompt" role="status">
      {/* No status dot. It was inherited from HitlPendingIndicator, where an
          amber dot means a run has stopped and is worth flagging at a glance.
          Here it marked nothing: the sentence already says whether this is an
          offer or a block, and a dot that encodes no state is decoration
          standing in for information. */}
      <span className="chat-page__notification-prompt__label">
        <span className="chat-page__notification-prompt__text">
          {blocked
            ? 'Your browser is blocking notifications from Liftoff.'
            : replierName
              ? `Get notified when ${replierName} replies`
              : 'Get notified when a reply arrives'}
        </span>
      </span>
      <span className="chat-page__notification-prompt__actions">
        {/* Outline in both states. The slot is the same one action either way,
            so switching to the accent for `blocked` gave one bar two button
            treatments for structurally the same thing. It also overstated it:
            the accent means "this is the thing to do", and How To Fix opens
            instructions for a fix that happens outside the page entirely. */}
        <Button
          variant="outline"
          size="sm"
          onClick={blocked ? onOpenHelp : () => void handleEnable()}
        >
          {blocked ? 'How To Fix' : 'Enable'}
        </Button>
        <button
          type="button"
          className="chat-page__notification-prompt__close"
          onClick={handleDismiss}
          aria-label="Dismiss"
        >
          <XIcon width={16} height={16} />
        </button>
      </span>
    </div>
  )
}

export default NotificationPromptBar
