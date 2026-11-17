import { createPortal } from 'react-dom'
import { useEffect, useRef } from 'react'
import type { ReactNode, MouseEvent } from 'react'
import './ModalOverlay.css'

interface ModalOverlayProps {
  children: ReactNode
  onClose: () => void
  disableClose?: boolean
  ariaLabelledBy?: string
  /**
   * Extra class on the content box. The only intended use is opting into a
   * different width rule (see `--fit` in ModalOverlay.css); the default 400px
   * box is right for almost every modal.
   */
  contentClassName?: string
}

export default function ModalOverlay({ children, onClose, disableClose = false, ariaLabelledBy, contentClassName = '' }: ModalOverlayProps) {
  const contentRef = useRef<HTMLDivElement>(null)
  const previousActiveElement = useRef<HTMLElement | null>(null)

  // Store previously focused element and focus the modal
  useEffect(() => {
    previousActiveElement.current = document.activeElement as HTMLElement

    // Focus first focusable element in modal
    const focusableElements = contentRef.current?.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    )
    if (focusableElements && focusableElements.length > 0) {
      focusableElements[0].focus()
    } else {
      contentRef.current?.focus()
    }

    // Restore focus on unmount
    return () => {
      previousActiveElement.current?.focus()
    }
  }, [])

  // Escape to close, and Tab to stay inside. Both on the document, for the same
  // reason: a focus trap is a property of the dialog being OPEN, not of any
  // element being focused. As a JSX onKeyDown the trap also put a keyboard
  // listener on role="dialog", which is not an interactive element and should
  // not carry one.
  useEffect(() => {
    const handleKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape' && !disableClose) {
        onClose()
        return
      }
      if (e.key !== 'Tab') return

      const focusableElements = contentRef.current?.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      )
      if (!focusableElements || focusableElements.length === 0) return

      const firstElement = focusableElements[0]
      const lastElement = focusableElements[focusableElements.length - 1]

      if (e.shiftKey) {
        if (document.activeElement === firstElement) {
          e.preventDefault()
          lastElement.focus()
        }
      } else if (document.activeElement === lastElement) {
        e.preventDefault()
        firstElement.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose, disableClose])

  // Close only when the BACKDROP itself was clicked.
  //
  // This used to close on any click that reached here and the content box
  // stopped propagation to prevent it. Comparing target to currentTarget says
  // the same thing directly, and it lets the content box drop a click handler
  // it only ever had to cancel something.
  const handleOverlayClick = (e: MouseEvent) => {
    if (e.target !== e.currentTarget) return
    if (!disableClose) onClose()
  }

  return createPortal(
    // role="presentation" because that is what the backdrop IS. It is not a
    // control and must not be reachable or announced as one: the keyboard way
    // out of this dialog is Escape, which the effect above handles, and giving
    // a backdrop a tabstop puts a nameless button in front of every keyboard
    // user before they reach the dialog.
    <div className="modal-overlay" role="presentation" onClick={handleOverlayClick}>
      <div
        ref={contentRef}
        className={`modal-overlay__content ${contentClassName}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={ariaLabelledBy}
        tabIndex={-1}
      >
        {children}
      </div>
    </div>,
    document.body
  )
}
