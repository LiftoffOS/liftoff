// Invocations and Threads Service
// Per implementation plan: Phase 3 Invocations & Threads

import { getPoolForService } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import { freshInputTokensFor, FRESH_INPUT_TOKENS_SQL } from '../llm/pricing';
import type { LLMProvider } from '../llm/types';
import { invocation_failed_total } from '../observability/runtime-extensions-metrics';
import { armStallWatch } from '../scheduling/stall-watch';
import { resolveExecutionEngine, isResolvedProvider } from '../agent-execution/adapter/engine-resolver';
import { UNKNOWN_ENGINE } from '../agent-execution/adapter/vendors';
import type { ExecutionEngineId } from '../agent-execution/adapter/types';

// Use the default pool directly (not the lazy proxy) so it's properly warmed at startup
const pool = getPoolForService('default');
import {
  Thread,
  Message,
  Invocation,
  ThreadStatus,
  InitiatedByType,
  MessageRole,
  TriggerType,
  InvocationOutcome,
  FailureClass,
  ToolCallRecord,
  CreateThreadInput,
  CreateMessageInput,
  CreateInvocationInput,
  CompleteInvocationInput,
  CostStats,
  AgentCostEntry,
  RerunSource,
  AttributionSource,
} from './types';
import { incCounter } from '../memory/metrics';

/** Attribution sources that name someone who actually acted, as opposed to
 *  someone we inferred. Kept next to the resolver so adding a source forces a
 *  decision about which side of the line it falls on. */
const PRECISE_ATTRIBUTION_SOURCES: ReadonlySet<AttributionSource> = new Set<AttributionSource>([
  'direct_human',
  'delegation',
]);

/**
 * Decide whose run this is, and record how we decided.
 *
 * The one-way invariant lives here: when an originator is known, they ARE the
 * accountable party and no derivation may override that. A table CHECK backs it
 * up, because the failure it prevents — an inferred owner quietly replacing the
 * person who actually clicked — is invisible to every query written against the
 * column afterwards.
 *
 * A delegated child inherits its parent's human (delegateToAgent resolves it),
 * which is still PRECISE: a delegation changes who does the work, not who asked
 * for it.
 */
export function resolveAccountability(input: {
  triggeredByUserId?: string;
  parentInvocationId?: string;
}): { accountableUserId: string | null; attributionSource: AttributionSource } {
  if (input.triggeredByUserId) {
    return {
      accountableUserId: input.triggeredByUserId,
      attributionSource: input.parentInvocationId ? 'delegation' : 'direct_human',
    };
  }
  // No originator, and the runtime holds no owner to derive one from — see the
  // AttributionSource doc. Recorded as an explicit 'unattributed' rather than
  // left NULL, so "we asked and there was nobody" stays distinguishable from
  // "this row predates the column"; the two need different follow-ups.
  return { accountableUserId: null, attributionSource: 'unattributed' };
}

/** Coverage: how much of our attribution is a fact about a person and how much
 *  is an inference. Reported as a split rather than a single percentage,
 *  because a number that mixes the two overstates what we actually know. */
function recordAttributionCoverage(source: AttributionSource): void {
  incCounter('invocation_attribution_total', {
    attribution_source: source,
    precision: PRECISE_ATTRIBUTION_SOURCES.has(source) ? 'precise' : 'degraded',
  });
}

/** How long a routine run may stay ACTIVE before it is stopped.
 *
 *  Only routine (companion-label) runs get a deadline. A chat turn has a person
 *  waiting on it, and a delegated child is bounded by its parent; neither is the
 *  runaway case this guards.
 *
 *  Thirty minutes is generous for a scheduled job — the tick that produced it
 *  will come round again — and the point is to bound a loop, not to race real
 *  work. Env-tunable for an agent whose routines genuinely run long.
 */
const ROUTINE_MAX_ACTIVE_MINUTES = Number(process.env.ROUTINE_MAX_ACTIVE_MINUTES ?? 30);

export function routineActiveDeadline(
  triggeredByLabel: string | undefined | null,
  now: Date = new Date(),
): Date | null {
  if (!triggeredByLabel?.startsWith('companion:')) return null;
  if (!Number.isFinite(ROUTINE_MAX_ACTIVE_MINUTES) || ROUTINE_MAX_ACTIVE_MINUTES <= 0) return null;
  return new Date(now.getTime() + ROUTINE_MAX_ACTIVE_MINUTES * 60_000);
}

