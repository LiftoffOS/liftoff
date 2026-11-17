// Learned Context memories are written by the agent runtime and often carry
// raw formatting that reads poorly in the dashboard's compact list:
//   - lightweight markdown labels: **Rule:** / **Why:** / **Applies when:**
//   - multi-line bodies joined with "\n"
//   - fully-qualified MCP tool ids, e.g.
//     mcp__liftoff-tool-gateway__google-mail-14a82d9e__list_messages
//
// formatMemoryContent normalises all three into a single clean line so the
// panel is readable. It is display-only — the stored memory is untouched.

// Strip the internal MCP tool-id prefix down to the final tool segment.
// `mcp__<server>__<connector-instance>__<tool>` → `<tool>`.
// Non-MCP tool names (ToolSearch, Read, Bash, …) are left as-is. The `\S*`
// stays within a single whitespace-delimited token, so it never eats across
// the " → " separators between tools in a sequence.
export function prettifyToolNames(text: string): string {
  return text.replace(/mcp__\S*__/g, '');
}

// Turn a raw memory body into one clean display line.
export function formatMemoryContent(raw: string): string {
  return prettifyToolNames(raw)
    .replace(/\*\*/g, '')            // drop markdown bold markers
    .replace(/\s*\n\s*/g, ' · ')     // former line breaks → a visible separator
    .replace(/[ \t]+/g, ' ')          // collapse redundant spaces
    .trim();
}

// Truncate on a word boundary (never mid-word) and append an ellipsis.
// Falls back to a hard cut only when a single token exceeds the limit.
export function truncateOnWord(text: string, limit = 140): string {
  if (text.length <= limit) return text;
  const slice = text.slice(0, limit);
  const lastSpace = slice.lastIndexOf(' ');
  const base = lastSpace > limit * 0.6 ? slice.slice(0, lastSpace) : slice;
  return base.trimEnd() + '…';
}
