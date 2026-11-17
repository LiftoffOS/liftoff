/**
 * What a message keeps about one attachment once its turn is over, mirrored
 * once for the whole frontend.
 *
 * The definition of record is @liftoffos/chat-attachments, published from the
 * platform backend and consumed by both it and the workforce service. This is
 * the single React copy: Liftoff, the Insights Manager and the Chief AI Officer
 * all store exactly this, so declaring it per surface would be three chances to
 * disagree about the same row.
 *
 * Metadata only. An upload's extracted text is a one-turn model input, not
 * transcript, and is deliberately never stored or returned.
 */
export type ChatMessageAttachment = {
  kind: 'upload' | 'connector'
  name: string
  /** Connector references only: the tool the record lives in. */
  connectorType?: string
  connectorId?: string
  externalId?: string
  sourceUrl?: string
}
