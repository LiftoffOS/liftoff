import { forwardRef, useEffect, useImperativeHandle, useState } from 'react'

export interface AgentMentionItem {
  id: string
  label: string
}

export interface AgentMentionListRef {
  onKeyDown: (event: KeyboardEvent) => boolean
}

interface AgentMentionListProps {
  items: AgentMentionItem[]
  command: (item: { id: string; label: string }) => void
}

const AgentMentionList = forwardRef<AgentMentionListRef, AgentMentionListProps>(
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
          if (item) command({ id: item.id, label: item.label })
          return true
        }
        return false
      },
    }))

    if (!items.length) {
      return (
        <div className="agent-mention-list">
          <div className="agent-mention-list__empty">No matching agents</div>
        </div>
      )
    }

    return (
      <div className="agent-mention-list">
        {items.map((item, index) => (
          <button
            key={item.id}
            type="button"
            className={`agent-mention-list__item${index === selectedIndex ? ' agent-mention-list__item--selected' : ''}`}
            onMouseDown={e => {
              e.preventDefault()
              command({ id: item.id, label: item.label })
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
    )
  },
)

AgentMentionList.displayName = 'AgentMentionList'

export default AgentMentionList
