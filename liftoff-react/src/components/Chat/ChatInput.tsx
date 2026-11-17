import { useState, useRef, useEffect } from 'react'
import ArrowUpIcon from '../../assets/icons/arrow-up.svg?react'
import AgentMentionPopover, { type AgentMentionPopoverRef } from './AgentMentionPopover'
import {
  findMentionTokens,
  findOpenMentionSpan,
  makeMentionToken,
  mentionTokenAfterCaret,
  mentionTokenBeforeCaret,
} from '../../utils/agentMention'
import type { AgentMentionItem } from '../AgentMentionList'
import type { DisplayAttachment } from '../../services/internalAgents'
import MediaThumbnail from './MediaThumbnail'
import './ChatInput.css'
import '../AgentMentionList.css'

interface ChatInputProps {
  value: string
  onChange: (value: string) => void
  onSend: () => void
  disabled: boolean
  placeholder: string
  // Optional slot for action buttons rendered immediately left of the send button.
  // Used by AgentChatPage to inject the live-view toggle when the agent is bound
  // to a session-capable browser connector (Anchor Browser or Browser Use); left
  // unset on TeamPlanPage (CAIO chat) so no browser affordance appears there.
  leftActions?: React.ReactNode
  // When set, a Stop button replaces the send button. Pages pass it only while
  // a turn is streaming, so the person can end the run instead of waiting it
  // out.
  onStop?: () => void
  // Whether this chat can take a message while a turn is still running. Where
  // it can, typing during the stream swaps Stop back for Send so the message
  // can be delivered into the running turn; where it cannot, Stop stays for the
  // whole run because sending would start a second, competing turn.
  canSendDuringRun?: boolean
  // Optional mention items for @mention router — only set on HomePage. Setting
  // it is what turns on both the picker and the mention highlighting; every
  // other chat surface renders a bare textarea exactly as before.
  mentionItems?: AgentMentionItem[]
  attachments?: DisplayAttachment[]
  onRemoveAttachment?: (id: string) => void
  /**
   * Files that arrived by PASTE or by DROP, rather than through the picker.
   *
   * Both are new. Pasting a screenshot is how most people attach one and this
   * composer had no paste handler at all, so Cmd-V put nothing anywhere and
   * gave no reason. Dropping a file did the browser's default, which is to
   * navigate the whole tab to it — losing the message being typed.
   *
   * Left unset on a surface that does not take files, which keeps the textarea
   * exactly as it was.
   */
  onFilesAdded?: (files: File[]) => void
}

/** Paint the value with its mention tokens marked up. Rendered into a mirror
 *  behind a transparent textarea, so the delimiters (which are zero-width)
 *  wrap identically in both layers and the text lines up without any
 *  per-character measurement. */
function renderHighlightedValue(text: string): React.ReactNode {
  const tokens = findMentionTokens(text)
  if (!tokens.length) return text

  const parts: React.ReactNode[] = []
  let cursor = 0

  tokens.forEach((token, index) => {
    if (token.start > cursor) parts.push(text.slice(cursor, token.start))
    parts.push(
      <span key={index} className="chat-input__mention">
        {text.slice(token.start, token.end)}
      </span>,
    )
    cursor = token.end
  })

  if (cursor < text.length) parts.push(text.slice(cursor))
  return parts
}

