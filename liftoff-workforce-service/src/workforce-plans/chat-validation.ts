// User-facing copy for a rejected chat message.
//
// The client shows `error` verbatim and deliberately does not render `details`,
// because raw zod paths are not user-facing copy. So a bare "Validation failed"
// reaches someone as a toast with no reason and no hint at what would fix it,
// even though the reason is on the wire. The server owns user-facing copy;
// `details` still ships for telemetry.

import { ZodError } from 'zod';
import { MAX_CHAT_MESSAGE_CHARS } from './context-budget.js';

/**
 * Turn a chat-body schema failure into a sentence worth showing someone.
 * Falls back to the generic string for issues with no better phrasing.
 */
export function describeChatValidationFailure(error: ZodError): string {
  const contentIssue = error.errors.find(e => e.path[0] === 'content');

  if (contentIssue?.code === 'too_big') {
    return `That message is too long. Please shorten it to ${MAX_CHAT_MESSAGE_CHARS.toLocaleString('en-US')} characters or less and send it again.`;
  }
  if (contentIssue?.code === 'too_small') {
    return 'Please type a message before sending.';
  }

  return 'Validation failed';
}
