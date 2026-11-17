// When a team member speaks up (P1.3).
//
// Exactly one trigger ships here: a tool was just connected to a team member,
// so it can now see something it could watch on a schedule. That is the moment
// a new colleague would say "want me to keep an eye on that?".
//
// Everything is best-effort and silent on failure. A proposal is a nicety; it
// must never interfere with the connection flow that produced it.

import { withTenantScope } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import { createSuggestion, deliverSuggestion, draftIntegrationProposal } from './suggestion-service';

interface AgentSummaryRow {
  id: string;
  role: string;
  responsibilities: string | null;
  status: string;
}

/**
 * Offer a routine after a connector is bound to a team member.
 *
 * Only lands where there is already a conversation: proposals are delivered
 * into the team member's own chat thread, and creating one just to hold an
 * unsolicited message would be the dashboard-nag shape this design rejects.
 */
export async function maybeProposeForNewIntegration(params: {
  tenantId: string;
  agentId: string;
  connectorType: string;
}): Promise<void> {
  const { tenantId, agentId, connectorType } = params;

  try {
    const agent = await withTenantScope(tenantId, async (client) => {
      const res = await client.query<AgentSummaryRow>(
        `SELECT id, role, responsibilities, status
         FROM internal_agents
         WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
        [agentId, tenantId],
      );
      return res.rows[0] ?? null;
    });
    // A paused or draft team member is not doing anything yet; offering it more
    // work would be noise.
    if (!agent || agent.status !== 'active') return;

    // Deliver only into an existing thread. No thread means nobody has talked
    // to this team member yet, and an unprompted first message is not the
    // product we want.
    const threadId = await findMostRecentThreadForAgent(tenantId, agentId);
    if (!threadId) {
      log.info({ tenantId, agentId }, 'suggestions: no existing thread, nothing offered');
      return;
    }

    const draft = await draftIntegrationProposal({
      tenantId,
      agentId,
      agentRole: agent.role,
      responsibilities: agent.responsibilities ?? '',
      connectorType,
    });
    if (!draft) return;

    const suggestion = await createSuggestion({
      tenantId,
      agentId,
      // Keyed on the connector, so connecting the same tool again never
      // re-offers something that was already declined.
      dedupKey: `integration:${connectorType}`,
      source: 'integration',
      proposalText: draft.proposalText,
      routineProse: draft.routineProse,
      provenanceNote: `Suggested because ${connectorType} was connected.`,
    });
    if (!suggestion) return;

    await deliverSuggestion(suggestion, threadId);
  } catch (err) {
    log.warn(
      { tenantId, agentId, connectorType, error: (err as Error).message },
      'suggestions: integration trigger failed (no user impact)',
    );
  }
}

/** The team member's most recently active thread, or null when nobody has
 *  talked to it yet. Soft-deleted threads are excluded — a proposal posted into
 *  a deleted thread would be invisible and would still burn the one-open-
 *  proposal budget. */
export async function findMostRecentThreadForAgent(
  tenantId: string,
  agentId: string,
): Promise<string | null> {
  return withTenantScope(tenantId, async (client) => {
    const res = await client.query<{ id: string }>(
      `SELECT t.id FROM agent_chat_threads t
       INNER JOIN agent_chat_thread_participants p ON p.thread_id = t.id
       WHERE t.tenant_id = $1 AND p.agent_id = $2 AND t.deleted_at IS NULL
       ORDER BY t.updated_at DESC NULLS LAST
       LIMIT 1`,
      [tenantId, agentId],
    );
    return res.rows[0]?.id ?? null;
  });
}
