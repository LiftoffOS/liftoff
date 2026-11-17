// Shared helpers for the agent-response <CITATIONS> convention.
//
// Agents emit a <CITATIONS>[...JSON...]</CITATIONS> block at the very end of a
// response. chat-service parses it into structured citations and strips it from
// the persisted text (see chat-service.ts). The Slack and Teams streamers
// accumulate the raw text_delta stream, so they must strip the block themselves
// before rendering — otherwise the literal block leaks into the channel message.

import type { Citation } from './chat-repository';

const CITATIONS_BLOCK = /<CITATIONS>[\s\S]*?<\/CITATIONS>/g;

/** Remove any <CITATIONS>…</CITATIONS> block(s) from text about to be rendered. */
export function stripCitationsBlock(text: string): string {
  return text.replace(CITATIONS_BLOCK, '').trimEnd();
}

/** Render citations as a Slack mrkdwn "Sources" list (empty string if none). */
export function formatCitationsMrkdwn(citations: Citation[] | null | undefined): string {
  if (!citations || citations.length === 0) return '';
  const lines = citations.map((c) => {
    const loc = c.page ? ` (p.${c.page})` : '';
    return `*[${c.ref}]* ${c.filename}${loc}`;
  });
  return `*Sources*\n${lines.join('\n')}`;
}

/** Render citations as Adaptive Card markdown "Sources" list (empty string if none). */
export function formatCitationsMarkdown(citations: Citation[] | null | undefined): string {
  if (!citations || citations.length === 0) return '';
  const lines = citations.map((c) => {
    const loc = c.page ? ` (p.${c.page})` : '';
    return `**[${c.ref}]** ${c.filename}${loc}`;
  });
  return `**Sources**\n\n${lines.join('\n\n')}`;
}
