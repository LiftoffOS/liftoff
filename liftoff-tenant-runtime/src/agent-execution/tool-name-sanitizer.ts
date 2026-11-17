// Single source of truth for sanitizing tool names so they pass the LLM
// tool-name regex ^[a-zA-Z0-9_-]+$ enforced by OpenAI + Anthropic.
//
// Background: a registry that emits tool names of the shape
// `${connectorType}.${fn.name}` (e.g. 'slack.create_channel'), once
// tenant-runtime prefixes the per-binding alias for the LLM tool schema,
// produces 'slack__slack.create_channel' — the dot violates the LLM regex and
// the API rejects the entire tool schema with HTTP 400 before any reasoning
// happens, so every run of every agent bound to that connector fails.
//
// connector-service does not emit the dotted prefix. This module is
// defense-in-depth: every tool-name assembly site in tenant-runtime calls
// these helpers so any future malformed registry entry (new connector, hand-
// edited migration, vendor MCP schema with dots) is silently fixed before the
// name reaches the LLM API. Belt + braces.
//
// `LLM_TOOL_NAME_REGEX` is exported so callers can assert on the final name
// in tests + at runtime if they want belt-AND-braces defense.

/** The pattern enforced by OpenAI's tool-name validator. Anthropic enforces
 *  the same shape via their own validator. Empty strings are not accepted. */
export const LLM_TOOL_NAME_REGEX = /^[a-zA-Z0-9_-]+$/;

/** Replace any disallowed character (anything not letter/digit/underscore/
 *  hyphen) with `_`. Returns the original string when already valid. */
export function sanitizeToolNameSegment(segment: string): string {
  return segment.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Compose the final tool name from an alias and a function name with
 * `${alias}__${functionName}`, sanitizing both sides. Use at every tool-name
 * assembly site so the LLM regex is structurally guaranteed.
 *
 * The double underscore `__` between the two segments is the convention the
 * dispatch layer relies on to extract the alias from incoming tool calls; do
 * not change it without auditing build-tool-call-request.ts and the
 * tool-gateway routing.
 */
export function composeToolName(alias: string, functionName: string): string {
  return `${sanitizeToolNameSegment(alias)}__${sanitizeToolNameSegment(functionName)}`;
}
