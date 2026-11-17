import { useEffect, useRef, useState, useImperativeHandle, forwardRef } from 'react'
import { createPortal } from 'react-dom'
import AgentMentionList, { type AgentMentionListRef, type AgentMentionItem } from '../AgentMentionList'
import { getCaretRect } from '../../utils/caretRect'

export interface AgentMentionPopoverRef {
  open: (textarea: HTMLTextAreaElement, caretIndex: number, query: string) => void
  close: () => void
  isOpen: () => boolean
}

interface AgentMentionPopoverProps {
  items: AgentMentionItem[]
  onSelect: (item: AgentMentionItem) => void
}

const AgentMentionPopover = forwardRef<AgentMentionPopoverRef, AgentMentionPopoverProps>(
  ({ items, onSelect }, ref) => {
    const [isOpen, setIsOpen] = useState(false)
    const [position, setPosition] = useState<{ top: number; left: number } | null>(null)
    const [query, setQuery] = useState('')
    const textareaRef = useRef<HTMLTextAreaElement | null>(null)
    const caretIndexRef = useRef<number>(0)
    const listRef = useRef<AgentMentionListRef>(null)

    const filteredItems = items.filter(item =>
      item.label.toLowerCase().includes(query.toLowerCase())
    )

    useImperativeHandle(ref, () => ({
      open(textarea: HTMLTextAreaElement, caretIndex: number, queryStr: string) {
        textareaRef.current = textarea
        caretIndexRef.current = caretIndex
        setQuery(queryStr)
        updatePosition(textarea, caretIndex)
        setIsOpen(true)
      },
      close() {
        setIsOpen(false)
      },
      isOpen() {
        return isOpen
      },
    }))

    const handleClose = () => {
      setIsOpen(false)
    }

    const handleSelect = (item: AgentMentionItem) => {
      onSelect(item)
      handleClose()
    }

    const handleKeyDown = (event: React.KeyboardEvent) => {
      if (listRef.current?.onKeyDown(event.nativeEvent)) {
        event.preventDefault()
      }
    }

    const updatePosition = (textarea: HTMLTextAreaElement, caretIndex: number) => {
      try {
        const rect = getCaretRect(textarea, caretIndex)

        const gap = 8
        let top = rect.bottom + gap
        const left = rect.left

        const popoverHeight = 300
        const viewportHeight = window.innerHeight

        if (top + popoverHeight > viewportHeight) {
          top = Math.max(0, rect.top - popoverHeight - gap)
        }

        setPosition({ top: Math.max(0, top), left: Math.max(0, left) })
      } catch (error) {
        console.warn('Failed to compute popover position:', error)
      }
    }

    useEffect(() => {
      if (!isOpen || !textareaRef.current) return

      const handleScroll = () => {
        updatePosition(textareaRef.current!, caretIndexRef.current)
      }

      const textarea = textareaRef.current
      textarea.addEventListener('scroll', handleScroll)
      window.addEventListener('scroll', handleScroll)

      return () => {
        textarea.removeEventListener('scroll', handleScroll)
        window.removeEventListener('scroll', handleScroll)
      }
    }, [isOpen])

    if (!isOpen || !position) return null

    return createPortal(
      <div
        style={{
          position: 'fixed',
          top: `${position.top}px`,
          left: `${position.left}px`,
          zIndex: 10000,
        }}
        role="presentation"
        onKeyDown={handleKeyDown}
      >
        <AgentMentionList
          ref={listRef}
          items={filteredItems}
          command={handleSelect}
        />
      </div>,
      document.body
    )
  }
)

AgentMentionPopover.displayName = 'AgentMentionPopover'

export default AgentMentionPopover
