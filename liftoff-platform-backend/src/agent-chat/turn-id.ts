// Stable turn identity for messaging surfaces (C1).
//
// A Slack or Teams message becomes a Cloud Tasks task named after a dedupe key,
// and that task can run more than once: Microsoft or Slack can redeliver the
// same inbound event, and Cloud Tasks retries a task that answered non-2xx.
//
// If each run minted a fresh turn id, a retry after a failed post would look
// like a brand-new question: the runtime would be invoked again, the model paid
// for again, and the person would get the same answer twice (or, worse, a
// second answer that contradicts the first).
//
// Deriving the id from the dedupe key instead means every run of the same
// inbound message addresses the SAME turn — which is what makes "has this
// already run?" answerable at all. It has to be derived rather than stored,
// because the case being defended against is a process that died before it
// could write anything down.

import { createHash } from 'crypto';

/**
 * Deterministic UUIDv4-shaped id for a dedupe key.
 *
 * Formatted as a UUID because `agent_chat_turns.id` is a uuid column. The
 * version and variant nibbles are forced so the value is a well-formed v4 —
 * Postgres accepts any hex in that shape, but a malformed one would be a
 * lurking surprise for anything that parses it.
 */
export function turnIdForDedupeKey(dedupeKey: string): string {
  const hex = createHash('sha256').update(`chat-turn:${dedupeKey}`).digest('hex');
  const bytes = hex.slice(0, 32).split('');
  bytes[12] = '4';                                   // version 4
  bytes[16] = ((parseInt(bytes[16], 16) & 0x3) | 0x8).toString(16); // variant 10xx
  const s = bytes.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}
