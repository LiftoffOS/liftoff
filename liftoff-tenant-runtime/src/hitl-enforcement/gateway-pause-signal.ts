// Side-channel for a HITL pause raised inside an in-process MCP tool handler.
//
// The handler signals a pause by throwing HitlGateError. The Agent SDK converts any
// handler exception into a tool error result — reasonable behaviour on its part, but it
// means the throw reaches the model as "that tool failed" instead of pausing the run.
// Observed live: the call was blocked, no approval row was created, nothing appeared on
// /dashboard/review, and the invocation recorded outcome='success'.
//
// Fixing that does NOT require touching the SDK. The throw is OUR choice of signal, and
// the gateway runs `kind: 'in-process'` (service.ts:2400) — same process, same heap — so
// a module-level registry is genuinely shared between the tool handler and the adapter
// that needs to know. This mirrors what the five mcp-bridge adapters already do with
// `context.pendingHitlGate`; it just needs a channel that survives the SDK boundary.
//
// Deliberately ADDITIVE: handlers still throw. This records the pause first, so the
// adapter can act on it whether or not the throw survives. Nothing that works today
// changes behaviour.

export interface GatewayHitlPause {
  toolName: string;
  reason: string;
  args: Record<string, unknown>;
  /** The Sensitive Work category named, when the reason is sensitive_work. */
  matchedCategory?: string;
  /** What the gate recorded for the approval's `context` column: the
   *  message check's verdict (`messageCheck`, message-check.ts). */
  context?: Record<string, unknown>;
}

/** Keyed by invocation so concurrent runs in one process cannot read each other's
 *  pause. Entries are removed on read (see takeGatewayHitlPause) and are only ever
 *  written on a gate, so this cannot grow unbounded in normal operation. */
const pending = new Map<string, GatewayHitlPause>();

/**
 * Record that a tool handler is refusing to dispatch pending human approval.
 *
 * First write wins: if a second gated tool fires in the same invocation before the
 * adapter drains this, keeping the FIRST preserves the approval the user will actually
 * be shown. Overwriting would silently discard it — the same failure the OpenAI bridge
 * guards against in its own comment about overwriting pendingHitlGate.
 */
export function recordGatewayHitlPause(
  invocationId: string | undefined,
  pause: GatewayHitlPause,
): void {
  if (!invocationId) return;
  if (pending.has(invocationId)) return;
  pending.set(invocationId, pause);
}

/** Read and clear. Returns undefined when no handler gated during this invocation. */
export function takeGatewayHitlPause(invocationId: string | undefined): GatewayHitlPause | undefined {
  if (!invocationId) return undefined;
  const found = pending.get(invocationId);
  if (found) pending.delete(invocationId);
  return found;
}

/** Drop any unread signal for an invocation. Called when a run ends by another route
 *  so a stale entry cannot leak into a later run that reuses the id. */
export function clearGatewayHitlPause(invocationId: string | undefined): void {
  if (!invocationId) return;
  pending.delete(invocationId);
}
