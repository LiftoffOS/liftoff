/**
 * What kind of row a media message is.
 *
 * Its own leaf module for the same reason `agent-chat/hitl-status-message.ts`
 * is one: the constant is read by code that has no business importing the
 * machinery beside it. The Teams worker needs to recognise a media row when it
 * collects a turn's artifacts, and reaching for it through the attach helper
 * would drag GCS, the audit ledger and three chat repositories into a worker
 * that only wanted a string.
 *
 * Typed rather than left NULL, for two reasons that both bite silently. A
 * thread counts as a conversation when it holds a row that is not a bare
 * auto-greeting, and the structural signature of that is `role <> 'assistant'
 * OR turn_id IS NOT NULL OR message_type IS NOT NULL` — an untyped, turn-less
 * assistant row is EXACTLY the greeting's signature, so a media row without a
 * type would be indistinguishable from one and would not count. The comment on
 * IS_CONVERSATION_PREDICATE says the greeting is the only such write in the
 * estate, and this keeps that true rather than quietly falsifying it.
 *
 * It also matches the precedent beside it: `file_output`, the other row whose
 * payload is an artifact rather than words, is typed for the same reason.
 *
 * No renderer dispatches on it. The transcript draws media from the `media`
 * field, so no page has to learn this vocabulary.
 */
export const MEDIA_MESSAGE_TYPE = 'media';
