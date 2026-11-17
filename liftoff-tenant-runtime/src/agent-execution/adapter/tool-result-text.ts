// Reduce a vendor tool-result `content` to the single text string the
// platform's error consumers expect (parseToolErrorEnvelope on the live
// recovery path; the recovery-LLM anomaly context).
//
// MCP tool results carry `content` as a block array
// (`[{ type: 'text', text }]`); some vendor SDKs hand it back as a bare
// string. Both MUST reduce to the SAME text so the `TOOL_ERROR {…}` envelope
// stamped by the MCP server survives verbatim. `JSON.stringify` of the block
// array would ESCAPE the inner JSON (`{\"code\":…}`), which then fails
// `parseToolErrorEnvelope`'s `JSON.parse` and silently disables the
// classified-error fast-trip on the affected provider (the Anthropic
// PostToolUse hook path is one such case). Extracting the text block first keeps the
// envelope parseable on every provider.

export function flattenToolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const text = content
      .map((b) =>
        b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string'
          ? (b as { text: string }).text
          : '',
      )
      .filter(Boolean)
      .join('\n');
    // Fall back to the stringified array only when NO text block was present
    // (e.g. an image-only result) — there is no envelope to preserve there.
    return text || JSON.stringify(content);
  }
  return content == null ? '' : JSON.stringify(content);
}
