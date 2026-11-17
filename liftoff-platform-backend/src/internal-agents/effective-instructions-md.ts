// Effective-CLAUDE.md helper
//
// Merges the three layers of CLAUDE.md-style project instructions (tenant,
// workforce plan, agent) into a single markdown string that the backend
// publishes to the tenant runtime as `instructionsMd` at event-publish time.
// The runtime stays dumb about hierarchy: it sees one merged string.
//
// The three layers are:
//   1. tenants.agent_instructions_md         — org-wide policies
//   2. workforce_plans.instructions_md       — plan-level guidance (if agent was provisioned from a plan)
//   3. internal_agents.instructions_md       — agent-specific operational how-to

import { pool, withTenantScope } from '../infrastructure/database';
import type { InternalAgent } from './types';

interface Layer {
  heading: string;
  body: string | null;
}

function renderLayers(layers: Layer[]): string | null {
  const present = layers.filter(l => l.body && l.body.trim().length > 0);
  if (present.length === 0) return null;
  return present.map(l => `# ${l.heading}\n\n${l.body!.trim()}`).join('\n\n');
}

/**
 * Build the effective CLAUDE.md string for an agent by concatenating the
 * tenant, workforce-plan, and agent layers with clear section headers.
 * Returns null when every layer is empty.
 */
export async function buildEffectiveInstructionsMd(
  tenantId: string,
  agent: Pick<InternalAgent, 'id' | 'role' | 'instructionsMd' | 'workforcePlanId'>,
): Promise<string | null> {
  // m131 dropped internal_agents.workforce_plan_id; the linkage now lives on
  // internal_agent_provenance (team-preset provisioning stamps it there). The mapped
  // field is therefore always null now — fall back to the provenance join so the
  // plan layer is populated again for provisioned agents. The provenance table is
  // FORCE-RLS, so the read runs inside withTenantScope.
  let workforcePlanId = agent.workforcePlanId;
  if (!workforcePlanId && agent.id) {
    const prov = await withTenantScope(tenantId, (c) => c.query<{ workforce_plan_id: string | null }>(
      `SELECT workforce_plan_id FROM internal_agent_provenance WHERE agent_id = $1 AND tenant_id = $2`,
      [agent.id, tenantId],
    ));
    workforcePlanId = prov.rows[0]?.workforce_plan_id ?? null;
  }

  // Fetch tenant + plan layers in parallel
  const [tenantRow, planRow] = await Promise.all([
    pool.query<{ agent_instructions_md: string | null }>(
      `SELECT agent_instructions_md FROM tenants WHERE id = $1`,
      [tenantId],
    ),
    workforcePlanId
      ? pool.query<{ title: string | null; instructions_md: string | null }>(
          `SELECT title, instructions_md FROM workforce_plans WHERE id = $1 AND deleted_at IS NULL`,
          [workforcePlanId],
        )
      : Promise.resolve(null),
  ]);

  const tenantMd = tenantRow.rows[0]?.agent_instructions_md ?? null;
  const planTitle = planRow?.rows[0]?.title ?? 'Workforce plan';
  const planMd = planRow?.rows[0]?.instructions_md ?? null;

  return renderLayers([
    { heading: 'Tenant guidelines', body: tenantMd },
    { heading: `Workforce plan: ${planTitle}`, body: planMd },
    { heading: `Agent: ${agent.role}`, body: agent.instructionsMd },
  ]);
}
