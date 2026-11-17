/**
 * Wall-clock telemetry for distillation (migration 416).
 *
 * `llm_usage_log` already records tokens per call, but nothing records how long
 * a distillation took. Every latency number in the split plan
 * (liftoff-react docs/distill-split-plan.md) is extrapolated from one 80 tok/s
 * measurement written into a comment, and that is not enough to decide whether
 * to split the pipeline, nor to tell afterwards whether the split helped.
 *
 * One row per LLM call, not per distillation. The waved strategy issues six,
 * and the question the comparison asks is which of them the person is waiting
 * on — so the branch has to be on the row. `runId` groups the calls belonging
 * to one distillation.
 *
 * BEST-EFFORT BY CONSTRUCTION. Telemetry that can fail a distillation is worse
 * than no telemetry: the whole point of this table is to make a latency
 * decision safely, and it would be absurd for the measurement to become a new
 * failure mode for the thing being measured. Every function here swallows its
 * errors and logs. Callers are not expected to await them for correctness.
 */
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { withTenantScope } from '../infrastructure/database';
import { log } from '../infrastructure/logging';

/** Which arm produced this call. `single` is today's one-call distillation. */
export type DistillStrategy = 'single' | 'waved';

/**
 * `single` for the control arm. `wave1` / `wave2` for the split arm's two
 * concurrent groups. `capability` is its own phase rather than part of wave 2
 * because findCapabilityViolations runs after fan-in, spans fields from both
 * waves, and can re-run branches (split plan section 5b). `patch` is the
 * distiller's field-edit call on a rejected graph (distill-patch.ts): one row
 * per call, under the run and attempt it belongs to, so its measured cost can
 * be set against the regeneration it stood in for. `bind` is the bind rung's
 * Jev call (distill-bind.ts), the same way — provider `typesafe`; the rung's
 * deterministic branch makes no LLM call and writes no row. The column is a
 * bare VARCHAR(16) with no CHECK, so no migration widens anything.
 */
export type DistillPhase = 'single' | 'wave1' | 'capability' | 'graph' | 'wave2' | 'patch' | 'bind';

/** Which artifact the call produced. `single` for the control arm. */
export type DistillBranch =
  | 'single'
  | 'summary'
  | 'system_prompt'
  | 'graph'
  | 'capability'
  | 'user_instructions'
  | 'instructions_md'
  | 'skills';

/**
 * `truncated` is deliberately distinct from `error`. The max_tokens guard in
 * distill-service refuses the whole result rather than persisting a half-written
 * agent, so an arm that truncates more often is a real regression — and folding
 * it into a generic error count would hide exactly that.
 */
export type DistillOutcome = 'ok' | 'validation_failed' | 'truncated' | 'error';

export interface DistillCallUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface DistillCallRecord {
  runId: string;
  /** Absent on some internal callers; the row is skipped rather than invented. */
  tenantId?: string;
  /** Set only on a redistill, mirroring how the distill service tells the two apart. */
  agentId?: string;
  sessionId?: string;
  purpose: 'distill' | 'distill_update';
  strategy: DistillStrategy;
  phase: DistillPhase;
  branch: DistillBranch;
  /** 1-based, matching the existing retry loop's `attempt + 1` logging. */
  attempt: number;
  /** Set on a shadow run: the run id of the real distillation it shadows. */
  shadowOfRunId?: string;
  startedAt: Date;
  endedAt: Date;
  /** Which model served it. Needed for the cost half of the comparison, which
   *  runs through the provider-aware computeRowCost. */
  provider?: string;
  model?: string;
  usage?: DistillCallUsage;
  outcome: DistillOutcome;
  error?: string;
}

/** Groups every call belonging to one distillation. */
export function newDistillRunId(): string {
  return randomUUID();
}

/**
 * Persist one call's timing. Never throws.
 *
 * A missing tenantId skips the row rather than writing a placeholder: the table
 * is RLS-forced on tenant_id, and a synthetic tenant would either fail the
 * policy or, worse, pollute a real tenant's telemetry.
 */
export async function recordDistillCall(record: DistillCallRecord): Promise<void> {
  if (!record.tenantId) {
    log.debug(
      { runId: record.runId, branch: record.branch },
      'distill_runs: no tenantId on this call, skipping telemetry row',
    );
    return;
  }

  const durationMs = record.endedAt.getTime() - record.startedAt.getTime();

  try {
    await withTenantScope(record.tenantId, async (client: PoolClient) => {
      await client.query(
        `INSERT INTO distill_runs (
           run_id, tenant_id, agent_id, session_id, purpose,
           strategy, phase, branch, attempt, shadow_of_run_id,
           started_at, ended_at, duration_ms,
           provider, model,
           input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
           outcome, error_message
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)`,
        [
          record.runId,
          record.tenantId,
          record.agentId ?? null,
          record.sessionId ?? null,
          record.purpose,
          record.strategy,
          record.phase,
          record.branch,
          record.attempt,
          record.shadowOfRunId ?? null,
          record.startedAt,
          record.endedAt,
          durationMs,
          record.provider ?? null,
          record.model ?? null,
          record.usage?.inputTokens ?? null,
          record.usage?.outputTokens ?? null,
          record.usage?.cacheReadTokens ?? null,
          record.usage?.cacheWriteTokens ?? null,
          record.outcome,
          record.error ?? null,
        ],
      );
    });
  } catch (err) {
    // Swallowed on purpose — see the module header.
    log.warn(
      {
        error: (err as Error).message,
        runId: record.runId,
        branch: record.branch,
        tenantId: record.tenantId,
      },
      'distill_runs: failed to record call telemetry',
    );
  }
}
