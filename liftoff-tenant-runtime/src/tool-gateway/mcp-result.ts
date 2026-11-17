// Shared interpretation of an MCP `tools/call` result envelope (MCP 2026-07-28).
//
// Every runtime MCP tool-call path — the hand-rolled external-agent and
// custom-MCP handlers, and the SDK bridge (mcp-bridge) — routes its result
// through here so the envelope is treated consistently:
//
//   - resultType === 'input_required'  → a Multi Round-Trip Requests (MRTR)
//     interim result: the server needs interactive input (elicitation /
//     sampling / roots) before it can complete. The runtime tool-dispatch path
//     cannot fulfil that synchronously, so the call fails cleanly with a
//     legible error rather than handing the interim result to the model as if
//     it were the final result.
//   - isError === true → the tool executed but returned an error result;
//     surface it as a failure instead of reporting success.

import { flattenToolResultText } from '../agent-execution/adapter/tool-result-text';

export interface McpToolResultInterpretation {
  /** resultType === 'input_required' (MRTR interim result). */
  inputRequired: boolean;
  /** isError === true (tool-level error result). */
  isError: boolean;
}

export function interpretMcpToolCallResult(result: unknown): McpToolResultInterpretation {
  const envelope = result as { resultType?: string; isError?: boolean } | null | undefined;
  return {
    inputRequired: envelope?.resultType === 'input_required',
    isError: envelope?.isError === true,
  };
}

/** Legible error text for an MRTR `input_required` result on a path that cannot
 *  provide interactive input mid-call. */
export function inputRequiredError(toolName: string): string {
  return (
    `MCP tool "${toolName}" returned resultType=input_required (Multi Round-Trip Requests); ` +
    `this runtime cannot provide interactive input mid-call.`
  );
}

/**
 * The failure a tool result carries, or undefined for a result that succeeded.
 *
 * Three shapes reach the seams that remember a call, and none of them is a
 * thrown error:
 *
 *   - `{ error, reason? }`   — the bridge answered WITHOUT dispatching: the
 *                              gate denied the call, or paused it for a person
 *   - `{ isError: true, … }` — the MCP envelope of a tool that ran and failed
 *   - `{ type: 'text', text }` — the OpenAI Agents SDK's function-call output,
 *                              whose text is the JSON of one of the above
 *
 * A recorder that looked only at an `error` field on the EVENT wrote every one
 * of these down as a completed action, and `have_i_acted_on` then answered
 * "yes" for work that never happened.
 */
export function toolResultFailure(result: unknown): string | undefined {
  const value = unwrapSdkText(result);
  if (!value || typeof value !== 'object') return undefined;
  const r = value as { error?: unknown; isError?: unknown; content?: unknown; resultType?: unknown };
  if (typeof r.error === 'string' && r.error.length > 0) return r.error;
  // An MRTR interim result: the server wants interactive input this path
  // cannot give. The call did not complete, on any reading of it.
  if (r.resultType === 'input_required') return inputRequiredError('tool');
  if (r.isError === true) {
    const text = r.content !== undefined && r.content !== null ? flattenToolResultText(r.content) : '';
    return text.length > 0 ? text : 'tool returned an error result';
  }
  return undefined;
}

/**
 * The data a tool result carries, for readers that look for FIELDS in it.
 *
 * A vendor-hosted tool's result arrives as the MCP envelope
 * `{ content: [{ type: 'text', text: '<json>' }] }`, and on the OpenAI wire
 * inside the SDK's `{ type: 'text', text }` as well. A path like `head.sha`
 * finds nothing in either — the sha is inside a string — and the identifier
 * floor sees one long string that is not an identifier. Every read of a
 * vendor server therefore established nothing, and every write that followed
 * was judged against an empty store.
 *
 * Text parts that parse as JSON become their value; one part is returned as
 * itself, several as an array. Anything that is not an envelope is returned as
 * it is, so the gateway's own executor results — already data — pass through.
 */
export function toolResultData(result: unknown): unknown {
  const value = unwrapSdkText(result);
  if (!value || typeof value !== 'object') return value;
  // MCP's `structuredContent` IS the structured result, when a server sends
  // one; the text parts beside it are its rendering. Prefer it: it needs no
  // parsing, and a text part may be the same value pretty-printed, truncated,
  // or prose.
  const structured = (value as { structuredContent?: unknown }).structuredContent;
  if (structured && typeof structured === 'object') return structured;
  // The parts may arrive BARE: the Claude Agent SDK's PostToolUse hook hands
  // an MCP tool's result as the content array itself, not wrapped in
  // `{ content }`. Read as data, an array of text parts has no `number` and
  // no `base.repo.full_name`, so every vendor read on that engine recorded
  // nothing — invisible for as long as a trigger seeded the ref the write
  // then passed on, and a false hold the moment one did not.
  const content = Array.isArray(value) && isContentParts(value)
    ? value
    : (value as { content?: unknown }).content;
  if (!Array.isArray(content)) return value;
  const parts = content
    .filter((p): p is { type: 'text'; text: string } =>
      !!p && typeof p === 'object' && (p as { type?: unknown }).type === 'text' && typeof (p as { text?: unknown }).text === 'string')
    .map((p) => parseIfJson(p.text));
  if (parts.length === 0) return value;
  return parts.length === 1 ? parts[0] : parts;
}

/** Every element is an MCP content part — `{ type, ... }` with a string
 *  `text` on text parts — as opposed to a vendor's own array of records,
 *  which is data and must stay data. */
function isContentParts(arr: unknown[]): boolean {
  return arr.length > 0 && arr.every((p) => {
    if (!p || typeof p !== 'object') return false;
    const t = (p as { type?: unknown }).type;
    if (typeof t !== 'string') return false;
    return t !== 'text' || typeof (p as { text?: unknown }).text === 'string';
  });
}

/** `{ type: 'text', text }` → whatever the text is the JSON of; a bare JSON
 *  string likewise; anything else unchanged. */
function unwrapSdkText(result: unknown): unknown {
  if (typeof result === 'string') return parseIfJson(result);
  if (result && typeof result === 'object') {
    const r = result as { type?: unknown; text?: unknown };
    if (r.type === 'text' && typeof r.text === 'string' && Object.keys(r).length <= 3) return parseIfJson(r.text);
  }
  return result;
}

function parseIfJson(text: string): unknown {
  const t = text.trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return text;
  try { return JSON.parse(t); } catch { return text; }
}
