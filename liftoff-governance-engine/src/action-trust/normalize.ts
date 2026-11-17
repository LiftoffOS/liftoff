// Action-class normalization for the trust ledger.
//
// Tool names reach governance in several dispatch-prefixed forms:
//   - connector catalog / sandbox:  `<alias>__<tool>`
//   - Claude Agent SDK (LLM path):  `mcp__<server>__<tool>`
//     (in-process: `mcp__liftoff-tools-<tenant>__<alias>__<tool>`)
//   - already-bare:                 `<tool>` or `<connector>:<action>`
//
// The trust ledger keys on the BARE action, so a given real-world action is
// tracked as one `action_class` no matter which dispatch prefix wrapped it.
//
// This reuses the SAME normalization rule as hitl-enforcement's
// `toolActionMatchesNameSet` (src/hitl-enforcement/service.ts): take the
// segment after the LAST `__`, else the whole name. Kept as its own tiny
// pure helper so this shadow substrate does not import from — or alter — the
// enforcement module.

/**
 * Normalize a raw tool name to its bare action class: the segment after the
 * last `__`, or the trimmed whole string when there is no `__`. Returns ''
 * for empty/whitespace-only input (callers skip empty classes).
 */
export function normalizeActionClass(toolName: string): string {
  if (!toolName) return '';
  const trimmed = toolName.trim();
  if (!trimmed) return '';
  const sep = trimmed.lastIndexOf('__');
  if (sep >= 0) {
    const tail = trimmed.slice(sep + 2).trim();
    return tail;
  }
  return trimmed;
}
