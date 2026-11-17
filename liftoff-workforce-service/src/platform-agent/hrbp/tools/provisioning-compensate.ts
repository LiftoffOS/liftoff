// Tool: provisioning__compensate
//
// Soft-deletes a previously-created agent and records the rollback action in
// hrbp_compensation_log. Used when a downstream failure requires rolling back
// a partial provisioning state.

import { getPool } from '../../../infrastructure/database.js';
import { loadConfig } from '../../../infrastructure/config.js';
import { getServiceAuthHeaders } from '../../../infrastructure/service-auth.js';
import type { LLMToolDefinition } from '../../../llm/types.js';
import type { HrbpToolContext } from '../types.js';

export const PROVISIONING_COMPENSATE_TOOL: LLMToolDefinition = {
  name: 'provisioning__compensate',
  description:
    'Soft-delete an agent previously created during this spec. ' +
    'Use this when a downstream step fails and the agent must be rolled back.',
  input_schema: {
    type: 'object',
    properties: {
      internalAgentId: { type: 'string', description: 'The agent UUID to soft-delete.' },
      reason:          { type: 'string', description: 'Why compensation is needed (audit trail).' },
    },
    required: ['internalAgentId', 'reason'],
  },
};

export async function handleProvisioningCompensate(
  input: Record<string, unknown>,
  ctx: HrbpToolContext,
): Promise<{ ok: boolean; data: unknown }> {
  const internalAgentId = input.internalAgentId as string;
  const pool = getPool();

  // Record intent first so the rollback is durable even if the HTTP call
  // crashes the process. Status starts as `pending` and is bumped to
  // `completed`/`failed` after the delete returns.
  const intent = await pool.query<{ id: string }>(
    `INSERT INTO hrbp_compensation_log
       (run_id, plan_id, tenant_id, spec_id, action, internal_agent_id, status)
     VALUES ($1, $2, $3, $4, 'delete_agent', $5, 'pending')
     RETURNING id`,
    [ctx.runId, ctx.planId, ctx.tenantId, ctx.specId, internalAgentId],
  );
  const compensationId = intent.rows[0].id;

  const pbUrl = loadConfig().PLATFORM_BACKEND_URL.replace(/\/$/, '');
  const authHeaders = await getServiceAuthHeaders(pbUrl, loadConfig().WORKFORCE_SERVICE_TOKEN);
  // _svc/:id — service-auth path, before authMiddleware on PB.
  const response = await fetch(
    `${pbUrl}/api/internal-agents/_svc/${internalAgentId}?tenantId=${encodeURIComponent(ctx.tenantId)}`,
    { method: 'DELETE', headers: authHeaders },
  );
  if (!response.ok && response.status !== 404) {
    const body = await response.text().catch(() => '');
    await pool.query(
      `UPDATE hrbp_compensation_log SET status='failed', error_message=$2 WHERE id=$1`,
      [compensationId, `HTTP ${response.status}: ${body.slice(0, 400)}`],
    );
    return {
      ok: false,
      data: { error: `compensate failed: HTTP ${response.status}`, body: body.slice(0, 400) },
    };
  }

  await pool.query(
    `UPDATE hrbp_compensation_log SET status='completed' WHERE id=$1`,
    [compensationId],
  );
  return { ok: true, data: { compensated: internalAgentId } };
}
