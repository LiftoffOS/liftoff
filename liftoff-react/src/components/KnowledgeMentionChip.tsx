import { useContext } from 'react'
import { NodeViewWrapper } from '@tiptap/react'
import { KnowledgeChipContext } from './knowledgeChipContext'
import type { NodeViewProps } from '@tiptap/core'

export function KnowledgeMentionChip(props: NodeViewProps) {
  const { node } = props
  const id = node.attrs.id as string
  const label = (node.attrs.label as string) ?? id
  const { availableItemIds, boundConnectorIds, itemConnectorMap } = useContext(KnowledgeChipContext)

  // Available = item exists AND (its connector is null/manual OR its connector is bound).
  const exists = availableItemIds.has(id)
  const itemConnector = itemConnectorMap.get(id) ?? null
  const connectorOk = itemConnector === null || boundConnectorIds.has(itemConnector)
  const broken = !exists || !connectorOk

  // Use the native title attribute (NOT our React Tooltip component) for the
  // hover hint: NodeViewWrapper renders as a <span>, sits inside a <p>, and
  // our Tooltip renders a <div>. <div> inside <p> is invalid HTML and the
  // browser autocloses the <p>, mangling the editor layout. Native title is
  // inline-safe and matches how GitHub/Linear render broken-reference chips.
  const reason = broken
    ? (!exists ? 'Knowledge item deleted' : 'Connector removed')
    : undefined

  return (
    <NodeViewWrapper
      as="span"
      className={broken ? 'knowledge-chip knowledge-chip--broken' : 'knowledge-chip'}
      data-type="knowledgeMention"
      data-id={id}
      data-label={label}
      contentEditable={false}
      title={reason}
    >
      {label}
    </NodeViewWrapper>
  )
}
