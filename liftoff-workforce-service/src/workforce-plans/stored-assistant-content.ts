// The last door on the way into team_plan_messages.
//
// Every reply reaches a person through the output guard first
// (output-guard-client.ts), so this is normally a no-op. It is here for the
// code paths that write an assistant row without going through the turn: a
// provisioning notice, a colleague's reply relayed from another surface, or
// a writer nobody has thought of yet. What can be recognised by shape (an
// identifier, a connector tool name) never lands in a row a person can
// read, whichever code wrote it. The person's own words are never touched.

import { scrubIdentifiers } from './identifier-scrub.js';

export function storedAssistantContent(role: string, content: string): string {
  return role === 'assistant' ? scrubIdentifiers(content) : content;
}
