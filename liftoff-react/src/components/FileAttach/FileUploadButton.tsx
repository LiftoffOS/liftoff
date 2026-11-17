import { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import Tooltip from '../Tooltip'
import FileUploadPopover from './FileUploadPopover'
import PlusIcon from '../../assets/icons/plus.svg?react'
import type { PendingAttachment } from './FileUploadPopover'
import type { MediaContext } from './FileUploadPopover'

interface FileUploadButtonProps {
  onAttach?: (attachments: PendingAttachment[]) => void
  tooltip?: string
  /** Where this composer is. Passing it is what turns media on — see the note
   *  on FileUploadPopoverProps.mediaContext. */
  mediaContext?: MediaContext
  /** Media already on the message, so the per-message cap counts the message. */
  existingMediaCount?: number
  /** Files that could not be attached, and why. */
  onErrors?: (errors: string[]) => void
}

const OFFSET = 8

export default function FileUploadButton({
  onAttach,
  tooltip = 'Upload Attachment',
  mediaContext,
  existingMediaCount,
  onErrors,
}: FileUploadButtonProps) {
  const [isPopoverOpen, setIsPopoverOpen] = useState(false)
  const [popoverStyle, setPopoverStyle] = useState<React.CSSProperties>({})
  const buttonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!isPopoverOpen || !buttonRef.current) return

    const updatePosition = () => {
      if (!buttonRef.current) return
      const buttonRect = buttonRef.current.getBoundingClientRect()
      const viewportHeight = window.innerHeight

      let top: number | undefined

      // Vertical: expand away from nearest edge (use button center)
      const buttonCenterY = (buttonRect.top + buttonRect.bottom) / 2
      if (buttonCenterY > viewportHeight / 2) {
        // Button in bottom half → popover opens upward (position from top)
        top = buttonRect.top - 230 - OFFSET
      } else {
        // Button in top half → popover opens downward
        top = buttonRect.bottom + OFFSET
      }

      // Horizontal: align right edge with button right edge
      const right = window.innerWidth - buttonRect.right

      setPopoverStyle({
        position: 'fixed',
        top,
        right,
        zIndex: 1000,
      })
    }

    updatePosition()
    window.addEventListener('scroll', updatePosition)
    window.addEventListener('resize', updatePosition)

    return () => {
      window.removeEventListener('scroll', updatePosition)
      window.removeEventListener('resize', updatePosition)
    }
  }, [isPopoverOpen])

  const handleAttach = (attachments: PendingAttachment[]) => {
    onAttach?.(attachments)
    setIsPopoverOpen(false)
  }

  return (
    <>
      <Tooltip text={tooltip} position="top">
        <button
          ref={buttonRef}
          type="button"
          onClick={() => setIsPopoverOpen(true)}
          className="chat-input__left-action"
          aria-label="Open file upload"
        >
          <PlusIcon width="16" height="16" />
        </button>
      </Tooltip>
      {isPopoverOpen &&
        createPortal(
          <div style={popoverStyle}>
            <FileUploadPopover
              isOpen={isPopoverOpen}
              onClose={() => setIsPopoverOpen(false)}
              onAttach={handleAttach}
              {...(mediaContext ? { mediaContext } : {})}
              {...(existingMediaCount !== undefined ? { existingMediaCount } : {})}
              {...(onErrors ? { onErrors } : {})}
            />
          </div>,
          document.body,
        )}
    </>
  )
}