export class InvocationsService {
  // Create a new thread
  async createThread(input: CreateThreadInput): Promise<Thread> {
    const result = await pool.query(
      `INSERT INTO threads (tenant_id, agent_id, initiated_by_user, initiated_by_type, title)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        input.tenantId,
        input.agentId,
        input.initiatedByUser || null,
        input.initiatedByType || 'human',
        input.title || null,
      ]
    );

    log.info({ threadId: result.rows[0].id, tenantId: input.tenantId }, 'Thread created');
    return this.mapThread(result.rows[0]);
  }

  // Get thread by ID
  async getThread(threadId: string, tenantId: string): Promise<Thread | null> {
    const result = await pool.query(
      `SELECT * FROM threads WHERE id = $1 AND tenant_id = $2`,
      [threadId, tenantId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return this.mapThread(result.rows[0]);
  }

  // List threads for an agent
  async listThreads(
    tenantId: string,
    agentId: string,
    options?: { status?: ThreadStatus; cursor?: string; limit?: number }
  ): Promise<{ threads: Thread[]; nextCursor: string | null }> {
    const limit = Math.min(options?.limit || 20, 100);

    let query = `
      SELECT * FROM threads
      WHERE tenant_id = $1 AND agent_id = $2
    `;
    const params: unknown[] = [tenantId, agentId];
    let paramIndex = 3;

    if (options?.status) {
      query += ` AND status = $${paramIndex}`;
      params.push(options.status);
      paramIndex++;
    }

    if (options?.cursor) {
      query += ` AND created_at < $${paramIndex}`;
      params.push(options.cursor);
      paramIndex++;
    }

    query += ` ORDER BY created_at DESC LIMIT $${paramIndex}`;
    params.push(limit + 1);

    const result = await pool.query(query, params);
    const hasMore = result.rows.length > limit;
    const threads = result.rows.slice(0, limit).map(row => this.mapThread(row));

    return {
      threads,
      nextCursor: hasMore && threads.length > 0
        ? threads[threads.length - 1].createdAt.toISOString()
        : null,
    };
  }

  // Update thread status
  async updateThreadStatus(
    threadId: string,
    tenantId: string,
    status: ThreadStatus
  ): Promise<Thread | null> {
    const result = await pool.query(
      `UPDATE threads SET status = $3, updated_at = NOW()
       WHERE id = $1 AND tenant_id = $2
       RETURNING *`,
      [threadId, tenantId, status]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return this.mapThread(result.rows[0]);
  }

  // Add message to thread
  async addMessage(input: CreateMessageInput): Promise<Message> {
    const result = await pool.query(
      `INSERT INTO messages (tenant_id, thread_id, role, content, tool_calls, input_tokens, output_tokens)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        input.tenantId,
        input.threadId,
        input.role,
        input.content,
        input.toolCalls ? JSON.stringify(input.toolCalls) : null,
        input.inputTokens || 0,
        input.outputTokens || 0,
      ]
    );

