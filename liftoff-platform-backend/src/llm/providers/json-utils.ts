// Shared JSON parsing helpers for LLM provider tool-use normalization.
//
// LLM providers stream tool-call argument JSON in fragments. By the time we
// have the full string, the model may still have produced a malformed payload
// (truncated, hallucinated). The chat service's tool dispatcher already
// handles "missing/wrong fields" gracefully, so the safest behavior at the
// provider layer is to coerce malformed JSON into an empty object rather than
// throwing — that way the loop can give the model a tool error and let it
// retry, instead of crashing the whole turn.

/** Parse a JSON string into a plain object. Returns {} on any parse error or
 *  if the parsed value is not a plain object. */
export function safeParseJsonObject(raw: string | undefined | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
