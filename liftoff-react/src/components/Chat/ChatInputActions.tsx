import { Tooltip } from '..'
import MonitorIcon from '../../assets/icons/monitor.svg?react'

/** The controls on the left of the chat input, and the ORDER they appear in.
 *
 *  The components were always shared. The composition was not: `ChatInput` takes
 *  `leftActions` as an opaque ReactNode, so all five chat pages wrote out their
 *  own fragment and the order lived in five places with nothing comparing them.
 *  Nothing could catch a divergence — no type, no test, no lint rule — because
 *  "attachment, then browser, then voice" was not written down anywhere a
 *  machine could read. It was matched by eye, and eventually it was matched
 *  wrong: the three platform assistants shipped with the browser button on the
 *  far left while agent chat had it second.
 *
 *  So the order is stated once, here. A page no longer says what comes first; it
 *  says which slot each control goes in, and cannot express a different order.
 *  A page that has no browser passes nothing and the slot collapses. */
export function ChatInputActions({ attach, browser, voice }: {
  attach?: React.ReactNode
  browser?: React.ReactNode
  voice?: React.ReactNode
}) {
  return (
    <>
      {attach}
      {browser}
      {voice}
    </>
  )
}

/** The browser-pane toggle.
 *
 *  Four pages had drawn this button themselves, which meant four copies of its
 *  class, its icon size and — the part that actually matters — its aria-label
 *  and aria-pressed. A screen reader is the one consumer that cannot see the
 *  button is the same button, so those two attributes drifting is the failure
 *  worth designing out.
 *
 *  Renders nothing when unavailable, so a caller can pass it unconditionally. */
export function BrowserPaneToggleButton({ available, open, onToggle, disabled }: {
  available: boolean
  open: boolean
  onToggle: () => void
  /** Every chat surface shares the right-pane slot with its More pane and
   *  disables this toggle while that one holds it. */
  disabled?: boolean
}) {
  if (!available) return null
  return (
    <Tooltip text="Browser" position="top">
      <button
        type="button"
        onClick={onToggle}
        className="chat-input__left-action"
        aria-label={open ? 'Hide browser pane' : 'Show browser pane'}
        aria-pressed={open}
        disabled={disabled ?? false}
      >
        <MonitorIcon width="16" height="16" />
      </button>
    </Tooltip>
  )
}
