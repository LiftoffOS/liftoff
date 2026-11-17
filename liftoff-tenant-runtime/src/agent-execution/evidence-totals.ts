// Per-agent evidence counters that outlive the rows they came from.
//
// The reflection engine reasons over an agent's all-time history of having been
// corrected by a person (`human_corrections`). That number used to be a live
// COUNT over `workflow_escalations`, which was correct only for as long as
// every row was kept forever. Retention deletes resolved escalations at 30
// days, so the count would have walked downwards as the sweep ran: not a
// storage saving, a quiet rewrite of what the platform believes about an agent.
//
// The standard answer to that shape is to let aggregates outlive rows. These
// counters are stamped at the moment of the event and never re-derived, so
// deleting a row cannot move them. Migration 353 backfills them once, from the
// rows, while they are all still present — the only moment derivation is
// correct.
//
// Both writers are non-fatal by design. A counter that misses an increment is
// wrong by one; an escalation that fails to persist because its bookkeeping
// threw is a run nobody hears about. The row is always the more important half.

import { pool } from '../infrastructure/database';
import { logger } from '../infrastructure/logging';

/** A person resolved an escalation for this agent. */
export async function recordHumanCorrection(tenantId: string, agentId: string): Promise<void> {
  await bump(tenantId, agentId, 'human_corrections');
}

/** An escalation was raised for this agent, whatever its kind or outcome. */
export async function recordEscalationRaised(tenantId: string, agentId: string): Promise<void> {
  await bump(tenantId, agentId, 'escalations_raised');
}

async function bump(
  tenantId: string,
  agentId: string,
  column: 'human_corrections' | 'escalations_raised',
): Promise<void> {
  try {
    // The column name is not interpolated from caller input: it is one of the
    // two literals in the union above, both written here.
    await pool.query(
      `INSERT INTO agent_evidence_totals (tenant_id, agent_id, ${column}, updated_at)
       VALUES ($1, $2, 1, NOW())
       ON CONFLICT (agent_id) DO UPDATE
         SET ${column} = agent_evidence_totals.${column} + 1,
             updated_at = NOW()`,
      [tenantId, agentId],
    );
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, tenantId, agentId, column },
      'Non-fatal: evidence total not incremented',
    );
  }
}
