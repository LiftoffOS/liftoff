// Parser for the model-facing tool-error envelope the tool-gateway MCP server
// stamps on every classified connector failure: `TOOL_ERROR {…json…}`
// (produced by buildToolErrorContent in mcp-server.ts). Kept in a standalone
// module — no heavy deps — so the live adapter recovery path can consume the
// structured contract without importing the MCP server.

import { classifyError, isRetryable, isToolErrorCode, recoveryFor, type ToolErrorCode } from '@liftoffos/connector-types';

/** Prefix stamped ahead of the JSON body. Must match buildToolErrorContent. */
export const TOOL_ERROR_MARKER = 'TOOL_ERROR ';

export interface ParsedToolError {
  /** Raw vendor message shown to the model. */
  error: string;
  code: ToolErrorCode;
  retryable: boolean;
  retryAfterMs?: number;
  recovery: string;
}

/**
 * Extract the structured tool-error contract from a tool-result error string.
 * Returns null for legacy / unstructured errors (the caller falls back to its
 * existing prose handling), so it is safe to call on any error string.
 */
export function parseToolErrorEnvelope(text: unknown): ParsedToolError | null {
  if (typeof text !== 'string') return null;
  const idx = text.indexOf(TOOL_ERROR_MARKER);
  if (idx === -1) return null;
  let body: {
    error?: unknown;
    code?: unknown;
    retryable?: unknown;
    retry_after_ms?: unknown;
    recovery?: unknown;
  };
  try {
    body = JSON.parse(text.slice(idx + TOOL_ERROR_MARKER.length));
  } catch {
    return null;
  }
  if (!body || typeof body !== 'object' || !isToolErrorCode(body.code)) return null;
  const code = body.code;
  const error = typeof body.error === 'string' ? body.error : text;
  return {
    error,
    code,
    retryable: typeof body.retryable === 'boolean' ? body.retryable : isRetryable(code),
    retryAfterMs: typeof body.retry_after_ms === 'number' ? body.retry_after_ms : undefined,
    // A denial that arrives without recovery text falls back to the taxonomy's
    // generic policy wording; producers that HAVE the reason send the
    // reason-first form (admissionDeniedRecovery) explicitly.
    recovery: typeof body.recovery === 'string' ? body.recovery : recoveryFor(code),
  };
}

/**
 * Producer counterpart to parseToolErrorEnvelope: format a classified error as
 * the exact `TOOL_ERROR {…}` string the tool-gateway MCP server stamps (mirrors
 * buildToolErrorContent's body shape) so producer and parser stay symmetric.
 */
export function formatToolErrorEnvelope(input: {
  message: string;
  code: ToolErrorCode;
  retryable?: boolean;
  retryAfterMs?: number;
  recovery?: string;
  connectorType?: string;
}): string {
  const body = {
    error: input.message,
    code: input.code,
    retryable: input.retryable ?? isRetryable(input.code),
    ...(input.retryAfterMs ? { retry_after_ms: input.retryAfterMs } : {}),
    recovery: input.recovery ?? recoveryFor(input.code, { connectorType: input.connectorType }),
  };
  return `${TOOL_ERROR_MARKER}${JSON.stringify(body)}`;
}

/**
 * Classify a RAW (unclassified) tool-error string into the TOOL_ERROR envelope.
 *
 * This is the adapter-layer seam for tool errors that bypass the in-process
 * tool-gateway's buildToolErrorContent — i.e. VENDOR-HOSTED MCP tools
 * (GitHub / Notion / Stripe / Snowflake / custom MCP), which the vendor SDK
 * dispatches directly. Enveloping them here gives the model the same uniform
 * contract AND makes parseToolErrorEnvelope succeed on the recovery path (so the
 * classified fast-trip fires instead of a wasted recovery-LLM turn).
 *
 * IDEMPOTENT: returns `null` when the text is ALREADY an envelope (the
 * in-process path's output), so callers never double-wrap.
 */
export function envelopeRawToolError(
  rawText: string,
  ctx?: { connectorType?: string },
): string | null {
  if (!rawText || rawText.includes(TOOL_ERROR_MARKER)) return null;
  const code = classifyError({ message: rawText });
  return formatToolErrorEnvelope({ message: rawText, code, connectorType: ctx?.connectorType });
}
