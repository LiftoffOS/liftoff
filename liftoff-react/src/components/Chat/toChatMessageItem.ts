import type { ChatMessageAttachment } from '../../types/chatAttachments'
import type { SentAttachment } from './ChatMessages'

/**
 * A stored message from one of the three platform assistants (Liftoff, the
 * Chief AI Officer, the Insights Manager) as the transcript renders it.
 *
 * All three store the same row, and all three had the same near-identical
 * mapping block: the wire `attachments` are remapped to `sentAttachments`,
 * because ChatMessageItem already uses `attachments` for files the team
 * PRODUCED, and letting what the person SENT ride under that name would render
 * them as downloads. Written once here so a fourth field on the row (today,
 * `contributors`) reaches the transcript from every page through one path,
 * rather than three copies of the block each having to learn it.
 *
 * Generic so a surface's own fields (`author`, `visualizationBlocks`) survive
 * the spread with their types intact; the transcript reads the ones it knows
 * and the page keeps the rest. `messageType` needs no widening: the transcript
 * already takes `string | null`, because that is what every surface returns.
 *
 * Team chat deliberately does not go through this. Its message is already
 * ChatMessageItem-shaped field for field, and its `attachments` mean the
 * OPPOSITE thing (files the team produced), so remapping them would be wrong.
 */
export type ChatMessageItemFrom<T extends { attachments?: readonly ChatMessageAttachment[] | null }> =
  Omit<T, 'attachments'> & { sentAttachments?: SentAttachment[] }

export function toChatMessageItem<T extends { attachments?: readonly ChatMessageAttachment[] | null }>(
  message: T,
): ChatMessageItemFrom<T> {
  const { attachments, ...rest } = message
  return {
    ...rest,
    sentAttachments: attachments?.map(attachment => ({
      kind: attachment.kind,
      name: attachment.name,
      connectorType: attachment.connectorType,
    })),
  }
}
