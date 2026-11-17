// Performance Tracker
// Computes and stores per-agent performance metrics over time.
//
// AUTONOMY — read this before changing the query below.
//
// The figure means "tasks this agent completed without needing a person". It was
// computed as `(total - gated) / total` from TWO independent queries: a
// denominator over `invocations` and a numerator over `hitl_approval_requests`.
// Nothing tied the two populations together, so the numerator could exceed the
// denominator three separate ways — a run that started before the window raising
// an approval inside it, an in-flight run (outcome IS NULL) excluded from the
// denominator while its approvals counted, and nothing constraining the approvals
// to runs in the denominator set at all. A `Math.max(0, …)` guard sat on top of
// that, load-bearing, hiding it.
//
// The numerator is now computed INSIDE the denominator's query as a FILTER over
// the same rows, so numerator ⊆ denominator by construction and the guard is
// gone rather than kept.
//
// It also counts the right thing. `hitl_approval_requests` holds only approval
// GATES; a run that stopped to ask a person a question writes `threads`,
// `messages` and an `agent_scheduled_invocations` row with
// `pauseReason: 'ask_user'` and NO approval row, so it used to score as fully
// autonomous. Both pause kinds land in `agent_scheduled_invocations` carrying
// `scheduled_by_invocation_id`, which is the one table that sees both.
//
// NOT covered, deliberately: sandbox connector approvals are created with
// `invocation_id: null` by design (internal-api/sandbox-mcp-router.ts — "sandbox
// connector calls carry no invocation context"). They are real human
// involvement, but they belong to no task, so they cannot enter a PER-TASK rate
// without breaking the containment above. They stay counted in the approval
// figures behind `correctionRate` rather than being dropped silently.

import { getPoolForService } from '../infrastructure/database';

export interface AgentPerformanceSnapshot {
  agentId: string;
  periodStart: Date;
  periodEnd: Date;
  successRate: number;
  /** NULL means "unknown", not zero. An agent with no finished runs in the
   *  window has no autonomy rate; recording 0 for it would read as complete
   *  dependence on a person, which is a claim the data does not make. */
  autonomyRate: number | null;
  escalationRate: number;
  correctionRate: number;
  avgCostPerInvocation: number;
  avgDurationMs: number;
  memoryCount: number;
  invocationCount: number;
}

