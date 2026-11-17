// Reflection Engine Repository
// Per Section 5: Lower-priority DB client

import { pool } from '../infrastructure/database';
import { logger } from '../infrastructure/logging';
// The retention window is imported, not repeated: the safety of the windowed
// escalation counts below depends on the two numbers staying in a known
// relationship, and a second copy of the number is how that relationship gets
// broken without anyone noticing.
import { RETENTION_DAYS } from '../agent-execution/escalation-retention';

/** How far back "recent evidence" reaches, for the recency factor.
 *
 *  Named and shared rather than written at the call site, because it is one
 *  half of an invariant: it MUST stay at or below RETENTION_DAYS, or the
 *  windowed escalation counts start missing corrections whose rows retention
 *  has already deleted. One constant means one place to change and one test
 *  guarding the relationship. */
export const EVIDENCE_RECENCY_WINDOW_DAYS = 7;

/** Reflections one AGENT may accrue in a rolling seven days. Applied per agent
 *  since migration 365; it was previously charged to the tenant, so a
 *  seven-agent workspace shared five a week between all of them. */
const WEEKLY_AGENT_RUNS_LIMIT = 5;
import {
  ReflectionSuggestion,
  ReflectionQuota,
  ReflectionContext,
  EvidenceCounts,
  ReflectionTriggerType,
} from './types';

// Phase 5: How far back to pull late-rejection rows when building the
// flaggedFeedback context section. Matches the window used by
// shouldTriggerReflection so the reflection prompt sees the full set of
// flags that caused it to fire.
const FLAGGED_FEEDBACK_CONTEXT_WINDOW_DAYS = 7;

export class ReflectionRepository {
  // Per Section 16: Gather all inputs for reflection
  //
  // Phase 5: accepts an optional triggerFeedbackId. When present, the
  // matching human_feedback row is hoisted to the front of the
  // flaggedFeedback array so the reflection prompt can anchor on it
  // directly instead of guessing from the general humanFeedback dump.
  async gatherReflectionContext(
    agentId: string,
    tenantId?: string,
    triggerFeedbackId?: string,
  ): Promise<ReflectionContext> {
    const [
      instruction,
      workflows,
      tasks,
      escalations,
      undos,
      feedback,
      denials,
      flaggedRecent,
    ] = await Promise.all([
      this.getInstructionVersion(agentId),
      this.getWorkflowSummaries(agentId),
      this.getTaskOutcomes(agentId),
      this.getEscalationHistory(agentId),
      this.getUndoHistory(agentId),
      this.getHumanFeedback(agentId),
      this.getPolicyDenials(agentId),
      this.getFlaggedLateFeedback(agentId, FLAGGED_FEEDBACK_CONTEXT_WINDOW_DAYS),
    ]);

    // Phase 5: If a specific triggering feedback id was provided, hoist it
    // to the front of the flaggedFeedback array. When the row is outside
    // the window (edge case on clock skew / replay), fetch it explicitly
    // so the LLM always has the triggering row available.
    let flaggedFeedback: any[] = flaggedRecent;
    if (triggerFeedbackId) {
      const match = flaggedRecent.find(
        (row: any) =>
          row.feedback_id === triggerFeedbackId || row.id === triggerFeedbackId,
      );
      if (match) {
        flaggedFeedback = [
          match,
          ...flaggedRecent.filter((row: any) => row !== match),
        ];
      } else {
        const explicit = await this.getLateFeedbackByFeedbackId(triggerFeedbackId);
        if (explicit) {
          flaggedFeedback = [explicit, ...flaggedRecent];
        }
      }
    }

    // Phase 8C: Gather performance + audit data if tenantId is provided
    let performanceSnapshot;
    let auditErrorPatterns;
    if (tenantId) {
      try {
         
        const { computePerformanceSnapshot } = require('../learning/performance-tracker');
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        performanceSnapshot = await computePerformanceSnapshot(tenantId, agentId, thirtyDaysAgo, new Date());
      } catch {
        // Performance tracker not available — skip
      }

      try {
        const auditResult = await pool.query(
          `SELECT action, error_code, COUNT(*) as count
           FROM audit_logs
           WHERE tenant_id = $1 AND internal_agent_id = $2
             AND outcome = 'error'
             AND created_at >= NOW() - INTERVAL '30 days'
           GROUP BY action, error_code
           ORDER BY count DESC
           LIMIT 20`,
          [tenantId, agentId]
        );
        auditErrorPatterns = auditResult.rows;
      } catch {
        // Audit query failed — skip
      }
    }

    return {
      instructionVersion: instruction,
      workflowSummaries: workflows,
      taskOutcomes: tasks,
      escalationHistory: escalations,
      undoHistory: undos,
      humanFeedback: feedback,
      policyDenials: denials,
      performanceSnapshot,
      auditErrorPatterns,
      flaggedFeedback,
    };
  }

