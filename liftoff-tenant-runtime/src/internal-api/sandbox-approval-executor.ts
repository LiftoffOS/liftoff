// Increment B — server-side execution of an APPROVED sandbox-code connector call.
//
// The LLM HITL model resumes a paused agent run (enqueueResumeForHitl →
// resumeFromHitlApproval re-dispatches the tool). That can't apply to sandbox
// code: the script is synchronously blocked on /mcp/await-approval and there is
// no paused agent loop to resume. So for source='sandbox_code' approvals we
// execute the connector HERE (server-side, at approval time — survives sandbox
// teardown) and write the result into the pending `actions` row, which
// /mcp/await-approval polls by idempotency_key and returns to the blocked SDK.

import { getPoolForService } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import { buildBindingsByType } from '../tool-gateway/binding-resolver';
import { normalizeIntegrationsField } from '../instruction-compiler/integration-shape';
import { connectorManifestRepository } from '../connectors/manifest-repository';
import { deriveAllowedConnectors } from '../interactive-chat/connector-utils';
import { toolGatewayService } from '../tool-gateway/router';
import { applyApprovedEdits } from '../hitl-enforcement/approved-edits';
import type { HitlApprovalRequest } from '../hitl-enforcement/types';

const pool = getPoolForService('default');

function extractConnectorAlias(toolName: string): string {
  const idx = toolName.indexOf('__');
  return idx > 0 ? toolName.slice(0, idx) : 'sandbox';
}

// Resolve the agent's connector bindings from its LATEST compiled instructions
// (binding membership is stable between dispatch and approval; version pinning
// isn't needed because executeConnectorCall keys on connectorId, not version).
async function resolveBindings(tenantId: string, agentId: string): Promise<Record<string, unknown>> {
  const inst = await pool.query(
    `SELECT integrations FROM compiled_instructions
      WHERE tenant_id = $1 AND agent_id = $2 ORDER BY version DESC LIMIT 1`,
    [tenantId, agentId],
  );
  const integrations = normalizeIntegrationsField(inst.rows[0]?.integrations) as Array<{ id: string; type?: string }>;
  if (integrations.length === 0) return {};
  // Resolve manifests like the LLM catalog (getManifestsForAgent: by
  // type/alias/id + connectors-table join) rather than a brittle id-only match,
  // so server-side execution at approval time binds the same connector the
  // dispatch gate saw.
  const allowedConnectors = deriveAllowedConnectors(integrations);
  const manifests = await connectorManifestRepository.getManifestsForAgent(tenantId, allowedConnectors);
  return buildBindingsByType(
    integrations.map(i => ({ id: i.id, type: i.type })) as unknown as Parameters<typeof buildBindingsByType>[0],
    manifests.map(m => ({ id: m.id, alias: m.alias, type: m.connectorType ?? undefined })) as unknown as Parameters<typeof buildBindingsByType>[1],
  ) as unknown as Record<string, unknown>;
}

async function settleAction(tenantId: string, idempotencyKey: string, status: 'completed' | 'rejected', externalResponse: unknown): Promise<void> {
  // Raw UPDATE (not recordOutcome) because the action-ledger API only models
  // completed/failed; await-approval terminates on completed/approved/rejected.
  await pool.query(
    `UPDATE actions SET status = $1, external_response = $2, completed_at = NOW()
      WHERE idempotency_key = $3 AND tenant_id = $4`,
    [status, JSON.stringify(externalResponse ?? null), idempotencyKey, tenantId],
  );
}

/** Operator approved a sandbox-code call: execute the connector and settle the
 *  pending action with the result so the blocked script resumes. */
export async function executeSandboxApprovedCall(approval: HitlApprovalRequest): Promise<void> {
  const call = approval.pendingToolCalls?.[0];
  const idempotencyKey = approval.idempotencyKey;
  if (!call || !idempotencyKey) {
    log.warn({ approvalId: approval.id }, 'sandbox approval missing tool call / idempotency key — cannot execute');
    return;
  }
  const toolName = call.name;
  // The reviewer's version if they rewrote one, otherwise the script's own.
  // A sandbox call is dispatched from this row rather than replayed through a
  // resumed session, so this is the only place the substitution can happen.
  const [approved] = applyApprovedEdits([call], approval.editedToolInputs);
  const args = (approved.input ?? {}) as Record<string, unknown>;
  let externalResponse: unknown;
  try {
    const bindingsByType = await resolveBindings(approval.tenantId, approval.agentId);
    const input = {
      tenantId: approval.tenantId,
      agentId: approval.agentId,
      instructionVersion: 0,
      traceId: `sandbox-approve-${approval.id}`,
      idempotencyKey,
      connector: extractConnectorAlias(toolName),
      entityType: 'default',
      actionType: toolName,
      payload: args,
      estimatedCredits: 1,
      bindingsByType,
    };
    const gateway = toolGatewayService as unknown as { executeConnectorCall: (_i: typeof input) => Promise<{ success: boolean; data?: unknown; error?: string }> };
    const result = await gateway.executeConnectorCall(input);
    externalResponse = result.success ? (result.data ?? null) : { success: false, error: result.error };
  } catch (err) {
    externalResponse = { success: false, error: (err as Error).message };
  }
  await settleAction(approval.tenantId, idempotencyKey, 'completed', externalResponse);
  log.info({ approvalId: approval.id, tool: toolName }, 'sandbox-code approval executed server-side');
}

/** Operator rejected a sandbox-code call: settle the pending action as rejected. */
export async function rejectSandboxApprovedCall(approval: HitlApprovalRequest, reason: string): Promise<void> {
  if (!approval.idempotencyKey) return;
  await settleAction(approval.tenantId, approval.idempotencyKey, 'rejected', { reason });
  log.info({ approvalId: approval.id }, 'sandbox-code approval rejected');
}

/**
 * Hygiene sweep: flip un-decided sandbox-code approvals past their TTL
 * (hitl_approval_requests.expires_at, default NOW()+24h) to 'expired' and settle
 * their pending actions, so /dashboard/review doesn't accumulate dead rows.
 * The SDK's await-approval timeout already unblocks the script; this is DB
 * cleanup only. Unlike LLM approvals (expired via agent_scheduled_invocations
 * 'hitl-expiry' tasks), sandbox approvals arm no such task, so they need this.
 */
export async function expireStaleSandboxApprovals(): Promise<number> {
  const expired = await pool.query<{ idempotency_key: string | null; tenant_id: string }>(
    `UPDATE hitl_approval_requests
        SET status = 'expired', updated_at = NOW()
      WHERE source = 'sandbox_code' AND status = 'pending' AND expires_at < NOW()
      RETURNING idempotency_key, tenant_id`,
  );
  for (const row of expired.rows) {
    if (!row.idempotency_key) continue;
    await settleAction(row.tenant_id, row.idempotency_key, 'rejected', { reason: 'expired' });
  }
  if (expired.rowCount) log.info({ count: expired.rowCount }, 'expired stale sandbox-code approvals');
  return expired.rowCount ?? 0;
}
