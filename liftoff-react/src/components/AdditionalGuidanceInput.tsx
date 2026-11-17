import { useState, useRef } from 'react'
import { FileUploadPopover } from './FileAttach'
import MarkdownTextarea from './MarkdownTextarea'
import type { KnowledgeMentionItem } from './KnowledgeMentionList'
import type { AgentMentionItem } from './AgentMentionList'
import type { TeamAttachment } from '../services/internalAgents'
import PlusIcon from '../assets/icons/plus.svg?react'
import FileTextIcon from '../assets/icons/file-text.svg?react'
import XIcon from '../assets/icons/x.svg?react'
import { GUIDANCE_TEMPLATE } from './guidanceTemplates'


// Which input's popover added an attachment; cards render only own-source
// attachments so each file shows under the input it was imported from.
const SOURCE = 'guidance' as const

const formatUploadDate = (date: Date) => {
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)

  if (diffMins < 1) return 'Just now'
  if (diffMins < 60) return `${diffMins}m ago`

  const diffHours = Math.floor(diffMins / 60)
  if (diffHours < 24) return `${diffHours}h ago`

  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

interface AdditionalGuidanceInputProps {
  value: string
  onChange: (value: string) => void
  title?: string
  titleAs?: 'h1' | 'h2' | 'h3'
  titleClassName?: string
  placeholder?: string
  readOnly?: boolean
  knowledgeItems?: KnowledgeMentionItem[]
  agentItems?: AgentMentionItem[]
  boundConnectorIds?: string[]
  /** Team-level attachment list (all sources); this input renders and
   *  manages only its own `source` entries. */
  attachments?: TeamAttachment[]
  onAttachmentsChange?: (next: TeamAttachment[]) => void
}

export default function AdditionalGuidanceInput({
  value,
  onChange,
  title = 'Any additional guidance they should know?',
  titleAs: TitleTag = 'h2',
  titleClassName,
  placeholder = 'Add specific instructions, rules, constraints, edge cases, and anything they should avoid...',
  readOnly = false,
  knowledgeItems,
  agentItems,
  boundConnectorIds = [],
  attachments = [],
  onAttachmentsChange,
}: AdditionalGuidanceInputProps) {
  const [showPopover, setShowPopover] = useState(false)
  const hasInsertedTemplate = useRef(false)

  const ownAttachments = attachments.filter((a) => a.source === SOURCE)

  const handleFocus = () => {
    if (!hasInsertedTemplate.current && value.trim() === '') {
      onChange(GUIDANCE_TEMPLATE)
      hasInsertedTemplate.current = true
    }
  }

  const removeAttachment = (attachment: TeamAttachment) => {
    onAttachmentsChange?.(attachments.filter((a) => a !== attachment))
  }

  return (
    <>
      {title && <TitleTag className={titleClassName}>{title}</TitleTag>}
      <div className={readOnly ? undefined : 'agent-builder-input agent-builder-input--with-action'}>
        <MarkdownTextarea
          value={value}
          onChange={onChange}
          onFocus={readOnly ? undefined : handleFocus}
          placeholder={placeholder}
          readOnly={readOnly}
          knowledgeItems={knowledgeItems}
          agentItems={agentItems}
          boundConnectorIds={boundConnectorIds}
        />
        {!readOnly && (
          <div className="agent-builder-input__action">
            <button
              type="button"
              className="agent-builder-add-btn"
              onClick={() => setShowPopover(!showPopover)}
              aria-label="Import document"
            >
              <PlusIcon />
            </button>
            <FileUploadPopover
              isOpen={showPopover}
              onClose={() => setShowPopover(false)}
              onAttach={(items) =>
                onAttachmentsChange?.([
                  ...attachments,
                  // Media is filtered out rather than handled. A agent-builder
                  // attachment is an input the distiller READS — it becomes
                  // part of what the team is built from — and there is nothing
                  // to read in a picture: the distiller is text-only, so a
                  // photograph attached here would be carried, stored, and
                  // silently contribute nothing. The popover is not given the
                  // props that let it offer media on this surface, so this
                  // narrows a union rather than discarding anything a person
                  // could actually have picked.
                  ...items
                    .filter((item) => item.kind !== 'media')
                    .map((item) => ({ ...item, source: SOURCE })),
                ])
              }
            />
          </div>
        )}
      </div>
      {ownAttachments.length > 0 && (
        <div className="attached-files">
          {ownAttachments.map((file, index) => (
            <div key={`${file.name}-${index}`} className="attached-file">
              <FileTextIcon className="attached-file__icon" />
              <span className="attached-file__name">{file.name}</span>
              <span className="attached-file__date">{formatUploadDate(new Date(file.addedAt))}</span>
              <button
                type="button"
                className="attached-file__remove"
                onClick={() => removeAttachment(file)}
                aria-label="Remove file"
              >
                <XIcon />
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  )
}
