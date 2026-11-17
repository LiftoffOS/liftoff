import { forwardRef, useEffect, useImperativeHandle, useState } from 'react'

export interface KnowledgeMentionItem {
  id: string
  title: string
  connectorId: string | null  // null for manual URL imports
  connectorName?: string      // display label e.g. "Zendesk · Support"
}

export interface KnowledgeMentionListRef {
  onKeyDown: (event: KeyboardEvent) => boolean
}

interface KnowledgeMentionListProps {
  items: KnowledgeMentionItem[]
  command: (item: { id: string; label: string }) => void
}

const KnowledgeMentionList = forwardRef<KnowledgeMentionListRef, KnowledgeMentionListProps>(
  ({ items, command }, ref) => {
    const [selectedIndex, setSelectedIndex] = useState(0)

    useEffect(() => {
      setSelectedIndex(0)
    }, [items])

    useImperativeHandle(ref, () => ({
      onKeyDown(event: KeyboardEvent) {
        if (event.key === 'ArrowUp') {
          setSelectedIndex(prev => (prev + items.length - 1) % Math.max(items.length, 1))
          return true
        }
        if (event.key === 'ArrowDown') {
          setSelectedIndex(prev => (prev + 1) % Math.max(items.length, 1))
          return true
        }
        if (event.key === 'Enter') {
          const item = items[selectedIndex]
          if (item) command({ id: item.id, label: item.title })
          return true
        }
        return false
      },
    }))

    if (!items.length) {
      return (
        <div className="knowledge-mention-list">
          <div className="knowledge-mention-list__empty">No matching knowledge items</div>
        </div>
      )
    }

    return (
      <div className="knowledge-mention-list">
        {items.map((item, index) => (
          <button
            key={item.id}
            type="button"
            className={`knowledge-mention-list__item${index === selectedIndex ? ' knowledge-mention-list__item--selected' : ''}`}
            onMouseDown={e => {
              e.preventDefault()
              command({ id: item.id, label: item.title })
            }}
          >
            {item.title}
          </button>
        ))}
      </div>
    )
  },
)

KnowledgeMentionList.displayName = 'KnowledgeMentionList'

export default KnowledgeMentionList
