// Tool: provisioning__update_spec_status
//
// Mutates workforce_plans.agents JSONB to mark this spec's
// provisioningStatus as completed/failed/skipped. Used at the end of a
// successful provision and after compensation.

import { withTenantContext } from '../../../infrastructure/rls.js';
import type { LLMToolDefinition } from '../../../llm/types.js';
import type { HrbpToolContext } from '../types.js';

export const PROVISIONING_UPDATE_SPEC_STATUS_TOOL: LLMToolDefinition = {
  name: 'provisioning__update_spec_status',
  description:
    'Mark the current spec as completed, failed, or skipped on its parent workforce_plans row. ' +
    'internalAgentId is required for "completed".',
  input_schema: {
    type: 'object',
    properties: {
      status:          { type: 'string', enum: ['completed', 'failed', 'skipped'] },
      internalAgentId: { type: 'string', description: 'The agent UUID; required for "completed".' },
      errorMessage:    { type: 'string', description: 'Why the spec failed (for status=failed).' },
    },
    required: ['status'],
  },
};

export async function handleProvisioningUpdateSpecStatus(
  input: Record<string, unknown>,
  ctx: HrbpToolContext,
): Promise<{ ok: boolean; data: unknown }> {
  const status = input.status as 'completed' | 'failed' | 'skipped';
  const internalAgentId = input.internalAgentId as string | undefined;
  const errorMessage = input.errorMessage as string | undefined;

  if (status === 'completed' && !internalAgentId) {
    return { ok: false, data: { error: 'internalAgentId is required when status=completed' } };
  }

  // workforce_plans is RLS-protected (migration 012). The policy reads
  // app.current_tenant_id, so we must run under withTenantContext — otherwise
  // the policy's `current_setting(...)::uuid` cast on an empty string throws
  // "invalid input syntax for type uuid: \"\"" and the whole transaction
  // aborts before the SELECT even completes.
  //
  // withTenantContext handles BEGIN/COMMIT/ROLLBACK around fn; the read-
  // modify-write below stays inside that single transaction, so concurrent
  // HRBP runs on the same plan still serialize via FOR UPDATE.
  return withTenantContext(ctx.tenantId, async (client) => {
    const { rows } = await client.query<{ agents: unknown[] }>(
      `SELECT agents FROM workforce_plans WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [ctx.planId, ctx.tenantId],
    );
    if (rows.length === 0) {
      return { ok: false, data: { error: 'plan not found' } };
    }
    const agents = (rows[0].agents as Array<Record<string, unknown>>) ?? [];
    const idx = agents.findIndex((a) => a.specId === ctx.specId);
    if (idx === -1) {
      return { ok: false, data: { error: 'spec not found in plan' } };
    }
    agents[idx] = {
      ...agents[idx],
      provisioningStatus: status,
      ...(internalAgentId ? { internalAgentId } : {}),
      ...(errorMessage ? { errorMessage } : {}),
    };

    await client.query(
      `UPDATE workforce_plans SET agents = $1::jsonb, updated_at = NOW() WHERE id = $2`,
      [JSON.stringify(agents), ctx.planId],
    );

    // The caller uses this to decide whether the plan itself is now terminal.
    // Nothing else can: each spec runs in its own task, so only the write that
    // lands last knows the plan is done.
    return {
      ok: true,
      data: { status, specId: ctx.specId, planStatus: rollUpPlanStatus(agents) },
    };
  });
}

const TERMINAL_SPEC_STATUSES = new Set(['completed', 'failed', 'skipped']);

/**
 * The plan's status once every spec is terminal, or null while any spec is
 * still outstanding.
 *
 * A plan is `completed` only if no spec failed. One failed spec makes the whole
 * plan `failed`: a team missing a member is not the team that was asked for,
 * even though the agents that did land stay live.
 */
export function rollUpPlanStatus(
  agents: Array<Record<string, unknown>>,
): 'completed' | 'failed' | null {
  if (agents.length === 0) return null;

  for (const spec of agents) {
    const specStatus = (spec.provisioningStatus as string | undefined) ?? 'pending';
    if (!TERMINAL_SPEC_STATUSES.has(specStatus)) return null;
  }
  return agents.some(s => s.provisioningStatus === 'failed') ? 'failed' : 'completed';
}
