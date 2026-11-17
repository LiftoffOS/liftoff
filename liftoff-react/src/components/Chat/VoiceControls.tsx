// The two voice controls, defined once for every chat surface.
//
// They were duplicated per page, which is how the header toggle came to exist on
// the team chat and nowhere else: the styles were already shared in ChatPage.css,
// but each page hand-rolled its own markup, so adding a control to one left the
// others behind. Any surface that renders a chat renders these.
//
// Presentational only. What the controls DO lives in useVoiceChat, so that the
// behaviour is shared for the same reason the appearance is.

import { useEffect, useRef } from 'react'
import Tooltip from '../Tooltip'
import AudioLinesIcon from '../../assets/icons/audio-lines.svg?react'
import MicIcon from '../../assets/icons/mic.svg?react'

/**
 * How fast the ring follows the voice.
 *
 * The reading is honest and therefore jumpy: speech is loud on vowels and
 * nearly silent between words, so a ring that tracked it exactly would flicker
 * rather than breathe.
 */
const LEVEL_SMOOTHING = 0.25

export interface VoiceModeToggleProps {
  enabled: boolean
  onToggle: () => void
}

/**
 * Whether replies are spoken. Belongs in the header, beside the title, because
 * it describes the whole conversation rather than the message being composed.
 */
export function VoiceModeToggle({ enabled, onToggle }: VoiceModeToggleProps) {
  return (
    <Tooltip text="Voice Mode">
      <button
        type="button"
        className={`chat-page__icon-btn chat-page__voice-toggle${
          enabled ? ' chat-page__voice-toggle--active' : ''
        }`}
        aria-label={enabled ? 'Disable Voice Mode' : 'Enable Voice Mode'}
        aria-pressed={enabled}
        onClick={onToggle}
      >
        <AudioLinesIcon width="20" height="20" />
      </button>
    </Tooltip>
  )
}

export interface VoiceInputButtonProps {
  isListening: boolean
  onToggle: () => void
  /**
   * How loud the person is, 0 to 1, sampled per frame.
   *
   * A ref rather than a prop value: this changes about fifty times a second,
   * and rendering the chat that often to move a ring by two pixels would cost
   * more than the whole feature is worth.
   */
  levelRef?: React.RefObject<number>
}

/**
 * The microphone. Belongs in the composer, because it is an input to the message
 * being written.
 */
export function VoiceInputButton({ isListening, onToggle, levelRef }: VoiceInputButtonProps) {
  const buttonRef = useRef<HTMLButtonElement>(null)

  // The ring around the microphone is the level, written straight onto the node
  // as a custom property. It says "hearing you" rather than merely "armed",
  // which is the question people are actually asking when they look at it.
  useEffect(() => {
    const node = buttonRef.current
    if (!isListening || !levelRef || !node) return
    let frame = 0
    let shown = 0
    const paint = () => {
      shown += (levelRef.current - shown) * LEVEL_SMOOTHING
      node.style.setProperty('--voice-level', shown.toFixed(3))
      frame = requestAnimationFrame(paint)
    }
    frame = requestAnimationFrame(paint)
    return () => {
      cancelAnimationFrame(frame)
      node.style.removeProperty('--voice-level')
    }
  }, [isListening, levelRef])

  return (
    <Tooltip text={isListening ? 'Listening' : 'Dictate'} position="top">
      <button
        ref={buttonRef}
        type="button"
        onClick={onToggle}
        className={`chat-input__left-action${
          isListening ? ' chat-input__left-action--listening' : ''
        }`}
        aria-label={isListening ? 'Stop voice input' : 'Start voice input'}
        aria-pressed={isListening}
      >
        {isListening ? (
          <AudioLinesIcon width="16" height="16" />
        ) : (
          <MicIcon width="16" height="16" />
        )}
      </button>
    </Tooltip>
  )
}
