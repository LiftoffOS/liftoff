// The second proposal trigger: the same thing keeps being asked (P1.3).
//
// The first trigger fires on a moment — a tool was connected. This one fires on
// a pattern: somebody has asked this team member for materially the same thing
// several times, which is the point a good colleague says "shall I just do this
// every Monday?".
//
// Recurrence is measured over the per-turn embeddings that already exist
// (`agent_chat_turns.content_embedding`, migration 295), so nothing new is
// computed or stored to support this. A cluster is a set of turns within a
// tight cosine distance of one representative turn.
//
// Restraint, in the same spirit as the rest of P1.3:
//   * a cluster must be at least MIN_RECURRENCE turns, over distinct days —
//     three messages in one frustrated afternoon is one ask, not a pattern
//   * only asks from the recent window count, so a habit someone dropped
//     months ago does not resurface
//   * the usual one-open-proposal budget and dedup-key latch still apply, so
//     this can never stack on top of an unanswered question

import { withTenantScope } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import { createSuggestion, deliverSuggestion, draftRecurrenceProposal } from './suggestion-service';
import { findMostRecentThreadForAgent } from './suggestion-triggers';

/** How many similar asks make a pattern. Three is the same threshold the
 *  preference consolidation uses, and for the same reason: two can be
 *  coincidence. */
const MIN_RECURRENCE = 3;

/** Cosine distance below which two asks are "the same thing". Tight, because a
 *  loose cluster produces a proposal that matches nothing the person actually
 *  said and reads as the team member not listening. */
const MAX_DISTANCE = 0.18;

/** Only look at recent behaviour. */
const WINDOW_DAYS = 30;

interface ClusterRow {
  representative: string;
  cluster_size: number;
  distinct_days: number;
}

/**
 * Find one recurring ask worth offering to automate, or null.
 *
 * Deliberately returns at most one: the budget allows a single open proposal
 * anyway, and picking the strongest cluster is better than queueing several.
 */
async function findRecurringAsk(
  tenantId: string,
  agentId: string,
): Promise<{ text: string; occurrences: number } | null> {
  const row = await withTenantScope(tenantId, async (client) => {
    const res = await client.query<ClusterRow>(
      // Self-join each turn against the others for this agent and count how
      // many sit within MAX_DISTANCE. The representative is the turn with the
      // largest such neighbourhood.
      //
      // `distinct_days` is what separates a pattern from one bad afternoon.
      `WITH recent AS (
         SELECT t.id, t.created_at, t.content_embedding, m.content
           FROM agent_chat_turns t
           JOIN LATERAL (
             SELECT content FROM agent_chat_messages
              WHERE turn_id = t.id AND role = 'user'
              ORDER BY created_at ASC LIMIT 1
           ) m ON TRUE
          WHERE t.tenant_id = $1
            AND t.agent_id = $2
            AND t.content_embedding IS NOT NULL
            AND t.created_at > NOW() - ($3 || ' days')::interval
       )
       SELECT a.content AS representative,
              COUNT(*)::int AS cluster_size,
              COUNT(DISTINCT b.created_at::date)::int AS distinct_days
         FROM recent a
         JOIN recent b
           ON (a.content_embedding <=> b.content_embedding) <= $4
        GROUP BY a.id, a.content
        HAVING COUNT(*) >= $5 AND COUNT(DISTINCT b.created_at::date) >= $5
        ORDER BY COUNT(*) DESC
        LIMIT 1`,
      [tenantId, agentId, String(WINDOW_DAYS), MAX_DISTANCE, MIN_RECURRENCE],
    );
    return res.rows[0] ?? null;
  });

  if (!row) return null;
  return { text: row.representative, occurrences: row.cluster_size };
}

/**
 * Offer to automate something the person keeps asking for.
 *
 * Called from the periodic sweep. Best-effort and silent on failure: a missed
 * proposal costs nothing, and a noisy one costs trust.
 */
export async function maybeProposeForRecurringAsk(params: {
  tenantId: string;
  agentId: string;
}): Promise<void> {
  const { tenantId, agentId } = params;
  try {
    const agent = await withTenantScope(tenantId, async (client) => {
      const res = await client.query<{ role: string; responsibilities: string | null; status: string }>(
        `SELECT role, responsibilities, status FROM internal_agents
          WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
        [agentId, tenantId],
      );
      return res.rows[0] ?? null;
    });
    if (!agent || agent.status !== 'active') return;

    const recurring = await findRecurringAsk(tenantId, agentId);
    if (!recurring) return;

    const threadId = await findMostRecentThreadForAgent(tenantId, agentId);
    if (!threadId) return;

    const draft = await draftRecurrenceProposal({
      tenantId,
      agentId,
      agentRole: agent.role,
      responsibilities: agent.responsibilities ?? '',
      recurringAsk: recurring.text,
      occurrences: recurring.occurrences,
    });
    if (!draft) return;

    const suggestion = await createSuggestion({
      tenantId,
      agentId,
      // Keyed on the ask itself, so the same recurring request is one proposal
      // however many times the sweep sees it.
      dedupKey: `usage:${recurring.text.trim().toLowerCase().slice(0, 200)}`,
      source: 'usage',
      proposalText: draft.proposalText,
      routineProse: draft.routineProse,
      provenanceNote: `Suggested because this came up ${recurring.occurrences} times recently.`,
    });
    if (!suggestion) return;

    await deliverSuggestion(suggestion, threadId);
    log.info(
      { tenantId, agentId, occurrences: recurring.occurrences },
      'suggestions: offered to automate a recurring ask',
    );
  } catch (err) {
    log.warn(
      { tenantId, agentId, error: (err as Error).message },
      'suggestions: usage trigger failed (no user impact)',
    );
  }
}

/**
 * Sweep every active team member in a tenant. Driven by the maintenance cron.
 *
 * Sequential rather than parallel: this is background work competing with live
 * turns for the same pool, and finishing a minute later costs nobody anything.
 */
export async function runUsageRecurrenceSweep(tenantId: string): Promise<{ scanned: number }> {
  const agents = await withTenantScope(tenantId, async (client) => {
    const res = await client.query<{ id: string }>(
      `SELECT id FROM internal_agents
        WHERE tenant_id = $1 AND deleted_at IS NULL AND status = 'active'`,
      [tenantId],
    );
    return res.rows.map((r) => r.id);
  });

  for (const agentId of agents) {
    await maybeProposeForRecurringAsk({ tenantId, agentId });
  }
  return { scanned: agents.length };
}
