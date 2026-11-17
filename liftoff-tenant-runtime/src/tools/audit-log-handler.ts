// WS-3.7 — audit_log standard tool handler.
//
// Writes an agent-emitted audit row to the same `audit_logs` table the
// rest of the platform uses. No notification fan-out, no escalation; just
// a durable agent-emitted audit row.

import { insertAuditLog } from '../audit';
import type { StandardToolContext, StandardToolResult } from './standard-tool-handler';

interface AuditLogInput {
  action: string;
  resource_type?: string;
  resource_id?: string;
  metadata?: Record<string, unknown>;
  outcome?: 'success' | 'failure';
}

export async function handleAuditLog(
  payload: Record<string, unknown>,
  ctx: StandardToolContext,
): Promise<StandardToolResult> {
  const input = payload as unknown as AuditLogInput;
  if (!input.action || typeof input.action !== 'string') {
    return { success: false, error: 'audit_log requires a non-empty "action" string' };
  }
  try {
    await insertAuditLog(null, ctx.tenantId, {
      internalAgentId: ctx.agentId,
      action: input.action,
      inputArgs: {
        resource_type: input.resource_type,
        resource_id: input.resource_id,
        ...(input.metadata ?? {}),
      },
      // audit_logs.outcome enum is 'success' | 'error' | 'gated'; map the
      // tool's 'failure' alias onto 'error' so the column constraint accepts it.
      outcome: input.outcome === 'failure' ? 'error' : (input.outcome ?? 'success'),
      triggeredBy: `agent:${ctx.agentId}`,
    });
    return { success: true, result: { recorded: true } };
  } catch (err) {
    return { success: false, error: `audit_log insert failed: ${(err as Error).message}` };
  }
}
