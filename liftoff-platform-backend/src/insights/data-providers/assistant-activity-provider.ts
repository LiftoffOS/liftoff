import { withTenantScope } from '../../infrastructure/database';
import { log } from '../../infrastructure/logging';
import { assistantForPurpose, type AssistantKey } from '../platform-assistants';
import type { TimeRange, TimeGrouping } from '../types';

export interface AssistantActivity {
  assistant: AssistantKey;
  /** Units of work this assistant performed in the window. */
  actionCount: number;
  /** The same count per time bucket, for the Task Volume trend. */
  timeBreakdown: Array<{ date: string; count: number }>;
}

function groupByExpr(grouping: TimeGrouping): string {
  switch (grouping) {
    case 'hour':  return `DATE_TRUNC('hour', occurred_at)`;
    case 'day':   return `DATE(occurred_at)`;
    case 'month': return `DATE_TRUNC('month', occurred_at)`;
  }
}

/**
 * What each platform assistant did, for the AI Workforce Activity chart.
 *
 * Without this provider the three assistants would be absent from every
 * activity surface, and not by a filter that could be relaxed:
 * `getAuditLogAggregation` builds its list from
 * `internal_agents UNION external_agents`, and an assistant has a row in
 * neither table — that is what makes it a platform assistant. They also write
 * no audit rows at all, so the chart, `Task Volume` and `Tasks Completed`
 * would all read as though the assistants had done nothing.
 *
 * WHAT IS COUNTED, and why it is not turns. A model call is the unit here, not
 * a conversational turn, because the ledger is the only place in THIS database
 * that records all three. Liftoff's and the Insights Manager's messages are
 * local tables, but the Chief AI Officer's conversation lives in
 * workforce-service's own database and `listTeamPlanThreads` carries no
 * message counts — counting turns would mean either a new cross-service
 * endpoint or counting two assistants and omitting the third, which is the
 * defect this fixes, one size smaller. It also catches the Insights Manager's
 * page-load work (`insights_intro`, `insights_observation`), which produces no
 * message at all and is still work the assistant did.
 *
 * So an agent's bar counts audit actions and an assistant's counts model
 * calls. Both are units of work performed; they are not the same unit, and no
 * common one exists without the cross-service endpoint above. Stated here
 * rather than left for a reader to infer from a chart.
 *
 * NO cost_bucket filter, deliberately. This asks what an assistant DID, not
 * what it cost. An absorbed purpose is still work — the Insights Manager's
 * intro is absorbed and the platform eats it, and it still ran. Filtering by
 * bucket here would make the chart move when a pricing policy changed, which
 * is the one thing an activity chart must not do.
 */
export async function getAssistantActivity(
  tenantId: string,
  range: TimeRange,
  grouping: TimeGrouping = 'day',
): Promise<AssistantActivity[]> {
  const groupExpr = groupByExpr(grouping);
  try {
    const { rows } = await withTenantScope(tenantId, (client) => client.query<{
      purpose: string | null; date: string; count: string;
    }>(
      `SELECT purpose, ${groupExpr} AS date, COUNT(*) AS count
       FROM cost_attribution_events
       WHERE tenant_id   = $1
         AND occurred_at >= $2
         AND occurred_at <  $3
         AND source       = 'platform_llm'
         AND event_type   = 'llm_invocation'
         AND agent_id     IS NULL
         AND purpose      IS NOT NULL
       GROUP BY purpose, ${groupExpr}
       ORDER BY date ASC`,
      [tenantId, range.start, range.end],
    ));

    // Fold to one entry per assistant. Several purposes map to the same one
    // (a chat turn, its rolling summary, its title), and a purpose that maps
    // to no assistant is platform work rather than an assistant's, so it is
    // dropped here rather than attributed to whichever name is closest.
    const byAssistant = new Map<AssistantKey, Map<string, number>>();
    for (const row of rows) {
      const assistant = assistantForPurpose(row.purpose);
      if (!assistant) continue;
      const buckets = byAssistant.get(assistant) ?? new Map<string, number>();
      const date = new Date(row.date).toISOString();
      buckets.set(date, (buckets.get(date) ?? 0) + (parseInt(row.count) || 0));
      byAssistant.set(assistant, buckets);
    }

    return [...byAssistant.entries()].map(([assistant, buckets]) => ({
      assistant,
      actionCount: [...buckets.values()].reduce((sum, n) => sum + n, 0),
      timeBreakdown: [...buckets.entries()]
        .map(([date, count]) => ({ date, count }))
        .sort((a, b) => a.date.localeCompare(b.date)),
    }));
  } catch (error) {
    log.error({ tenantId, error: (error as Error).message }, 'Failed to fetch assistant activity');
    return [];
  }
}
