// Archive an agent: the dashboard's DELETE /:id body, lifted out. Member
// and above (D1); the audit row carries the person and the surface.

import { pool } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import { internalAgentService } from '../internal-agents/service';
import { updateAgentQuantity } from '../billing/subscription-items-service';
import { requirePermission, type Actor } from './actor';
import { writeAudit } from './audit';

export type TeamArchiveResult = { archived: true } | { refused: 'not_found'; message: string };

export async function archiveTeam(actor: Actor, agentId: string): Promise<TeamArchiveResult> {
  requirePermission(actor, 'teams:delete');
  const { tenantId } = actor;

  const deleted = await internalAgentService.delete(agentId, tenantId, actor.accountId);
  if (!deleted) {
    return { refused: 'not_found', message: 'agent not found' };
  }

  writeAudit(actor, 'internal_agent.deleted', {
    internalAgentId: agentId,
    tenantId,
  });

  // Event publish is owned by InternalAgentService.delete (shape-3 canonical
  // pattern per plan §5.4) — soft-delete UPDATE + outbox commit in one tx.

  // Phase 3: A deleted agent may have been active — update Stripe quantity.
  const tenantRow = await pool.query<{ account_id: string }>(
    `SELECT account_id FROM tenants WHERE id = $1`,
    [tenantId],
  );
  const deletedAgentAccountId = tenantRow.rows[0]?.account_id;
  if (deletedAgentAccountId) {
    updateAgentQuantity(deletedAgentAccountId).catch((err: Error) =>
      log.warn({ error: err.message, deletedAgentAccountId }, 'billing.phase3: updateAgentQuantity failed on deletion (non-fatal)'),
    );
  }

  return { archived: true };
}
