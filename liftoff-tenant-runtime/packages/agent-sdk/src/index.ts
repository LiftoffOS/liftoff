// @liftoffos/agent-sdk — in-sandbox SDK for calling MCP tools through the
// local sidecar's /v1/mcp/* surface. Reads via `tools.<alias>.<name>(args)`.
//
// The SDK is preinstalled (globally) into the aio-sandbox image so agent-
// authored Node scripts get ergonomic access to the agent's bound tools
// without writing fetch() calls. Every dispatch flows through the runtime's
// governance pipeline exactly like an LLM-emitted tool call.

const SIDECAR_BASE = process.env.SANDBOX_SIDECAR_BASE_URL ?? 'http://127.0.0.1:8090';

export interface DispatchResult {
  success: boolean;
  data?: unknown;
  error?: string;
  /** Gated and NOT executed — the agent must perform this via a normal (LLM)
   *  tool call to get human approval (Increment A, and B's no-context fallback). */
  hitl_required?: boolean;
  /** Queued for human approval — poll await-approval until decided (Increment B). */
  hitl_pending?: boolean;
  idempotency_key?: string;
  reason?: string;
}

/** A connector call from sandbox code was blocked by workspace oversight and
 *  cannot be auto-approved. Perform the action via a normal tool call instead. */
export class HitlRequiredError extends Error {
  readonly reason: string;
  constructor(reason: string) { super(`requires_human_approval: ${reason}`); this.name = 'HitlRequiredError'; this.reason = reason; }
}
/** A human rejected a pended sandbox-code action on /dashboard/review. */
export class HitlRejectedError extends Error {
  readonly reason: string;
  constructor(reason: string) { super(`rejected: ${reason}`); this.name = 'HitlRejectedError'; this.reason = reason; }
}
/** A pended action was not decided within the poll window. */
export class HitlTimeoutError extends Error {
  constructor(public readonly idempotencyKey: string) { super(`approval_timeout: ${idempotencyKey}`); this.name = 'HitlTimeoutError'; }
}

interface ApprovalResult { status: string; result?: unknown; reason?: unknown; }

export interface ToolListEntry {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  connectorAlias?: string;
  connectorType?: string | null;
}

async function awaitApproval(idempotencyKey: string, timeoutMs: number): Promise<ApprovalResult> {
  const res = await fetch(`${SIDECAR_BASE}/v1/mcp/await-approval`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idempotencyKey, timeout_ms: timeoutMs }),
  });
  return (await res.json()) as ApprovalResult;
}

async function dispatch(
  toolName: string,
  args: Record<string, unknown>,
  idempotencyKey?: string,
  approvalTimeoutMs?: number,
): Promise<unknown> {
  const res = await fetch(`${SIDECAR_BASE}/v1/mcp/dispatch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool_name: toolName, args, idempotency_key: idempotencyKey }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`sidecar dispatch failed (${res.status}): ${text}`);
  }
  const body = (await res.json()) as DispatchResult;
  // Increment B: the call is queued for human approval. Block (synchronously,
  // from the agent's POV) until a human decides on /dashboard/review.
  if (body.hitl_pending && body.idempotency_key) {
    const approval = await awaitApproval(body.idempotency_key, approvalTimeoutMs ?? 300_000);
    if (approval.status === 'approved') return approval.result;
    if (approval.status === 'rejected') throw new HitlRejectedError(String(approval.reason ?? 'rejected'));
    throw new HitlTimeoutError(body.idempotency_key);
  }
  // Increment A (or B's no-context fallback): gated, not executed.
  if (body.hitl_required) {
    throw new HitlRequiredError(body.reason ?? 'requires human approval');
  }
  if (body.success === false) {
    throw new Error(body.error ?? 'dispatch_failed');
  }
  return body.data;
}

export async function listTools(): Promise<ToolListEntry[]> {
  const res = await fetch(`${SIDECAR_BASE}/v1/mcp/tools`);
  if (!res.ok) throw new Error(`list tools failed (${res.status})`);
  const body = (await res.json()) as { tools: ToolListEntry[] };
  return body.tools;
}

type AnyArgs = Record<string, unknown>;
type ConnectorTools = Record<string, (args: AnyArgs, opts?: { idempotencyKey?: string; approvalTimeoutMs?: number }) => Promise<unknown>>;
export type ToolsProxy = Record<string, ConnectorTools>;

/**
 * Lazy Proxy: `tools.<alias>.<toolName>(args)` resolves to a dispatch call
 * keyed `<alias>__<toolName>`. No upfront tool list lookup — the call is
 * issued directly and the runtime validates the name. This keeps cold-start
 * trivial and means new tools are immediately usable without redeploying
 * the SDK.
 */
export const tools: ToolsProxy = new Proxy({} as ToolsProxy, {
  get(_target, alias: string): ConnectorTools {
    return new Proxy({} as ConnectorTools, {
      get(_inner, toolName: string) {
        return (args: AnyArgs, opts?: { idempotencyKey?: string; approvalTimeoutMs?: number }) =>
          dispatch(`${alias}__${toolName}`, args, opts?.idempotencyKey, opts?.approvalTimeoutMs);
      },
    });
  },
});

export { dispatch };
