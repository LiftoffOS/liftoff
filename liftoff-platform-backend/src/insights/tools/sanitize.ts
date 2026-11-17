// Tool Result Sanitization
//
// Tool results are pulled from the tenant's own DB (and proxied from Tenant
// Runtime). They contain user-controlled strings: agent names, audit log
// reasons, rejection reasons, member display names, etc. Any of those is a
// potential indirect prompt-injection vector — a user who can rename an agent
// can stuff instructions into the agent name and watch the LLM ingest them
// when an admin asks "show me the top agents."
//
// This module is the choke point. Every value coming back from a tool
// executor passes through `sanitizeToolResult()` before being JSON-serialized
// and handed to the LLM as a tool_result message. We:
//
//   1. Strip markdown code fences (```...```), backticks, and HTML tags
//      that could re-open a syntactic block the model is parsing.
//   2. Strip C0 control characters (except whitespace) so the model can't
//      see hidden zero-width or terminal-escape sequences.
//   3. Bound any single string field. The default bound is DEFAULT_MAX_STRING_LEN,
//      which suits what it was written for: unbounded user content (audit log
//      reasons, rejection reasons, a vendor's response body) that adds nothing
//      past a few hundred characters.
//
// We do NOT touch numbers, booleans, dates, ids, or structural keys — only
// the string *values* in the leaves of the result object. The shape of the
// payload is preserved so the LLM still gets the same data, just declawed.
//
// The bound is the CALLER's, because it is a property of the tool and not of
// this module. Steps 1 and 2 are the injection defence and are the same on
// every value; step 3 is a context-size guard, and the default is wrong for a
// result whose value IS a document (a help-centre article) or one the model
// must quote back exactly (an agent's own prose, one of its memories). A
// help-centre article is typically longer than the default, so under it an
// assistant asked "how do I do this" would read the first 500 characters of the
// answer and nothing else. A cut says so,
// in words, rather than trailing a bare ellipsis a model has to guess about: a
// partial document must never read as a whole one.

export const DEFAULT_MAX_STRING_LEN = 500;

/** Sanitize a single string value, bounded at `maxLength`. */
export function sanitizeString(value: string, maxLength: number = DEFAULT_MAX_STRING_LEN): string {
  let cleaned = value;

  // 1. Strip triple-backtick fences (```lang\n...```), open or closed.
  //    A user might write "Agent name ```ignore previous```" — we collapse
  //    the fence markers to single backticks so the prompt structure stays
  //    intact but the fence loses its block-opening power.
  cleaned = cleaned.replace(/```+/g, '`');

  // 2. Strip raw HTML tags. We don't render HTML, but the model might be
  //    primed by its own training to treat <system>... </system> as authoritative.
  cleaned = cleaned.replace(/<\/?[a-zA-Z][^>]*>/g, '');

  // 3. Strip C0 control characters (NUL through US, plus DEL) except
  //    whitespace (\t \n \r). Walking codepoints rather than regex to keep
  //    eslint no-control-regex happy and the intent obvious.
  let stripped = '';
  for (let i = 0; i < cleaned.length; i++) {
    const code = cleaned.charCodeAt(i);
    const isControl = (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f;
    if (!isControl) stripped += cleaned[i];
  }
  cleaned = stripped;

  // 4. Bound, saying so. A bare ellipsis is indistinguishable from one the
  //    author typed, which is how a model comes to relay half an article as
  //    the whole of it.
  if (cleaned.length > maxLength) {
    cleaned = `${cleaned.slice(0, maxLength)}…[cut: ${cleaned.length} characters in full, the first ${maxLength} shown]`;
  }

  return cleaned;
}

/** Recursively sanitize all string values in a JSON-serializable structure,
 *  each bounded at `maxLength`. Non-string leaves (numbers, booleans, null)
 *  and structural keys are left untouched. */
export function sanitizeToolResult(value: unknown, maxLength: number = DEFAULT_MAX_STRING_LEN): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return sanitizeString(value, maxLength);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((v) => sanitizeToolResult(v, maxLength));
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitizeToolResult(v, maxLength);
    }
    return out;
  }
  // Functions, symbols, bigints — coerce to a safe placeholder
  return null;
}
