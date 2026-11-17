// The last door on the way into a chat table.
//
// Every reply reaches a person through the output guard first
// (common/guarded-stream.ts), so this is normally a no-op. It is here for
// the code paths that write an assistant row without going through a
// stream: a callback after a pause, a suggestion, a colleague's reply
// relayed from another surface, or a writer nobody has thought of yet. What
// can be recognised by shape (an identifier, a connector tool name) never
// lands in a row a person can read, whichever code wrote it.
//
// The person's own words are never touched: what they typed is theirs.

import { scrubIdentifiers } from './identifier-scrub';

export function storedAssistantContent(role: string, content: string): string {
  return role === 'assistant' ? scrubIdentifiers(content) : content;
}