  /** Returns the id of the row it inserted.
   *
   *  It returned void, and the auto-promote caller passed the literal string
   *  'unknown' in its place — which Postgres rejects as a uuid, so the promote
   *  failed on every single reflection and was swallowed as non-fatal. */
  async saveSuggestion(input: {
    agentId: string;
    suggestion: string;
    evidenceRefs: unknown;
    confidenceScore: number;
    recurrenceScore: number;
    severity: string;
    // Phase 5: trigger type that produced this suggestion. Persisted so
    // the applier can gate auto-apply on flagged_feedback rows.
    triggeredBy?: ReflectionTriggerType | null;
    /** The entity as it was BEFORE the reflection LLM call, plus its hash.
     *
     *  Captured at PLAN time on purpose. The LLM call takes seconds, and an
     *  operator edit landing inside that window is otherwise overwritten with no
     *  trace by a plan built against the pre-edit state. The hash is what the
     *  applier re-checks; before_state is what a revert writes back. */
    beforeState?: unknown;
    baselineHash?: string | null;
    /** The agent's invocation count when this was planned, so the applier can
     *  refuse a suggestion describing behaviour the agent has moved past. */
    trajectoryVersion?: number | null;
    /** What this suggestion expects to improve, and how to tell. The observed
     *  side reuses effective_measure + feedback (migration 063). */
    expectedOutcome?: string | null;
  }): Promise<string> {
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO reflection_suggestions
       (agent_id, suggestion, evidence_refs, confidence_score, recurrence_score, severity, status, triggered_by,
        before_state, baseline_hash, trajectory_version, expected_outcome)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8::jsonb, $9, $10, $11)
       RETURNING id`,
      [
        input.agentId,
        input.suggestion,
        JSON.stringify(input.evidenceRefs),
        input.confidenceScore,
        input.recurrenceScore,
        input.severity,
        input.triggeredBy ?? null,
        input.beforeState === undefined ? null : JSON.stringify(input.beforeState),
        input.baselineHash ?? null,
        input.trajectoryVersion ?? null,
        input.expectedOutcome ?? null,
      ]
    );
    return inserted.rows[0].id;
  }

  /** Write `before_state` back through the caller's own update path.
   *
   *  Returns the two snapshots rather than performing the write itself: a revert
   *  has to go through `service.update`'s provenance merge like any other write,
   *  or the revert could itself violate the provenance rules the merge exists to
   *  enforce. This supplies the material; the caller applies it correctly. */
  async getRevertMaterial(suggestionId: string): Promise<{
    agentId: string;
    beforeState: unknown;
    afterState: unknown;
    appliedAt: Date | null;
  } | null> {
    const r = await pool.query(
      `SELECT agent_id, before_state, after_state, applied_at
         FROM reflection_suggestions
        WHERE id = $1 AND status = 'accepted'`,
      [suggestionId],
    );
    if (r.rows.length === 0) return null;
    const row = r.rows[0];
    if (row.before_state == null) return null;
    return {
      agentId: row.agent_id as string,
      beforeState: row.before_state,
      afterState: row.after_state,
      appliedAt: row.applied_at as Date | null,
    };
  }

  /** Suggestions applied long enough ago to be judged, and not yet judged.
   *  Read by the outcome-closure job. */
  async getSuggestionsAwaitingOutcome(olderThanHours: number, limit = 50): Promise<Array<{
    id: string;
    agentId: string;
    expectedOutcome: string | null;
    appliedAt: Date;
  }>> {
    const r = await pool.query(
      `SELECT id, agent_id, expected_outcome, applied_at
         FROM reflection_suggestions
        WHERE status = 'accepted'
          AND applied_at IS NOT NULL
          AND applied_at < NOW() - ($1 || ' hours')::interval
          AND effective_measure IS NULL
        ORDER BY applied_at ASC
        LIMIT $2`,
      [String(olderThanHours), limit],
    );
    return r.rows.map((row) => ({
      id: row.id as string,
      agentId: row.agent_id as string,
      expectedOutcome: (row.expected_outcome as string | null) ?? null,
      appliedAt: row.applied_at as Date,
    }));
  }

  async getSuggestions(agentId: string): Promise<ReflectionSuggestion[]> {
    const result = await pool.query(
      `SELECT * FROM reflection_suggestions WHERE agent_id = $1 ORDER BY created_at DESC`,
      [agentId]
    );
    return result.rows.map(this.mapSuggestion);
  }

  /** Quota for a tenant, and for one agent's weekly allowance when an agentId
   *  is given.
   *
   *  ROLLS ITS OWN WINDOWS. `resetDailyQuotas` / `resetWeeklyQuotas` exist and
   *  have never had a caller — no cron route, no scheduler job, anywhere — so
   *  the counters only ever went up and a workspace that reached its limit was
   *  blocked from reflecting permanently. Rolling the window on READ makes the
   *  number correct whether or not anything scheduled ran, which is the
   *  property a reset job could not provide: a missing job is invisible, and
   *  this one was missing from the start.
   *
   *  The weekly allowance is PER AGENT (migration 365). It was previously
   *  incremented on the tenant row despite its name and despite taking an
   *  agentId, so one workspace shared five reflections a week across every
   *  agent it had. */
  async getQuotaStatus(tenantId: string, agentId?: string): Promise<ReflectionQuota> {
    // Roll the daily window forward before reading it. Conditional on the
    // stored window so concurrent readers converge on the same answer rather
    // than each zeroing the counter.
    await pool.query(
      `UPDATE reflection_quotas
          SET daily_runs_used = 0,
              daily_window_started_at = NOW(),
              last_reset_at = NOW()
        WHERE tenant_id = $1
          AND daily_window_started_at < NOW() - INTERVAL '1 day'`,
      [tenantId],
    );

    const result = await pool.query(
      `SELECT * FROM reflection_quotas WHERE tenant_id = $1`,
      [tenantId]
    );

    const row = result.rows[0] || {};

    const weeklyLimit = row.weekly_agent_runs_limit || WEEKLY_AGENT_RUNS_LIMIT;
    let weeklyUsed = 0;
    if (agentId) {
      await pool.query(
        `UPDATE reflection_agent_quotas
            SET weekly_runs_used = 0, window_started_at = NOW()
          WHERE agent_id = $1
            AND window_started_at < NOW() - INTERVAL '7 days'`,
        [agentId],
      );
      const agentRow = await pool.query<{ weekly_runs_used: number }>(
        `SELECT weekly_runs_used FROM reflection_agent_quotas WHERE agent_id = $1`,
        [agentId],
      );
      weeklyUsed = agentRow.rows[0]?.weekly_runs_used ?? 0;
    }

    return {
      tenantId,
      dailyRunsLimit: row.daily_runs_limit || 10,
      dailyRunsUsed: row.daily_runs_used || 0,
      dailyRunsRemaining: (row.daily_runs_limit || 10) - (row.daily_runs_used || 0),
      weeklyAgentRunsLimit: weeklyLimit,
      weeklyAgentRunsUsed: weeklyUsed,
      weeklyAgentRunsRemaining: weeklyLimit - weeklyUsed,
      maxConcurrentJobs: row.max_concurrent_jobs || 3,
      currentConcurrentJobs: row.current_concurrent_jobs || 0,
      concurrentJobsRemaining: (row.max_concurrent_jobs || 3) - (row.current_concurrent_jobs || 0),
    };
  }

  async getEvidenceCounts(agentId: string): Promise<EvidenceCounts> {
    // Counted from `invocations`, the record of a run under the current
    // architecture. Not `workflow_tasks`: the coordinator/leased-queue model it
    // was built for (migration 001) was replaced by runAgentHybridLoop at
    // ADR-002's F-5 cutover, and its only inserter is escalation-helper, which
    // hardcodes status='escalated'. Counted from it, both counters are
    // structurally zero against thresholds of 3 and 50.
    //
    // WINDOWED, deliberately. An all-time count against a fixed threshold is a
    // LATCH, not a trigger: cross it once and it stays true on every subsequent
    // run forever. With real data, any established agent would cross an
    // all-time threshold almost at once. So `failures` asks about a recent window, and
    // `successfulRuns` asks how many have accrued SINCE THE LAST REFLECTION,
    // which is what "reflect after N successful runs" means as a cadence.
    const result = await pool.query(
      `SELECT
        (SELECT COUNT(*) FROM invocations
          WHERE agent_id = $1 AND outcome = 'error'
            AND started_at > NOW() - INTERVAL '1 day' * $2) as failures,
        -- All-time, and therefore read from the counter rather than the rows:
        -- retention deletes resolved escalations at 30 days, and counting them
        -- live would walk this number down as they go. The counter is stamped
        -- when the correction happens, so deleting a row cannot move it
        -- (migration 353). COALESCE covers an agent that has never had one.
        (SELECT COALESCE(human_corrections, 0) FROM agent_evidence_totals WHERE agent_id = $1) as human_corrections,
        -- Still live: a pending row is swept to resolved before it is ever old
        -- enough to be deleted, so this can never count something that left.
        (SELECT COUNT(*) FROM workflow_escalations WHERE agent_id = $1 AND status = 'pending') as escalations,
        (SELECT COUNT(*) FROM invocations
          WHERE agent_id = $1 AND outcome = 'success'
            AND started_at > COALESCE(
                  (SELECT MAX(created_at) FROM reflection_suggestions WHERE agent_id = $1),
                  '-infinity'::timestamptz)) as successful_runs`,
      [agentId, EVIDENCE_RECENCY_WINDOW_DAYS]
    );
    const row = result.rows[0];
    return {
      failures: parseInt(row.failures, 10) || 0,
      humanCorrections: parseInt(row.human_corrections, 10) || 0,
      escalations: parseInt(row.escalations, 10) || 0,
      successfulRuns: parseInt(row.successful_runs, 10) || 0,
    };
  }

  // Get evidence counts from the last N days for recency calculation.
  //
  // Unlike getEvidenceCounts, the escalation-derived numbers here are still
  // counted live from workflow_escalations, and that is SAFE ONLY WHILE
  // `days <= RETENTION_DAYS`. The proof, so nobody has to re-derive it:
  //
  //   Retention deletes a row when `resolved_at < now - RETENTION_DAYS`, and
  //   `resolved_at >= created_at` always. So deletion implies
  //   `created_at < now - RETENTION_DAYS`. A row with
  //   `created_at > now - days` therefore cannot have been deleted, provided
  //   `days <= RETENTION_DAYS`.
  //
  // Widen the window past retention, or narrow retention past the window, and
  // the count silently drops corrections that happened but whose rows are gone
  // — the same class of quiet history rewrite that agent_evidence_totals exists
  // to prevent for the all-time count. The relationship is asserted in
  // evidence-window-invariant.test.ts so a change to either number fails CI
  // rather than degrading learning months later, and the guard below catches a
  // future caller that asks for more than the shared constant.
  async getRecentEvidenceCounts(agentId: string, days: number): Promise<EvidenceCounts> {
    if (days > RETENTION_DAYS) {
      // Loud, and not silently clamped: clamping would answer a different
      // question than the caller asked while looking like it complied.
      logger.error(
        {
          metric: 'reflection.evidence_window_exceeds_retention',
          agentId, days, retentionDays: RETENTION_DAYS,
        },
        'Recent evidence window is wider than the escalation retention window, so resolved escalations inside it may already have been deleted and this count will read low',
      );
    }
    const result = await pool.query(
      `SELECT
        (SELECT COUNT(*) FROM invocations WHERE agent_id = $1 AND outcome = 'error' AND started_at > NOW() - INTERVAL '1 day' * $2) as failures,
        (SELECT COUNT(*) FROM workflow_escalations WHERE agent_id = $1 AND status = 'resolved' AND created_at > NOW() - INTERVAL '1 day' * $2) as human_corrections,
        (SELECT COUNT(*) FROM workflow_escalations WHERE agent_id = $1 AND status = 'pending' AND created_at > NOW() - INTERVAL '1 day' * $2) as escalations,
        (SELECT COUNT(*) FROM invocations WHERE agent_id = $1 AND outcome = 'success' AND started_at > NOW() - INTERVAL '1 day' * $2) as successful_runs`,
      [agentId, days]
    );
    const row = result.rows[0];
    return {
      failures: parseInt(row.failures, 10) || 0,
      humanCorrections: parseInt(row.human_corrections, 10) || 0,
      escalations: parseInt(row.escalations, 10) || 0,
      successfulRuns: parseInt(row.successful_runs, 10) || 0,
    };
  }

  // Quota management methods
  async incrementDailyRunsUsed(tenantId: string): Promise<void> {
    await pool.query(
      `INSERT INTO reflection_quotas (tenant_id, daily_runs_used)
       VALUES ($1, 1)
       ON CONFLICT (tenant_id) DO UPDATE SET daily_runs_used = reflection_quotas.daily_runs_used + 1`,
      [tenantId]
    );
  }

  /** Charge one weekly run to THIS AGENT. The tenant-level column this
   *  replaces ignored the agentId entirely (migration 365). */
  async incrementWeeklyAgentRunsUsed(tenantId: string, agentId: string): Promise<void> {
    await pool.query(
      `INSERT INTO reflection_agent_quotas (tenant_id, agent_id, weekly_runs_used, window_started_at)
            VALUES ($1, $2, 1, NOW())
       ON CONFLICT (agent_id) DO UPDATE
              SET weekly_runs_used = reflection_agent_quotas.weekly_runs_used + 1`,
      [tenantId, agentId],
    );
  }



  async incrementConcurrentJobs(tenantId: string): Promise<void> {
    await pool.query(
      `INSERT INTO reflection_quotas (tenant_id, current_concurrent_jobs)
       VALUES ($1, 1)
       ON CONFLICT (tenant_id) DO UPDATE SET current_concurrent_jobs = reflection_quotas.current_concurrent_jobs + 1`,
      [tenantId]
    );
  }

  async decrementConcurrentJobs(tenantId: string): Promise<void> {
    await pool.query(
      `UPDATE reflection_quotas
       SET current_concurrent_jobs = GREATEST(0, current_concurrent_jobs - 1)
       WHERE tenant_id = $1`,
      [tenantId]
    );
  }

  // Reset daily quotas (called by scheduler at midnight)
  async resetDailyQuotas(): Promise<void> {
    await pool.query(
      `UPDATE reflection_quotas SET daily_runs_used = 0, last_reset_at = NOW()`
    );
  }

  // Reset weekly quotas (called by scheduler on Sundays)
  async resetWeeklyQuotas(): Promise<void> {
    await pool.query(
      `UPDATE reflection_quotas SET weekly_agent_runs_used = 0`
    );
  }

  private async getInstructionVersion(agentId: string): Promise<number> {
    const result = await pool.query(
      `SELECT instruction_version FROM agents WHERE id = $1`,
      [agentId]
    );
    return result.rows[0]?.instruction_version || 1;
  }

  private async getWorkflowSummaries(agentId: string): Promise<any[]> {
    const result = await pool.query(
      `SELECT id, objective, status, final_outcome FROM workflows WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [agentId]
    );
    return result.rows;
  }

  private async getTaskOutcomes(agentId: string): Promise<any[]> {
    const result = await pool.query(
      `SELECT * FROM workflow_tasks WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [agentId]
    );
    return result.rows;
  }

  private async getEscalationHistory(agentId: string): Promise<any[]> {
    const result = await pool.query(
      `SELECT * FROM workflow_escalations WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [agentId]
    );
    return result.rows;
  }

  private async getUndoHistory(agentId: string): Promise<any[]> {
    const result = await pool.query(
      `SELECT * FROM actions WHERE agent_id = $1 AND status = 'compensated' ORDER BY created_at DESC LIMIT 50`,
      [agentId]
    );
    return result.rows;
  }

  private async getHumanFeedback(agentId: string): Promise<any[]> {
    const result = await pool.query(
      `SELECT * FROM human_feedback WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [agentId]
    );
    return result.rows;
  }

  // Phase 5: Count late-rejection feedback rows for an agent within the last
  // N days. Used by the 'flagged_feedback' trigger threshold check, which
  // fires reflection at 2+ flags in 7 days — a much lower bar than
  // repeated_human_corrections because each flag is an explicit post-hoc
  // rejection by a human reviewer.
  async countFlaggedLateFeedback(agentId: string, days: number): Promise<number> {
    const result = await pool.query(
      `SELECT COUNT(*) AS flagged
       FROM human_feedback
       WHERE agent_id = $1
         AND feedback_type = 'late_rejection'
         AND created_at > NOW() - INTERVAL '1 day' * $2`,
      [agentId, days]
    );
    return parseInt(result.rows[0]?.flagged ?? '0', 10) || 0;
  }

  // Phase 5 gap fix: Return the most recent late-rejection feedback rows
  // for an agent. Surfaces them as a distinct section of the reflection
  // context so the LLM prompt can anchor on the flags that caused the
  // reflection to run rather than guessing from the shared humanFeedback
  // dump. Ordered newest first, capped at 20.
  async getFlaggedLateFeedback(agentId: string, days: number): Promise<any[]> {
    const result = await pool.query(
      `SELECT id, agent_id, tenant_id, task_id, feedback, feedback_type,
              feedback_id, created_at
       FROM human_feedback
       WHERE agent_id = $1
         AND feedback_type = 'late_rejection'
         AND created_at > NOW() - INTERVAL '1 day' * $2
       ORDER BY created_at DESC
       LIMIT 20`,
      [agentId, days]
    );
    return result.rows;
  }

  // Phase 5 gap fix: Fetch a specific late-rejection row by its external
  // feedback_id (the id assigned by the platform backend's
  // hitl_late_feedback table). Used as a fallback when the triggering
  // feedback falls outside the 7-day recency window — the LLM still needs
  // to see the specific row that caused the reflection to fire.
  async getLateFeedbackByFeedbackId(feedbackId: string): Promise<any | null> {
    const result = await pool.query(
      `SELECT id, agent_id, tenant_id, task_id, feedback, feedback_type,
              feedback_id, created_at
       FROM human_feedback
       WHERE feedback_id = $1 AND feedback_type = 'late_rejection'
       LIMIT 1`,
      [feedbackId]
    );
    return result.rows[0] ?? null;
  }

  private async getPolicyDenials(agentId: string): Promise<any[]> {
    const result = await pool.query(
      `SELECT * FROM policy_denials WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [agentId]
    );
    return result.rows;
  }

  private mapSuggestion(row: any): ReflectionSuggestion {
    return {
      id: row.id,
      agentId: row.agent_id,
      suggestion: row.suggestion,
      evidenceRefs: row.evidence_refs,
      confidenceScore: row.confidence_score,
      recurrenceScore: row.recurrence_score,
      severity: row.severity,
      status: row.status,
      createdAt: row.created_at,
      // Phase 5: trigger source for auto-apply gating
      triggeredBy: row.triggered_by ?? null,
      appliedAt: row.applied_at,
      appliedBy: row.applied_by,
      effectiveMeasure: row.effective_measure,
      feedback: row.feedback,
      // A7: autonomy proposal fields
      kind: row.kind ?? 'instruction',
      actionPayload: row.action_payload ?? null,
    };
  }

  /** A7 — persist an autonomy proposal (kind='autonomy'). Never auto-applied; human review only. */
  async saveAutonomySuggestion(input: {
    agentId: string;
    suggestion: string;
    actionPayload: unknown;
    evidenceRefs: unknown;
    confidenceScore: number;
    recurrenceScore: number;
  }): Promise<void> {
    await pool.query(
      `INSERT INTO reflection_suggestions
       (agent_id, suggestion, evidence_refs, confidence_score, recurrence_score, severity, status, kind, action_payload)
       VALUES ($1, $2, $3, $4, $5, 'medium', 'pending', 'autonomy', $6)`,
      [
        input.agentId,
        input.suggestion,
        JSON.stringify(input.evidenceRefs),
        input.confidenceScore,
        input.recurrenceScore,
        JSON.stringify(input.actionPayload),
      ],
    );
  }

  /** A7 — agent-scoped lookup (id-only would permit cross-agent application). */
  async getSuggestionForAgent(id: string, agentId: string): Promise<ReflectionSuggestion | null> {
    const result = await pool.query(
      `SELECT * FROM reflection_suggestions WHERE id = $1 AND agent_id = $2`,
      [id, agentId],
    );
    return result.rows[0] ? this.mapSuggestion(result.rows[0]) : null;
  }

  /** A7 — set a suggestion's status (agent-scoped). */
  async updateSuggestionStatus(id: string, agentId: string, status: string, feedback?: string): Promise<void> {
    await pool.query(
      `UPDATE reflection_suggestions SET status = $3, feedback = COALESCE($4, feedback), updated_at = NOW()
        WHERE id = $1 AND agent_id = $2`,
      [id, agentId, status, feedback ?? null],
    );
  }

  // Learning loop methods
  async getSuggestionById(id: string): Promise<ReflectionSuggestion | null> {
    const result = await pool.query(
      `SELECT * FROM reflection_suggestions WHERE id = $1`,
      [id]
    );
    return result.rows[0] ? this.mapSuggestion(result.rows[0]) : null;
  }

  async updateSuggestionOutcome(
    id: string,
    outcome: {
      applied: boolean;
      appliedBy?: string;
      appliedAt?: Date;
      effectiveMeasure?: 'improved' | 'no_change' | 'degraded';
      feedback?: string;
    }
  ): Promise<void> {
    await pool.query(
      `UPDATE reflection_suggestions
       SET applied_at = $2, applied_by = $3, effective_measure = $4, feedback = $5, updated_at = NOW()
       WHERE id = $1`,
      [id, outcome.appliedAt || (outcome.applied ? new Date() : null), outcome.appliedBy, outcome.effectiveMeasure, outcome.feedback]
    );
  }

  async updatePatternWeight(input: {
    agentId: string;
    pattern: string;
    evidenceTypes: string[];
    weight: number;
    sampleCount: number;
  }): Promise<void> {
    await pool.query(
      `INSERT INTO reflection_pattern_weights (agent_id, pattern, evidence_types, weight, sample_count)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (agent_id, pattern) DO UPDATE SET
         weight = (reflection_pattern_weights.weight * reflection_pattern_weights.sample_count + $4) / (reflection_pattern_weights.sample_count + 1),
         sample_count = reflection_pattern_weights.sample_count + 1,
         updated_at = NOW()`,
      [input.agentId, input.pattern, JSON.stringify(input.evidenceTypes), input.weight, input.sampleCount]
    );
  }

  async getPatternWeights(agentId: string): Promise<Array<{
    agentId: string;
    pattern: string;
    evidenceTypes: string[];
    weight: number;
    sampleCount: number;
  }>> {
    const result = await pool.query(
      `SELECT * FROM reflection_pattern_weights WHERE agent_id = $1`,
      [agentId]
    );
    return result.rows.map((row: any) => ({
      agentId: row.agent_id,
      pattern: row.pattern,
      evidenceTypes: row.evidence_types,
      weight: row.weight,
      sampleCount: row.sample_count,
    }));
  }

  async getAllTenantSuggestions(tenantId: string): Promise<ReflectionSuggestion[]> {
    const result = await pool.query(
      `SELECT rs.* FROM reflection_suggestions rs
       JOIN agents a ON rs.agent_id = a.id
       WHERE a.tenant_id = $1
       ORDER BY rs.created_at DESC`,
      [tenantId]
    );
    return result.rows.map(this.mapSuggestion);
  }

}
