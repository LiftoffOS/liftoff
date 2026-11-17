// A.1 — shared audit emission for standard tools + first-class builtins.
//
// Both dispatch paths (interactive MCP wrapper in src/tool-gateway/mcp-server.ts
// and autonomous runtime in src/agent-execution/service.ts) need to write the
// SAME audit row shape for standard tools. Keeping that shape in one place
// means:
//   (1) one place to read the kill-switch env var,
//   (2) one place to map success/error → audit fields,
//   (3) tests exercise the real code path that both dispatchers use — not a
//       hand-rolled mirror. A future regression that removes the call site
//       would surface in the integration tests of the call site, and the
//       unit test below would still pin the field-mapping invariants.
//
// Kill switch: AUDIT_LOG_STANDARD_TOOLS_DISABLED=1 short-circuits to a no-op.

import { insertAuditLog } from './service';
import { summariseToolResult } from './result-identity';
import { logger } from '../infrastructure/logging';

export interface StandardToolAuditInput {
  tenantId: string;
  agentId: string;
  threadId?: string;
  invocationId?: string;
  /** Bare tool name for standard tools (e.g. `memory_save`).
   *  For `search` sub-dispatches use `<connectorAlias>__search`.
   *  For `__builtin:search` use `search`. */
  action: string;
  inputArgs: unknown;
  success: boolean;
  /** What came back. Recorded on SUCCESS, which used to record nothing at all:
   *  a green row said a call happened and said nothing about what it returned,
   *  so the row a person reads to check whether work was done could not be
   *  checked against anything. Same rule the connector paths already follow. */
  result?: unknown;
  error?: string;
  errorCode?: string;
  durationMs: number;
  /** Per-dispatch id (ctx.toolCallId). Stamped as the audit row's
   *  idempotency_key, which is what lets an individual tool charge's cost
   *  row (whose action_id carries the same id) join the audit record of
   *  exactly that call. Doubles as write-dedup for replayed dispatches. */
  toolCallId?: string;
}

/** True when standard-tool audit writes are disabled at the process level. */
export function isStandardToolAuditDisabled(): boolean {
  return process.env.AUDIT_LOG_STANDARD_TOOLS_DISABLED === '1';
}

/**
 * Emit an audit row for a standard tool dispatch.
 *
 * Fire-and-forget — never throws, never awaited on the hot path. On failure
 * logs a single warn line and continues.
 *
 * Returns the underlying insertAuditLog promise so test code can await it.
 * Production callers must NOT await (per the A.1 < 5ms p99 SLO).
 */
export function emitStandardToolAudit(input: StandardToolAuditInput): Promise<void> {
  if (isStandardToolAuditDisabled()) {
    return Promise.resolve();
  }
  return insertAuditLog(null, input.tenantId, {
    internalAgentId: input.agentId,
    threadId: input.threadId,
    invocationId: input.invocationId,
    action: input.action,
    inputArgs: input.inputArgs as Record<string, unknown>,
    outputSummary: input.success
      ? summariseToolResult(input.result)
      : (input.error ? input.error.slice(0, 500) : undefined),
    outcome: input.success ? 'success' : 'error',
    errorCode: input.success ? undefined : (input.errorCode ?? 'standard_tool_error'),
    triggeredBy: `agent:${input.agentId}`,
    durationMs: input.durationMs,
    idempotencyKey: input.toolCallId,
  }).catch(err => {
    logger.warn({ err, action: input.action }, 'Non-fatal: standard-tool audit log failed');
  });
}