export async function computePerformanceSnapshot(
  tenantId: string,
  agentId: string,
  periodStart: Date,
  periodEnd: Date
): Promise<AgentPerformanceSnapshot> {
  const pool = getPoolForService('reflection-engine');

  // Invocation stats + the autonomy numerator, from ONE pass over ONE population.
  //
  // `scheduled_by_invocation_id` is TEXT while `invocations.id` is UUID, so both
  // sides are cast rather than relying on an implicit coercion that does not exist.
  //
  // One invocation can hold SEVERAL pause rows — re-parking an unanswered ask is
  // by design (see clarification-storage.ts) — so this asks EXISTS rather than
  // counting rows: a task that had to stop for a person three times is one task
  // that needed a person, not three.
  //
  // No status filter on the pause row, and that is a decision rather than an
  // omission: an ask that expired with nobody answering still stopped the run and
  // still required a person. What this measures is "did this task need a human",
  // not "did a human turn up".
  const invResult = await pool.query(
    `SELECT
       COUNT(*) as total,
       COUNT(*) FILTER (WHERE i.outcome = 'success') as successes,
       COUNT(*) FILTER (WHERE i.outcome = 'escalated') as escalations,
       COUNT(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM agent_scheduled_invocations a
          WHERE a.scheduled_by_invocation_id::text = i.id::text
            AND a.workflow_resume_payload->>'pauseReason' IN ('hitl_approval','ask_user')
       )) AS tasks_needing_a_person,
       AVG(EXTRACT(EPOCH FROM (i.completed_at - i.started_at)) * 1000) as avg_duration_ms,
       AVG((i.input_tokens * COALESCE(i.input_price_per_million, 0) + i.output_tokens * COALESCE(i.output_price_per_million, 0)) / 1000000.0) as avg_cost
     FROM invocations i
     WHERE i.tenant_id = $1 AND i.agent_id = $2
       AND i.started_at >= $3 AND i.started_at < $4
       AND i.outcome IS NOT NULL`,
    [tenantId, agentId, periodStart.toISOString(), periodEnd.toISOString()]
  );

  const inv = invResult.rows[0];
  const total = parseInt(inv.total) || 0;
  const successes = parseInt(inv.successes) || 0;
  const escalations = parseInt(inv.escalations) || 0;
  const tasksNeedingAPerson = parseInt(inv.tasks_needing_a_person) || 0;

  // Approval decisions, for the rejection rate below.
  //
  // `decided` is the count of requests a person actually ANSWERED. The
  // denominator used to be every request raised, including the ones that expired
  // unanswered (`hitl_approval_requests.status` admits 'expired', and
  // `expire_stale_approvals()` flips pending rows past a 24h `expires_at`) and
  // the ones still pending — so a team whose approvals mostly time out read as
  // RARELY corrected, which is the opposite of what happened to it.
  //
  // Sandbox connector approvals (invocation_id IS NULL) are included here. They
  // are the class of human involvement a per-task rate cannot represent, and this
  // is where they stay visible.
  const hitlResult = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE decision IS NOT NULL) AS decided,
       COUNT(*) FILTER (WHERE decision = 'rejected') AS rejected
     FROM hitl_approval_requests
     WHERE tenant_id = $1 AND agent_id = $2
       AND created_at >= $3 AND created_at < $4`,
    [tenantId, agentId, periodStart.toISOString(), periodEnd.toISOString()]
  );
  const decided = parseInt(hitlResult.rows[0]?.decided) || 0;
  const rejected = parseInt(hitlResult.rows[0]?.rejected) || 0;

  // Memory count
  const memResult = await pool.query(
    `SELECT COUNT(*) as count FROM memories
     WHERE tenant_id = $1 AND agent_id = $2 AND layer = 'individual'
       AND superseded_by IS NULL AND (expires_at IS NULL OR expires_at > NOW())`,
    [tenantId, agentId]
  );
  const memoryCount = parseInt(memResult.rows[0]?.count) || 0;

  return {
    agentId,
    periodStart,
    periodEnd,
    successRate: total > 0 ? successes / total : 0,
    // Containment holds by construction now (tasksNeedingAPerson counts a subset
    // of the same rows `total` counts), so there is no Math.max guard here — a
    // negative would be a bug in the SQL and must not be clamped out of sight.
    autonomyRate: total > 0 ? (total - tasksNeedingAPerson) / total : null,
    escalationRate: total > 0 ? escalations / total : 0,
    // A rejection rate over DECIDED approval requests. Note this is not the
    // "comes back for a redo" measurement that joins agent_audit_logs.correction_of
    // — two different numbers have been called "correction rate", and this is the
    // approvals one.
    correctionRate: decided > 0 ? rejected / decided : 0,
    avgCostPerInvocation: parseFloat(inv.avg_cost) || 0,
    avgDurationMs: parseFloat(inv.avg_duration_ms) || 0,
    memoryCount,
    invocationCount: total,
  };
}

/** Persist one snapshot. `autonomy_rate` is nullable as of migration 374 — before
 *  it, a null bound here raised a not-null violation, the weekly cron caught it
 *  PER AGENT (internal-cron-handler `performance-snapshot-tick`) and logged a
 *  warning, so the agents whose autonomy is unknown would have quietly stopped
 *  getting snapshots at all. */
export async function savePerformanceSnapshot(
  tenantId: string,
  snapshot: AgentPerformanceSnapshot
): Promise<void> {
  const pool = getPoolForService('reflection-engine');
  await pool.query(
    `INSERT INTO agent_performance_snapshots (
       tenant_id, agent_id, period_start, period_end,
       success_rate, autonomy_rate, escalation_rate, correction_rate,
       avg_cost_per_invocation, avg_duration_ms, memory_count, invocation_count
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (tenant_id, agent_id, period_start) DO UPDATE SET
       success_rate = EXCLUDED.success_rate,
       autonomy_rate = EXCLUDED.autonomy_rate,
       escalation_rate = EXCLUDED.escalation_rate,
       correction_rate = EXCLUDED.correction_rate,
       avg_cost_per_invocation = EXCLUDED.avg_cost_per_invocation,
       avg_duration_ms = EXCLUDED.avg_duration_ms,
       memory_count = EXCLUDED.memory_count,
       invocation_count = EXCLUDED.invocation_count`,
    [
      tenantId, snapshot.agentId, snapshot.periodStart.toISOString(), snapshot.periodEnd.toISOString(),
      snapshot.successRate, snapshot.autonomyRate, snapshot.escalationRate, snapshot.correctionRate,
      snapshot.avgCostPerInvocation, snapshot.avgDurationMs, snapshot.memoryCount, snapshot.invocationCount,
    ]
  );
}