    return this.mapMessage(result.rows[0]);
  }

  // Get messages for a thread
  async getMessages(
    threadId: string,
    tenantId: string,
    options?: { limit?: number; beforeId?: string }
  ): Promise<Message[]> {
    const limit = Math.min(options?.limit || 50, 200);

    let query = `
      SELECT * FROM messages
      WHERE thread_id = $1 AND tenant_id = $2
    `;
    const params: unknown[] = [threadId, tenantId];

    if (options?.beforeId) {
      query += ` AND id < $3`;
      params.push(options.beforeId);
    }

    query += ` ORDER BY created_at ASC LIMIT $${params.length + 1}`;
    params.push(limit);

    const result = await pool.query(query, params);
    return result.rows.map(row => this.mapMessage(row));
  }

  /** Whether a person wrote on the thread after `after`. Read by a queued
   *  continuation of a chat turn before it runs: a person message newer than
   *  the continuation supersedes it. One indexed read, newest first, rather
   *  than a page of the thread from its start. */
  async hasUserMessageAfter(threadId: string, tenantId: string, after: Date): Promise<boolean> {
    const result = await pool.query(
      `SELECT 1 FROM messages
       WHERE thread_id = $1 AND tenant_id = $2 AND role = 'user' AND created_at > $3
       LIMIT 1`,
      [threadId, tenantId, after],
    );
    return (result.rowCount ?? 0) > 0;
  }

  // Create an invocation
  async createInvocation(input: CreateInvocationInput): Promise<Invocation> {
    // When `input.id` is provided, the caller has pre-generated the UUID
    // (e.g. to thread it into retrieval event log before invocation row exists).
    // Otherwise the column DEFAULT gen_random_uuid() generates it.
    // Resolve the CONCRETE engine deterministically at row creation,
    // before execution begins, so provenance is present for every terminal state
    // (success/error/paused/admission-denied). Resolution mirrors createAdapter
    // via the shared resolver, so the persisted engine matches the adapter that
    // runs. NULL only when the provider is not one the resolver understands
    // (never throws here — a bad provider must not block invocation creation).
    const executionEngine: ExecutionEngineId | null = isResolvedProvider(input.provider)
      ? resolveExecutionEngine(input.provider, process.env)
      : null;

    // Migration 357 — WHOSE run this is, and how we know.
    //
    // Derived here, at the single write site, for the same reason the parent's
    // human is resolved inside delegateToAgent: every caller gets it right, and
    // a future one cannot forget. The one-way invariant (originator present ⇒
    // accountable IS the originator) is a table CHECK; this is the code that
    // never asks it to fail.
    const { accountableUserId, attributionSource } = resolveAccountability(input);

    const useExplicitId = !!input.id;
    const sql = useExplicitId
      ? `INSERT INTO invocations (id, tenant_id, agent_id, thread_id, triggered_by, triggered_by_label, trigger_ref, model_id, provider, execution_engine, parent_invocation_id, delegation_depth, replay_input, rerun_of_invocation_id, triggered_by_user_id, active_deadline_at, accountable_user_id, attribution_source, impersonated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
         RETURNING *`
      : `INSERT INTO invocations (tenant_id, agent_id, thread_id, triggered_by, triggered_by_label, trigger_ref, model_id, provider, execution_engine, parent_invocation_id, delegation_depth, replay_input, rerun_of_invocation_id, triggered_by_user_id, active_deadline_at, accountable_user_id, attribution_source, impersonated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
         RETURNING *`;
    // A routine run gets a deadline; nothing else does. The reconciler
    // enforces it, and it already declines to sweep runs that are legitimately
    // paused, so a run waiting on a human is exempt by construction.
    const activeDeadlineAt = routineActiveDeadline(input.triggeredByLabel);

    const params = useExplicitId
      ? [
          input.id,
          input.tenantId,
          input.agentId,
          input.threadId || null,
          input.triggeredBy,
          input.triggeredByLabel || null,
          input.triggerRef || null,
          input.modelId || null,
          input.provider,
          executionEngine,
          input.parentInvocationId || null,
          input.delegationDepth ?? null,
          input.replayInput ?? null,
          input.rerunOfInvocationId ?? null,
          input.triggeredByUserId || null,
          activeDeadlineAt,
          accountableUserId,
          attributionSource,
          input.impersonatedBy || null,
        ]
      : [
          input.tenantId,
          input.agentId,
          input.threadId || null,
          input.triggeredBy,
          input.triggeredByLabel || null,
          input.triggerRef || null,
          input.modelId || null,
          input.provider,
          executionEngine,
          input.parentInvocationId || null,
          input.delegationDepth ?? null,
          input.replayInput ?? null,
          input.rerunOfInvocationId ?? null,
          input.triggeredByUserId || null,
          activeDeadlineAt,
          accountableUserId,
          attributionSource,
          input.impersonatedBy || null,
        ];
    const result = await pool.query(sql, params);
    // Counted AFTER the write, so coverage reports rows that exist rather than
    // attempts that may have thrown.
    recordAttributionCoverage(attributionSource);
    // The run exists, so a stall check for it exists (no-op while the
    // reconciler is off).
    armStallWatch();

    log.info(
      { invocationId: result.rows[0].id, tenantId: input.tenantId, executionEngine },
      'Invocation started',
    );
    return this.mapInvocation(result.rows[0]);
  }

  // ADR-030: minimal projection the "Run again" endpoint needs to validate
  // re-runnability and reconstruct the original run input. Tenant-scoped so a
  // caller can only read invocations belonging to its own tenant.
  async getRerunSource(invocationId: string, tenantId: string): Promise<RerunSource | null> {
    const result = await pool.query(
      `SELECT id, agent_id, triggered_by, outcome, failure_class, parent_invocation_id, replay_input
       FROM invocations WHERE id = $1 AND tenant_id = $2`,
      [invocationId, tenantId]
    );
    if (result.rows.length === 0) {
      return null;
    }
    const row = result.rows[0];
    return {
      id: row.id as string,
      agentId: row.agent_id as string,
      triggeredBy: row.triggered_by as TriggerType,
      outcome: row.outcome as InvocationOutcome | null,
      failureClass: (row.failure_class as FailureClass | null) ?? null,
      parentInvocationId: row.parent_invocation_id as string | null,
      replayInput: (row.replay_input as Record<string, unknown> | null) ?? null,
    };
  }

  // Complete an invocation — price snapshots are stored for historical accuracy,
  // cost_usd is derived on read from (tokens * price_per_million / 1_000_000).
  async completeInvocation(
    invocationId: string,
    input: CompleteInvocationInput
  ): Promise<Invocation | null> {
    // Mark zero-token error invocations for Anthropic Billing API reconciliation.
    // Zero tokens on error = timeout or thrown exception before the SDK result event.
    const needsReconciliation =
      input.outcome === 'error' && input.inputTokens === 0;
    const reconciliationStatus = needsReconciliation ? 'pending' : 'ok';

    const result = await pool.query(
      `UPDATE invocations SET
        input_tokens = $2,
        output_tokens = $3,
        cached_tokens = $4,
        input_price_per_million = $5,
        output_price_per_million = $6,
        cached_input_price_per_million = $7,
        grounding_queries = $8,
        grounding_cost_usd = $9,
        tool_calls = $10,
        outcome = $11,
        error_message = $12,
        reconciliation_status = $13,
        failure_class = $14,
        provider_failure_kind = $15,
        provider_error_type = $16,
        provider_status = $17,
        provider_request_id = $18,
        vendor_cost_usd = $19,
        cache_write_tokens = $20,
        cache_write_price_per_million = $21,
        completed_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [
        invocationId,
        input.inputTokens,
        input.outputTokens,
        input.cachedTokens ?? 0,
        input.inputPricePerMillion || null,
        input.outputPricePerMillion || null,
        input.cachedInputPricePerMillion ?? null,
        input.groundingQueries ?? 0,
        input.groundingCostUsd ?? 0,
        JSON.stringify(input.toolCalls),
        input.outcome,
        input.errorMessage || null,
        reconciliationStatus,
        input.failureClass ?? null,
        input.providerFailure?.kind ?? null,
        input.providerFailure?.providerErrorType ?? null,
        input.providerFailure?.status ?? null,
        input.providerFailure?.requestId ?? null,
        // Guarded on `> 0`, not on presence: a zero is not a charge, and stored
        // as one it would reprice the invocation to free on the backstop path.
        typeof input.vendorCostUsd === 'number'
          && Number.isFinite(input.vendorCostUsd)
          && input.vendorCostUsd > 0
          ? input.vendorCostUsd
          : null,
        // Null rather than 0 for a vendor that does not charge for a cache
        // write, so "not billable here" stays distinguishable from "billable and
        // none happened".
        input.cacheWriteTokens ?? null,
        input.cacheWritePricePerMillion ?? null,
      ]
    );

    if (result.rows.length === 0) {
      return null;
    }

    // Carry the bounded concrete engine AND the provider on the
    // terminal-outcome log and failure metric so diagnostics can slice
    // failures by the (engine, provider) pair. The engine alone stopped being
    // enough when opencode began serving two providers: a failure rate on
    // `opencode` folds Grok on xAI's account together with the open-weights
    // families on OpenRouter's, which fail for different reasons.
    const executionEngine = (result.rows[0].execution_engine as string | null) ?? UNKNOWN_ENGINE;
    const provider = (result.rows[0].provider as string | null) ?? 'unknown';

    log.info({
      // Structured event marker so Cloud Logging log-based metrics (infra:
      // tenant-runtime-template/log-metrics.tf) can slice invocation outcomes by
      // engine and provider.
      event: 'engine_invocation_completed',
      invocationId,
      outcome: input.outcome,
      executionEngine,
      provider,
      // The provider's own account of a failure, on the ONE log line every run
      // emits. The row already stores its kind, type, status and request id;
      // what it never carried was what the provider SAID — and a gateway 400
      // reads "Provider returned error" with the upstream's reason in a field
      // nothing kept. A run that ends in a 400 nobody can read is a run that
      // has to be reproduced to be diagnosed.
      ...(input.outcome === 'error' && input.providerFailure
        ? {
          failureClass: input.failureClass ?? null,
          providerFailure: {
            kind: input.providerFailure.kind,
            providerErrorType: input.providerFailure.providerErrorType ?? null,
            status: input.providerFailure.status ?? null,
            requestId: input.providerFailure.requestId ?? null,
            detail: input.providerFailure.detail ?? null,
          },
        }
        : {}),
    }, 'Invocation completed');

    // Failure-taxonomy telemetry (migration 308): one counter per failed run,
    // labeled by failure_class so the dashboard shows the failure distribution.
    // The stalled-run reconciler emits its own 'stalled' increment (it bypasses
    // this method with a direct UPDATE). execution_engine and provider (both
    // bounded) let the dashboard compare failure rates across (engine,
    // provider) pairs.
    if (input.outcome === 'error') {
      invocation_failed_total.inc({
        failure_class: input.failureClass ?? 'unknown',
        execution_engine: executionEngine,
        provider,
      });
    }

    // Self-wake job triggers: fire any wake_on_job bound to this now-terminal invocation.
    // Fire-and-forget; a broken module must never crash completeInvocation().
    try {
      const { fireWakeOnJobForCompletedInvocation } = require('../scheduling/wake-job-trigger');
      void fireWakeOnJobForCompletedInvocation(invocationId, result.rows[0].tenant_id as string, input.outcome, input.trustLevel).catch(() => {});
    } catch { /* non-fatal */ }

    // Liftoff Switch: report the FIRST terminal outcome of an imported routine.
    // Only fires for a scheduled run that carries a migration routine ref, and
    // the control plane records first-write-wins, so later runs are no-ops
    // there. Fire-and-forget: a migration report must never affect the run.
    if (input.migrationRoutineRef) {
      try {
        const { reportFirstScheduledRun, outcomeToFirstRunStatus, toErrorCategory } =
          require('../platform-callback/switch-first-run');
        const row = result.rows[0];
        void reportFirstScheduledRun({
          tenantId: row.tenant_id as string,
          agentId: row.agent_id as string,
          migrationRoutineRef: input.migrationRoutineRef,
          outcome: outcomeToFirstRunStatus(input.outcome),
          errorCategory: toErrorCategory(input.failureClass),
        }).catch(() => {});
      } catch { /* non-fatal */ }
    }

    // Phase 5B: Fire-and-forget outcome extraction for learning loops.
    // Wrapped in try/catch — a broken module must never crash completeInvocation().
    if (input.toolCalls.length > 0) {
      try {

        const { extractAndSaveLearnings } = require('../learning/outcome-extractor');
        const row = result.rows[0];
        extractAndSaveLearnings(row.tenant_id, row.agent_id, {
          invocationId,
          agentId: row.agent_id,
          // Objective isn't persisted on the invocation row; the caller passes
          // it through so escalation memories carry the real task text.
          objective: input.objective ?? '',
          outcome: input.outcome,
          errorMessage: input.errorMessage,
          toolCalls: input.toolCalls,
        }).catch((err: Error) => log.warn({ err }, 'Non-fatal: outcome extraction failed'));
      } catch (err) {
        log.warn({ err }, 'Non-fatal: outcome extractor module load failed');
      }
    }

    return this.mapInvocation(result.rows[0]);
  }

  // Get invocation by ID
  async getInvocation(invocationId: string, tenantId: string): Promise<Invocation | null> {
    const result = await pool.query(
      `SELECT * FROM invocations WHERE id = $1 AND tenant_id = $2`,
      [invocationId, tenantId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return this.mapInvocation(result.rows[0]);
  }

  // Read an invocation on a caller-supplied pool (e.g. a bounded pool with a
  // hard statement_timeout for a best-effort side read that must never hang a
  // shared connection). Reuses the same row mapping as getInvocation.
  async getInvocationVia(
    execPool: { query: (text: string, values: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
    invocationId: string,
    tenantId: string,
  ): Promise<Invocation | null> {
    const result = await execPool.query(
      `SELECT * FROM invocations WHERE id = $1 AND tenant_id = $2`,
      [invocationId, tenantId],
    );
    if (result.rows.length === 0) return null;
    return this.mapInvocation(result.rows[0]);
  }

  // List invocations with pagination
  async listInvocations(
    tenantId: string,
    options?: { agentId?: string; outcome?: InvocationOutcome; cursor?: string; limit?: number }
  ): Promise<{ invocations: Invocation[]; nextCursor: string | null }> {
    const limit = Math.min(options?.limit || 20, 100);

    let query = `SELECT * FROM invocations WHERE tenant_id = $1`;
    const params: unknown[] = [tenantId];
    let paramIndex = 2;

    if (options?.agentId) {
      query += ` AND agent_id = $${paramIndex}`;
      params.push(options.agentId);
      paramIndex++;
    }

    if (options?.outcome) {
      query += ` AND outcome = $${paramIndex}`;
      params.push(options.outcome);
      paramIndex++;
    }

    if (options?.cursor) {
      query += ` AND started_at < $${paramIndex}`;
      params.push(options.cursor);
      paramIndex++;
    }

    query += ` ORDER BY started_at DESC LIMIT $${paramIndex}`;
    params.push(limit + 1);

    const result = await pool.query(query, params);
    const hasMore = result.rows.length > limit;
    const invocations = result.rows.slice(0, limit).map(row => this.mapInvocation(row));

    return {
      invocations,
      nextCursor: hasMore && invocations.length > 0
        ? invocations[invocations.length - 1].startedAt.toISOString()
        : null,
    };
  }

  /** The most recent COMPLETED run of one specific routine.
   *
   *  `listInvocations` filters by agent, which is the wrong grain here: an
   *  agent's routines all share an agent id and differ only by
   *  triggered_by_label. A chained routine needs its own sibling's last run,
   *  not whatever the agent happened to do most recently. */
  async getLatestCompletedByLabel(
    tenantId: string,
    agentId: string,
    triggeredByLabel: string,
  ): Promise<Invocation | null> {
    const result = await pool.query(
      `SELECT * FROM invocations
        WHERE tenant_id = $1 AND agent_id = $2 AND triggered_by_label = $3
          AND completed_at IS NOT NULL
        ORDER BY completed_at DESC
        LIMIT 1`,
      [tenantId, agentId, triggeredByLabel],
    );
    if (result.rows.length === 0) return null;
    return this.mapInvocation(result.rows[0]);
  }

  // Get cost stats for a tenant (time range)
  // Cost is derived: (input_tokens * input_price_per_million + output_tokens * output_price_per_million) / 1e6
  async getCostStats(
    tenantId: string,
    startDate: Date,
    endDate: Date,
    agentId?: string
  ): Promise<CostStats> {
    // Sandbox cost credits are converted to USD at a configurable rate.
    // This is added to the LLM-derived cost to produce the total.
    const sandboxCreditToUsd = parseFloat(process.env.SANDBOX_CREDIT_TO_USD ?? '0.001');

    // Provider-aware fresh-input formula (see FRESH_INPUT_TOKENS_SQL in
    // src/llm/pricing.ts). Anthropic input_tokens excludes cached, so the
    // SQL CASE returns input_tokens as-is; OpenAI / Google include cached,
    // so we subtract. Without this branch, Anthropic invocations with
    // cached > input produced negative cost.
    let query = `
      SELECT
        COALESCE(SUM(
          (${FRESH_INPUT_TOKENS_SQL} * COALESCE(input_price_per_million, 0)
           + COALESCE(cached_tokens, 0) * COALESCE(cached_input_price_per_million, 0)
           + output_tokens * COALESCE(output_price_per_million, 0)) / 1000000.0
          + COALESCE(sandbox_cost_credits, 0) * ${sandboxCreditToUsd}
        ), 0) as total_cost_usd,
        COALESCE(SUM(input_tokens), 0) as total_input_tokens,
        COALESCE(SUM(output_tokens), 0) as total_output_tokens,
        COUNT(*) as invocation_count,
        COUNT(*) FILTER (WHERE outcome = 'success') as successful_invocations,
        COUNT(*) FILTER (WHERE outcome = 'error') as failed_invocations
      FROM invocations
      WHERE tenant_id = $1
        AND started_at >= $2
        AND started_at < $3
        AND completed_at IS NOT NULL
    `;
    const params: unknown[] = [tenantId, startDate, endDate];

    if (agentId) {
      query += ` AND agent_id = $4`;
      params.push(agentId);
    }

    const result = await pool.query(query, params);
    const row = result.rows[0];

    return {
      totalCostUsd: parseFloat(row.total_cost_usd) || 0,
      totalInputTokens: parseInt(row.total_input_tokens, 10) || 0,
      totalOutputTokens: parseInt(row.total_output_tokens, 10) || 0,
      invocationCount: parseInt(row.invocation_count, 10) || 0,
      successfulInvocations: parseInt(row.successful_invocations, 10) || 0,
      failedInvocations: parseInt(row.failed_invocations, 10) || 0,
    };
  }

  // Get per-agent cost aggregation for a tenant (time range)
  // Returns costs keyed by internal_agent_id (Platform Backend's ID), not the runtime agent_id.
  // Joins through internal_agent_runtime_mapping to translate.
  async getAgentCosts(
    tenantId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<Record<string, AgentCostEntry>> {
    // Include sandbox_cost_credits in the derived total (same rate as getCostStats)
    const sandboxCreditToUsd = 0.001;

    // Provider-aware fresh-input formula — see FRESH_INPUT_TOKENS_SQL.
    // Inline `i.`-qualified version because the CASE refs unqualified columns.
    const freshInputAliased = `
      (CASE WHEN i.provider IN ('anthropic', 'anthropic-vertex')
            THEN i.input_tokens
            ELSE GREATEST(i.input_tokens - COALESCE(i.cached_tokens, 0), 0)
       END)`.trim();
    const result = await pool.query(
      `SELECT
        COALESCE(m.internal_agent_id, i.agent_id) as internal_agent_id,
        COALESCE(SUM(
          (${freshInputAliased} * COALESCE(i.input_price_per_million, 0)
           + COALESCE(i.cached_tokens, 0) * COALESCE(i.cached_input_price_per_million, 0)
           + i.output_tokens * COALESCE(i.output_price_per_million, 0)) / 1000000.0
          + COALESCE(i.sandbox_cost_credits, 0) * ${sandboxCreditToUsd}
        ), 0) as total_cost_usd,
        COUNT(*) as invocation_count,
        COALESCE(SUM(i.input_tokens), 0) as total_input_tokens,
        COALESCE(SUM(i.output_tokens), 0) as total_output_tokens
      FROM invocations i
      LEFT JOIN internal_agent_runtime_mapping m ON m.agent_id = i.agent_id
      WHERE i.tenant_id = $1
        AND i.started_at >= $2
        AND i.started_at < $3
        AND i.completed_at IS NOT NULL
      GROUP BY COALESCE(m.internal_agent_id, i.agent_id)`,
      [tenantId, startDate, endDate]
    );

    const costs: Record<string, AgentCostEntry> = {};
    for (const row of result.rows) {
      costs[row.internal_agent_id as string] = {
        totalCostUsd: parseFloat(row.total_cost_usd) || 0,
        invocationCount: parseInt(row.invocation_count, 10) || 0,
        totalInputTokens: parseInt(row.total_input_tokens, 10) || 0,
        totalOutputTokens: parseInt(row.total_output_tokens, 10) || 0,
      };
    }
    return costs;
  }

  // Get HITL decision counts (approvals + rejections) per account from
  // hitl_approval_requests for the given time window. Used by Platform Backend
  // to populate the Tasks column for human rows on the /teams page.
  async getHitlDecisionCounts(
    tenantId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<Record<string, { decisionCount: number }>> {
    const result = await pool.query(
      `SELECT
        decided_by,
        COUNT(*) as decision_count
      FROM hitl_approval_requests
      WHERE tenant_id = $1
        AND decided_by IS NOT NULL
        AND decision IN ('approved', 'rejected')
        AND decided_at >= $2
        AND decided_at < $3
      GROUP BY decided_by`,
      [tenantId, startDate, endDate]
    );

    const counts: Record<string, { decisionCount: number }> = {};
    for (const row of result.rows) {
      counts[row.decided_by as string] = {
        decisionCount: parseInt(row.decision_count, 10) || 0,
      };
    }
    return counts;
  }

  // Get task counts for external agents from audit_logs (for per-task cost calculation)
  async getExternalAgentTaskCounts(
    tenantId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<Record<string, { taskCount: number }>> {
    const result = await pool.query(
      `SELECT
        external_agent_id,
        COUNT(*) as task_count
      FROM audit_logs
      WHERE tenant_id = $1
        AND external_agent_id IS NOT NULL
        AND outcome = 'success'
        AND created_at >= $2
        AND created_at < $3
      GROUP BY external_agent_id`,
      [tenantId, startDate, endDate]
    );

    const counts: Record<string, { taskCount: number }> = {};
    for (const row of result.rows) {
      counts[row.external_agent_id as string] = {
        taskCount: parseInt(row.task_count, 10) || 0,
      };
    }
    return counts;
  }

  // List invocations for cost attribution ingestion.
  // Returns individual completed rows ordered by started_at ASC for cursor-based polling.
  // Cost is derived from price snapshots (same as mapInvocation) — cost_usd is not stored.
  async listInvocationsForIngestion(
    tenantId: string,
    since: Date,
    limit: number,
  ): Promise<{
    id: string;
    agentId: string;
    internalAgentId: string | null;
    threadId: string | null;
    triggeredBy: string;
    triggerRef: string | null;
    provider: string;
    modelId: string | null;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    inputPricePerMillion: number | null;
    outputPricePerMillion: number | null;
    cachedInputPricePerMillion: number | null;
    costUsd: number | null;
    outcome: string | null;
    startedAt: Date;
  }[]> {
    // `invocations.agent_id` is the runtime agents.id; the Platform Backend keys
    // cost attribution by internal_agents.id. Emit both so PB can key correctly
    // without a second round trip (INV-TR-010). LEFT JOIN: an unmapped agent
    // yields null and PB falls back to `agentId`, preserving today's behaviour.
    const result = await pool.query(
      `SELECT
         i.id::text, i.agent_id, m.internal_agent_id,
         i.thread_id, i.triggered_by, i.trigger_ref,
         i.provider, i.model_id,
         COALESCE(i.input_tokens, 0)::bigint AS input_tokens,
         COALESCE(i.output_tokens, 0)::bigint AS output_tokens,
         COALESCE(i.cached_tokens, 0)::bigint AS cached_tokens,
         i.input_price_per_million,
         i.output_price_per_million,
         i.cached_input_price_per_million,
         i.cache_write_tokens,
         i.cache_write_price_per_million,
         i.vendor_cost_usd,
         i.outcome,
         i.started_at
       FROM invocations i
       LEFT JOIN internal_agent_runtime_mapping m
         ON m.agent_id = i.agent_id AND m.tenant_id = i.tenant_id
       WHERE i.tenant_id = $1
         AND i.started_at > $2
         AND i.completed_at IS NOT NULL
       ORDER BY i.started_at ASC, i.id ASC
       LIMIT $3`,
      [tenantId, since, limit],
    );
    return result.rows.map(row => {
      const inputTokens = Number(row.input_tokens);
      const outputTokens = Number(row.output_tokens);
      const cachedTokens = Number(row.cached_tokens);
      const inputPricePerMillion = row.input_price_per_million ? parseFloat(row.input_price_per_million) : null;
      const outputPricePerMillion = row.output_price_per_million ? parseFloat(row.output_price_per_million) : null;
      const cachedInputPricePerMillion = row.cached_input_price_per_million ? parseFloat(row.cached_input_price_per_million) : null;
      const cacheWriteTokens = row.cache_write_tokens == null ? 0 : Number(row.cache_write_tokens);
      const cacheWritePricePerMillion = row.cache_write_price_per_million == null
        ? null
        : parseFloat(String(row.cache_write_price_per_million));

      // WHAT THE GATEWAY CHARGED BEATS WHAT THIS ROW'S RATES WOULD RECOMPUTE.
      //
      // This feed is the BACKSTOP for the `invocation.completed` event, which
      // already carries the reported charge; recomputing here made the two paths
      // disagree by up to the endpoint spread on a gateway model — `priceRunSteps`
      // books the charge, and a run the event path missed was reconciled at the
      // dearest endpoint's rate instead (migration 438).
      //
      // The rate columns are still emitted unchanged: they describe the model,
      // and the consumer records them as the rates the call was priced at.
      // Only the money is replaced.
      const reportedCost = row.vendor_cost_usd == null ? NaN : Number(row.vendor_cost_usd);
      let costUsd: number | null = null;
      if (Number.isFinite(reportedCost) && reportedCost > 0) {
        costUsd = reportedCost;
      } else if (inputPricePerMillion != null && outputPricePerMillion != null) {
        const freshInputTokens = freshInputTokensFor(row.provider as LLMProvider, inputTokens, cachedTokens);
        costUsd = (freshInputTokens * inputPricePerMillion + outputTokens * outputPricePerMillion) / 1_000_000;
        if (cachedTokens > 0 && cachedInputPricePerMillion != null) {
          costUsd += (cachedTokens * cachedInputPricePerMillion) / 1_000_000;
        }
        // Cache WRITES, at the rate the row was priced at rather than today's:
        // this recomputation has to reproduce the charge the event path already
        // published, and a rate that has moved since would make the two disagree
        // in exactly the cases nobody is watching (migration 439).
        if (cacheWriteTokens > 0 && cacheWritePricePerMillion != null) {
          costUsd += (cacheWriteTokens * cacheWritePricePerMillion) / 1_000_000;
        }
      }

      return {
        id:                         row.id as string,
        agentId:                    row.agent_id as string,
        internalAgentId:            (row.internal_agent_id as string | null) ?? null,
        threadId:                   row.thread_id as string | null,
        triggeredBy:                row.triggered_by as string,
        triggerRef:                 row.trigger_ref as string | null,
        provider:                   row.provider as string,
        modelId:                    row.model_id as string | null,
        inputTokens,
        outputTokens,
        cachedTokens,
        inputPricePerMillion,
        outputPricePerMillion,
        cachedInputPricePerMillion,
        costUsd,
        outcome:                    row.outcome as string | null,
        startedAt:                  row.started_at as Date,
      };
    });
  }

  // List sandbox usage log rows for cost attribution ingestion.
  // Returns rows ordered by timestamp ASC for cursor-based polling.
  // Platform-backend polls this to ingest sandbox compute costs per tenant.
  async listSandboxUsageForIngestion(
    tenantId: string,
    since: Date,
    limit: number,
  ): Promise<{
    id: string;
    agentId: string;
    internalAgentId: string | null;
    invocationId: string;
    sandboxId: string;
    phase: string;
    wallClockMs: number;
    creditsConsumed: number;
    timestamp: Date;
  }[]> {
    // Same id-space translation as listInvocationsForIngestion: sandbox_usage_log
    // .agent_id is the runtime agents.id, PB keys attribution by internal_agents.id
    // (INV-TR-010). LEFT JOIN so unmapped agents still emit a row.
    const result = await pool.query(
      `SELECT
         s.id::text,
         s.agent_id,
         m.internal_agent_id,
         s.invocation_id,
         s.sandbox_id,
         s.phase,
         s.wall_clock_ms,
         s.credits_consumed,
         s.timestamp
       FROM sandbox_usage_log s
       LEFT JOIN internal_agent_runtime_mapping m
         ON m.agent_id = s.agent_id AND m.tenant_id = s.tenant_id
       WHERE s.tenant_id = $1
         AND s.timestamp > $2
       ORDER BY s.timestamp ASC, s.id ASC
       LIMIT $3`,
      [tenantId, since, limit],
    );
    return result.rows.map(row => ({
      id:               row.id as string,
      agentId:          row.agent_id as string,
      internalAgentId:  (row.internal_agent_id as string | null) ?? null,
      invocationId:     row.invocation_id as string,
      sandboxId:        row.sandbox_id as string,
      phase:            row.phase as string,
      wallClockMs:      Number(row.wall_clock_ms),
      creditsConsumed:  Number(row.credits_consumed),
      timestamp:        row.timestamp as Date,
    }));
  }

  // Map database row to Thread
  private mapThread(row: Record<string, unknown>): Thread {
    return {
      id: row.id as string,
      tenantId: row.tenant_id as string,
      agentId: row.agent_id as string,
      initiatedByUser: row.initiated_by_user as string | null,
      initiatedByType: row.initiated_by_type as InitiatedByType,
      title: row.title as string | null,
      status: row.status as ThreadStatus,
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    };
  }

  // Map database row to Message
  private mapMessage(row: Record<string, unknown>): Message {
    return {
      id: row.id as string,
      tenantId: row.tenant_id as string,
      threadId: row.thread_id as string,
      role: row.role as MessageRole,
      content: row.content as string,
      toolCalls: row.tool_calls ? this.parseToolCalls(row.tool_calls) : null,
      inputTokens: parseInt(String(row.input_tokens), 10) || 0,
      outputTokens: parseInt(String(row.output_tokens), 10) || 0,
      createdAt: new Date(row.created_at as string),
    };
  }

  // Map database row to Invocation
  // costUsd is derived from price snapshots × token counts (not stored in DB).
  private mapInvocation(row: Record<string, unknown>): Invocation {
    const inputTokens = parseInt(String(row.input_tokens), 10) || 0;
    const outputTokens = parseInt(String(row.output_tokens), 10) || 0;
    const cachedTokens = parseInt(String(row.cached_tokens ?? 0), 10) || 0;
    const inputPricePerMillion = row.input_price_per_million ? parseFloat(String(row.input_price_per_million)) : null;
    const outputPricePerMillion = row.output_price_per_million ? parseFloat(String(row.output_price_per_million)) : null;
    const cachedInputPricePerMillion = row.cached_input_price_per_million ? parseFloat(String(row.cached_input_price_per_million)) : null;

    let costUsd: number | null = null;
    if (inputPricePerMillion != null && outputPricePerMillion != null) {
      const freshInputTokens = freshInputTokensFor(row.provider as LLMProvider, inputTokens, cachedTokens);
      costUsd = (freshInputTokens * inputPricePerMillion + outputTokens * outputPricePerMillion) / 1_000_000;
      if (cachedTokens > 0 && cachedInputPricePerMillion != null) {
        costUsd += (cachedTokens * cachedInputPricePerMillion) / 1_000_000;
      }
    }

    return {
      id: row.id as string,
      tenantId: row.tenant_id as string,
      agentId: row.agent_id as string,
      threadId: row.thread_id as string | null,
      triggeredBy: row.triggered_by as TriggerType,
      triggeredByUserId: (row.triggered_by_user_id as string) ?? null,
      impersonatedBy: (row.impersonated_by as string) ?? null,
      accountableUserId: (row.accountable_user_id as string) ?? null,
      attributionSource: (row.attribution_source as AttributionSource | null) ?? null,
      triggeredByLabel: (row.triggered_by_label as string) ?? null,
      triggerRef: row.trigger_ref as string | null,
      parentInvocationId: (row.parent_invocation_id as string) ?? null,
      modelId: row.model_id as string | null,
      provider: row.provider as string,
      executionEngine: (row.execution_engine as ExecutionEngineId | null) ?? null,
      inputTokens,
      outputTokens,
      cachedTokens,
      costUsd,
      inputPricePerMillion,
      outputPricePerMillion,
      cachedInputPricePerMillion,
      groundingQueries: parseInt(String(row.grounding_queries ?? 0), 10) || 0,
      groundingCostUsd: row.grounding_cost_usd ? parseFloat(String(row.grounding_cost_usd)) : 0,
      // Null, not 0: "no gateway reported a charge" is a different fact from "the
      // gateway charged nothing", and only the first may fall back to the rates.
      vendorCostUsd: row.vendor_cost_usd == null ? null : parseFloat(String(row.vendor_cost_usd)),
      cacheWriteTokens: row.cache_write_tokens == null ? null : parseInt(String(row.cache_write_tokens), 10),
      cacheWritePricePerMillion: row.cache_write_price_per_million == null
        ? null
        : parseFloat(String(row.cache_write_price_per_million)),
      failureClass: (row.failure_class as FailureClass) ?? null,
      toolCalls: row.tool_calls ? this.parseToolCalls(row.tool_calls) : [],
      outcome: row.outcome as InvocationOutcome | null,
      errorMessage: row.error_message as string | null,
      startedAt: new Date(row.started_at as string),
      completedAt: row.completed_at ? new Date(row.completed_at as string) : null,
    };
  }

  // Mark an invocation's billing_queued state. Called after publishing the
  // invocation.completed Pub/Sub event (pending → published) or after the
  // reconciliation cron confirms billing processed it (published → processed).
  async markBillingQueued(
    invocationId: string,
    status: 'pending' | 'published' | 'processed',
  ): Promise<void> {
    await pool.query(
      `UPDATE invocations SET billing_queued = $2 WHERE id = $1`,
      [invocationId, status],
    );
  }

  // Get per-action cost breakdown. Cost fields (llm_cost_usd, connector_cost_usd,
  // input_tokens, output_tokens) are not tracked at action granularity — stubbed as 0.
  // Duration is computed from completed_at - created_at.
  async getActionCosts(
    tenantId: string,
    opts: {
      agentId?: string;
      since: Date;
      until: Date;
      cursor?: string;
      limit: number;
    },
  ): Promise<{
    entries: Array<{
      actionId: string;
      agentId: string;
      workflowId: string;
      connector: string;
      actionType: string;
      llmCostUsd: number;
      connectorCostUsd: number;
      inputTokens: number;
      outputTokens: number;
      durationMs: number;
      occurredAt: Date;
    }>;
    nextCursor: string | null;
  }> {
    const params: unknown[] = [tenantId, opts.since, opts.until, opts.limit + 1];
    let agentClause = '';
    let cursorClause = '';
    if (opts.agentId) {
      params.push(opts.agentId);
      agentClause = `AND al.agent_id = $${params.length}`;
    }
    if (opts.cursor) {
      params.push(opts.cursor);
      cursorClause = `AND al.created_at < $${params.length}`;
    }
    const result = await pool.query(
      `SELECT al.id          AS action_id,
              al.agent_id,
              al.workflow_id,
              al.connector,
              al.action_type,
              0.0            AS llm_cost_usd,
              0.0            AS connector_cost_usd,
              0              AS input_tokens,
              0              AS output_tokens,
              COALESCE(
                EXTRACT(EPOCH FROM (al.completed_at - al.created_at)) * 1000,
                0
              )              AS duration_ms,
              al.created_at  AS occurred_at
       FROM actions al
       WHERE al.tenant_id = $1
         AND al.created_at >= $2
         AND al.created_at <  $3
         AND al.completed_at IS NOT NULL
         ${agentClause}
         ${cursorClause}
       ORDER BY al.created_at DESC
       LIMIT $4`,
      params,
    );
    const hasMore = result.rows.length > opts.limit;
    const rows = hasMore ? result.rows.slice(0, opts.limit) : result.rows;
    return {
      entries: rows.map(r => ({
        actionId: r.action_id as string,
        agentId: r.agent_id as string,
        workflowId: r.workflow_id as string,
        connector: r.connector as string,
        actionType: r.action_type as string,
        llmCostUsd: 0,
        connectorCostUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        durationMs: parseFloat(r.duration_ms) || 0,
        occurredAt: new Date(r.occurred_at as string),
      })),
      nextCursor: hasMore ? (rows[rows.length - 1].occurred_at as Date).toISOString() : null,
    };
  }

  private parseToolCalls(raw: unknown): ToolCallRecord[] {
    if (Array.isArray(raw)) {
      return raw as ToolCallRecord[];
    }
    if (typeof raw === 'string') {
      try {
        return JSON.parse(raw);
      } catch {
        return [];
      }
    }
    return [];
  }
}

export const invocationsService = new InvocationsService();
