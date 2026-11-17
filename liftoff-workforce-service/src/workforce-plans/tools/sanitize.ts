// Tool Result Sanitizer
//
// Strips HTML tags and control characters from tool results before they are
// fed back to the LLM, and truncates long strings to mitigate prompt
// injection via user-controlled fields (e.g. an agent name containing
// "```ignore previous```").
//
// Adapted from platform-backend src/insights/tools/sanitize.ts. Identical
// logic, local copy to remove the cross-package dependency.

const MAX_STRING_LENGTH = 2000;
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;
// Minimal HTML tag strip — enough to defuse basic injection without a full parser.
const HTML_TAG_RE = /<[^>]*>/g;

function sanitizeString(value: string): string {
  return value
    .replace(HTML_TAG_RE, '')
    .replace(CONTROL_CHAR_RE, '')
    .slice(0, MAX_STRING_LENGTH);
}

/**
 * Recursively sanitize a tool result value. Objects and arrays are walked;
 * strings are stripped of HTML and control chars and truncated. Other
 * primitives pass through unchanged.
 */
export function sanitizeToolResult(value: unknown): unknown {
  if (typeof value === 'string') {
    return sanitizeString(value);
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeToolResult);
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[sanitizeString(k)] = sanitizeToolResult(v);
    }
    return out;
  }
  // number, boolean, null — pass through.
  return value;
}
