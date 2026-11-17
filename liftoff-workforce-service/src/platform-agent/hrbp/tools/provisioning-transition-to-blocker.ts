// Tool: provisioning__transition_to_blocker
//
// Marks the current spec as blocked on workforce_plans.agents, writes a
// hrbp.spec_blocked audit log, and throws HrbpBlockerException. The
// runPlatformAgent loop catches the exception as a graceful terminator
// (terminator='tool_blocker'). CAIO surfaces the blocker to the user on
// the next chat turn.

import { withTenantContext } from '../../../infrastructure/rls.js';
import type { LLMToolDefinition } from '../../../llm/types.js';
import { HrbpBlockerException } from '../../types.js';
import { writeAgentAuditLog } from '../../audit-log-writer.js';
import type { HrbpToolContext } from '../types.js';
import { HRBP_AGENT_ID } from '../../system-agent-ids.js';

export const PROVISIONING_TRANSITION_TO_BLOCKER_TOOL: LLMToolDefinition = {
  name: 'provisioning__transition_to_blocker',
  description:
    'Mark this spec as blocked because human input is needed (e.g. name collision, ' +
    'connector type not supported, validation rejection). Terminates the loop for this spec.',
  input_schema: {
    type: 'object',
    properties: {
      reason:   { type: 'string', description: 'Short blocker reason (e.g. "name_collision").' },
      detail:   { type: 'string', description: 'User-facing one-line explanation.' },
      options:  {
        type: 'array',
        items: { type: 'string' },
        description: 'Suggested actions for CAIO to present to the user.',
      },
    },
    required: ['reason', 'detail'],
  },
};

export async function handleProvisioningTransitionToBlocker(
  input: Record<string, unknown>,
  ctx: HrbpToolContext,
): Promise<{ ok: boolean; data: unknown }> {
  const reason = input.reason as string;
  const detail = input.detail as string;
  const options = (input.options as string[] | undefined) ?? [];

  // workforce_plans is RLS-protected (migration 012). Run under
  // withTenantContext so the policy's app.current_tenant_id::uuid cast
  // succeeds; without it the SELECT throws on an empty UUID before the
  // read-modify-write even starts.
  try {
    await withTenantContext(ctx.tenantId, async (client) => {
      const { rows } = await client.query<{ agents: unknown[] }>(
        `SELECT agents FROM workforce_plans WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
        [ctx.planId, ctx.tenantId],
      );
      if (rows.length === 0) return;
      const agents = (rows[0].agents as Array<Record<string, unknown>>) ?? [];
      const idx = agents.findIndex((a) => a.specId === ctx.specId);
      if (idx === -1) return;
      agents[idx] = {
        ...agents[idx],
        provisioningStatus: 'blocked',
        blockerReason: reason,
        blockerDetail: detail,
        blockerOptions: options,
      };
      await client.query(
        `UPDATE workforce_plans SET agents = $1::jsonb, updated_at = NOW() WHERE id = $2`,
        [JSON.stringify(agents), ctx.planId],
      );
    });
  } catch {
    // DB persistence is best-effort — fall through to the audit log + throw
    // so the run still terminates cleanly with the blocker semantics.
  }

  await writeAgentAuditLog({
    tenantId: ctx.tenantId,
    internalAgentId: HRBP_AGENT_ID,
    action: 'hrbp.spec_blocked',
    inputArgs: { planId: ctx.planId, specId: ctx.specId, reason, detail, options },
    outputSummary: detail,
    outcome: 'gated',
    triggeredBy: 'agent',
  });

  throw new HrbpBlockerException(reason, detail);
}