export default function ChatInput({
  value,
  onChange,
  onSend,
  disabled,
  placeholder,
  leftActions,
  onStop,
  canSendDuringRun = false,
  mentionItems,
  attachments = [],
  onRemoveAttachment,
  onFilesAdded,
}: ChatInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const highlightsRef = useRef<HTMLDivElement>(null)
  const popoverRef = useRef<AgentMentionPopoverRef>(null)
  const [isMultiline, setIsMultiline] = useState(false)
  const [isDragOver, setIsDragOver] = useState(false)

  const withMentions = !!mentionItems

  useEffect(() => {
    if (textareaRef.current) {
      const textarea = textareaRef.current
      textarea.style.height = 'auto'
      const newHeight = Math.min(textarea.scrollHeight, 140)
      textarea.style.height = newHeight + 'px'
      setIsMultiline(textarea.scrollHeight > 24)
    }
  }, [value])

  /** Move the caret after a programmatic edit. The value round-trips through
   *  the parent, so the DOM only holds the new text on the next frame. */
  const setCaret = (index: number) => {
    requestAnimationFrame(() => {
      const textarea = textareaRef.current
      if (!textarea) return
      textarea.setSelectionRange(index, index)
      textarea.focus()
    })
  }

  const handleChange = (newValue: string) => {
    onChange(newValue)

    const textarea = textareaRef.current
    if (!withMentions || !textarea) return

    const span = findOpenMentionSpan(newValue, textarea.selectionStart)
    if (span) {
      popoverRef.current?.open(textarea, span.atIndex, span.query)
    } else {
      popoverRef.current?.close()
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const textarea = e.currentTarget

    // A mention is one unit: Backspace or Delete at its edge removes the whole
    // token in a single keystroke. Chipping away at it character by character
    // is what used to strand the caret inside a half-deleted label.
    if (withMentions && (e.key === 'Backspace' || e.key === 'Delete')) {
      const caret = textarea.selectionStart
      const hasSelection = caret !== textarea.selectionEnd
      const token = hasSelection
        ? null
        : e.key === 'Backspace'
          ? mentionTokenBeforeCaret(value, caret)
          : mentionTokenAfterCaret(value, caret)

      if (token) {
        e.preventDefault()
        onChange(value.slice(0, token.start) + value.slice(token.end))
        popoverRef.current?.close()
        setCaret(token.start)
        return
      }
    }

    if (popoverRef.current?.isOpen?.()) {
      if (e.key === 'Escape') {
        popoverRef.current.close()
        e.preventDefault()
        return
      }
      // Arrows and Enter belong to the picker while it is open; everything
      // else, editing keys included, falls through to the textarea untouched.
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Enter') {
        e.preventDefault()
        return
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      onSend()
    }
  }

  const handleMentionSelect = (item: AgentMentionItem) => {
    const textarea = textareaRef.current
    if (!textarea) return

    const caret = textarea.selectionStart
    const span = findOpenMentionSpan(value, caret)
    if (!span) return

    const token = makeMentionToken(item.label)
    const before = value.slice(0, span.atIndex)
    const after = value.slice(caret)

    onChange(`${before}${token} ${after}`)
    popoverRef.current?.close()
    setCaret(before.length + token.length + 1)
  }

  const handleBlur = () => {
    popoverRef.current?.close()
  }

  /**
   * A pasted screenshot.
   *
   * `clipboardData.files` is what a screenshot arrives as, and it is empty for
   * an ordinary text paste — so the default is only prevented when there is
   * actually a file, and copying text between messages behaves exactly as it
   * always has.
   */
  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (!onFilesAdded) return
    const files = Array.from(e.clipboardData?.files ?? [])
    if (files.length === 0) return
    e.preventDefault()
    onFilesAdded(files)
  }

  // Drag-and-drop. The default action for a dropped file is to NAVIGATE the tab
  // to it, which throws away whatever was being typed — so both dragover and
  // drop are always prevented once this composer accepts files, whether or not
  // the drop turns out to carry something usable.
  const handleDragOver = (e: React.DragEvent) => {
    if (!onFilesAdded) return
    e.preventDefault()
    setIsDragOver(true)
  }

  const handleDragLeave = (e: React.DragEvent) => {
    if (!onFilesAdded) return
    // Only when the pointer actually leaves the composer, not when it crosses
    // between the children inside it — otherwise the highlight flickers.
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
    setIsDragOver(false)
  }

  const handleDrop = (e: React.DragEvent) => {
    if (!onFilesAdded) return
    e.preventDefault()
    setIsDragOver(false)
    const files = Array.from(e.dataTransfer?.files ?? [])
    if (files.length > 0) onFilesAdded(files)
  }

  // Keep the mirror aligned with the textarea once the text outgrows the box.
  const handleScroll = () => {
    if (highlightsRef.current && textareaRef.current) {
      highlightsRef.current.scrollTop = textareaRef.current.scrollTop
    }
  }

  // While a turn is running, the button is Stop until there is something to
  // say. The moment the person types on a chat that accepts mid-run messages,
  // it becomes Send again: what they want is to steer the run, not end it.
  const showStop = !!onStop && !(canSendDuringRun && value.trim().length > 0)

  const textareaEl = (
    <textarea
      ref={textareaRef}
      value={value}
      onChange={e => handleChange(e.target.value)}
      onKeyDown={handleKeyDown}
      onBlur={handleBlur}
      onPaste={onFilesAdded ? handlePaste : undefined}
      onScroll={withMentions ? handleScroll : undefined}
      placeholder={placeholder}
      rows={1}
      disabled={disabled}
      className={`chat-input__textarea${withMentions ? ' chat-input__textarea--highlighted' : ''}`}
      autoComplete="off"
      spellCheck={false}
      data-1p-ignore="true"
      data-lpignore="true"
      data-bwignore="true"
      data-form-type="other"
      data-gramm="false"
      data-gramm_editor="false"
      data-enable-grammarly="false"
    />
  )

  return (
    <>
      <AgentMentionPopover
        ref={popoverRef}
        items={mentionItems || []}
        onSelect={handleMentionSelect}
      />
      <div className="chat-input__blur" />
      <div className="chat-input__container">
        <div
          className={`chat-input__glass ${isMultiline || attachments.length > 0 ? 'chat-input__glass--multiline' : ''}${isDragOver ? ' chat-input__glass--dragover' : ''}`}
          onDragOver={onFilesAdded ? handleDragOver : undefined}
          onDragLeave={onFilesAdded ? handleDragLeave : undefined}
          onDrop={onFilesAdded ? handleDrop : undefined}
        >
          <div
            className={`chat-input__form ${isMultiline || attachments.length > 0 ? 'chat-input__form--multiline' : ''}`}
          >
            {withMentions ? (
              <div className="chat-input__editor">
                <div ref={highlightsRef} className="chat-input__highlights" aria-hidden="true">
                  {renderHighlightedValue(value)}
                </div>
                {textareaEl}
              </div>
            ) : (
              textareaEl
            )}
            {leftActions}
            {showStop ? (
              <button
                type="button"
                onClick={onStop}
                className="chat-input__send"
                aria-label="Stop the current run"
                title="Stop"
              >
                <span className="chat-input__stop-glyph" />
              </button>
            ) : (
              <button
                type="button"
                onClick={onSend}
                disabled={!value.trim() || disabled}
                className="chat-input__send"
                aria-label="Send message"
              >
                <ArrowUpIcon width="18" height="18" />
              </button>
            )}
            {attachments.length > 0 && (
              <div className="chat-input__attachments">
                {attachments.map((attachment) => (
                  <div
                    key={attachment.id}
                    className={`chat-input__attachment-pill${attachment.kind === 'media' ? ' chat-input__attachment-pill--media' : ''}`}
                  >
                    {/* A picture shows as a picture, even before it is sent.
                        A pill carrying only a filename is exactly the downgrade
                        this feature exists to remove — the person should see
                        what they are about to send. */}
                    {attachment.kind === 'media'
                      && attachment.media.mimeType.startsWith('image/') && (
                      <MediaThumbnail media={attachment.media} />
                    )}
                    <span className="chat-input__attachment-name">{attachment.name}</span>
                    <button
                      type="button"
                      className="chat-input__attachment-remove"
                      onClick={() => onRemoveAttachment?.(attachment.id)}
                      aria-label={`Remove ${attachment.name}`}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
