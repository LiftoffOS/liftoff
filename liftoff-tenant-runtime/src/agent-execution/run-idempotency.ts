// Run-level agent idempotency (plan §4.7).
//
// Claims a row in `event_processing_ledger` — the existing general-purpose
// claim-before idempotency ledger (migration 050) — keyed `event_id = triggerKey`,
// `event_type='agent_run'`, so a redelivery of the *same trigger* does not re-run
// the agent. Models the proven `EventProcessor.claimEvent` state machine
// (src/events/event-processor.ts): first delivery runs; `completed` → replay the
// cached result; `failed` → re-run; stale `processing` (>5 min, crashed handler)
// → reclaim; active `processing` (<5 min) → skip (another delivery owns it).
//
// Fail-open: any DB error proceeds (never block a real run on bookkeeping).
//
// Both entry paths use this now: the inline webhook→executeTask path
// (triggerKey = event_id) and the Cloud Tasks path (triggerKey = the stable
// X-CloudTasks-TaskName). This fully replaces the retired runWithTaskIdempotency
// / cloud_task_executions — including its post-LLM-bookkeeping replay (the full
// result is stored in idempotency_result_payloads for full-fidelity replay) and
// the abandonment bug (event_processing_ledger's 5-min stale-reclaim).

import { getPoolForService } from '../infrastructure/database';
import { logger } from '../infrastructure/logging';
import type { TaskExecutionResult } from './types';

export type RunClaim =
  | { outcome: 'run' }                              // proceed: first / failed-reset / stale-reclaim
  | { outcome: 'replay'; result: TaskExecutionResult } // already completed — return cached
  | { outcome: 'skip' };                            // active processing (<5 min) — another delivery owns it

// > heartbeat-equivalent: `updated_at` bumps as the run completes, so an
// actively-working run never looks stale. Matches EventProcessor's window.
const STALE_INTERVAL = "INTERVAL '5 minutes'";

function ledgerPool() {
  // Same pool delegateToAgent uses for event_processing_ledger (service.ts).
  return getPoolForService('default');
}

export async function claimAgentRun(input: {
  tenantId: string;
  triggerKey: string;
}): Promise<RunClaim> {
  try {
    const claimed = await ledgerPool().query<{ status: string }>(
      `INSERT INTO event_processing_ledger
         (tenant_id, event_id, event_type, entity_type, entity_id)
       VALUES ($1::uuid, $2, 'agent_run', 'agent_run', $2)
       ON CONFLICT (tenant_id, event_id) DO UPDATE SET
         attempt_count = event_processing_ledger.attempt_count + 1,
         status = CASE WHEN event_processing_ledger.status = 'failed' THEN 'processing'
                       ELSE event_processing_ledger.status END,
         updated_at = NOW()
       WHERE event_processing_ledger.status = 'failed'
          OR (event_processing_ledger.status = 'processing'
              AND event_processing_ledger.updated_at < NOW() - ${STALE_INTERVAL})
       RETURNING status`,
      [input.tenantId, input.triggerKey],
    );
    if (claimed.rows.length > 0) return { outcome: 'run' };

    // RETURNING empty → the row exists and was excluded by the WHERE: either
    // completed (replay) or actively processing (<5 min, skip).
    const existing = await ledgerPool().query<{ status: string; result_metadata: TaskExecutionResult | null }>(
      `SELECT status, result_metadata FROM event_processing_ledger
       WHERE tenant_id = $1::uuid AND event_id = $2`,
      [input.tenantId, input.triggerKey],
    );
    const row = existing.rows[0];
    if (!row) return { outcome: 'run' }; // race between the two queries — safe to proceed
    if (row.status === 'completed') {
      // Full-fidelity replay: the Cloud Tasks path re-drives progressWorkflow with
      // result.output, so the whole TaskExecutionResult is stored in the side
      // table (it can exceed result_metadata's 4096 cap), keyed by triggerKey.
      const full = await loadRunResult(input.tenantId, input.triggerKey);
      return {
        outcome: 'replay',
        result: (full as TaskExecutionResult | null)
          ?? (row.result_metadata as TaskExecutionResult | null)
          ?? { success: true, toolCallsExecuted: 0, reasoningSteps: 0 },
      };
    }
    return { outcome: 'skip' };
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, triggerKey: input.triggerKey },
      'claimAgentRun failed; running without run-idempotency (fail-open)',
    );
    return { outcome: 'run' };
  }
}

/** Mark the run terminal. Paused/escalated count as terminal for the trigger —
 *  the trigger WAS processed (it suspended); the resume is a separate flow, and
 *  leaving the row `processing` would let the 5-min reclaim wrongly re-run it. */
export async function completeAgentRun(input: {
  tenantId: string;
  triggerKey: string;
  result: TaskExecutionResult;
}): Promise<void> {
  try {
    // Full result in the side table (keyed by triggerKey) for full-fidelity
    // replay; a compact summary in result_metadata for cheap inspection.
    await ledgerPool().query(
      `INSERT INTO idempotency_result_payloads (step_key, tenant_id, payload)
       VALUES ($1, $2::uuid, $3::jsonb)
       ON CONFLICT (step_key) DO UPDATE SET payload = EXCLUDED.payload`,
      [`run:${input.triggerKey}`, input.tenantId, JSON.stringify(input.result)],
    );
    const compact: TaskExecutionResult = {
      success: input.result.success,
      toolCallsExecuted: input.result.toolCallsExecuted,
      reasoningSteps: input.result.reasoningSteps,
      ...(input.result.escalated ? { escalated: true } : {}),
      ...(input.result.paused ? { paused: true } : {}),
      // Carry the terminal verdict through the replay path. Without these, a
      // redelivery served from result_metadata would fall back to boolean
      // precedence and downgrade a deliberate task_failed into engine_error —
      // re-opening the trigger row this result was meant to close.
      ...(input.result.terminalState ? { terminalState: input.result.terminalState } : {}),
      ...(input.result.failureClass ? { failureClass: input.result.failureClass } : {}),
    };
    await ledgerPool().query(
      `UPDATE event_processing_ledger
         SET status='completed', completed_at=NOW(), updated_at=NOW(), result_metadata=$3::jsonb
       WHERE tenant_id=$1::uuid AND event_id=$2 AND status='processing'`,
      [input.tenantId, input.triggerKey, JSON.stringify(compact)],
    );
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, triggerKey: input.triggerKey },
      'completeAgentRun failed (non-fatal)',
    );
  }
}

async function loadRunResult(tenantId: string, triggerKey: string): Promise<unknown> {
  try {
    const res = await ledgerPool().query<{ payload: unknown }>(
      `SELECT payload FROM idempotency_result_payloads
       WHERE step_key = $1 AND tenant_id = $2::uuid`,
      [`run:${triggerKey}`, tenantId],
    );
    return res.rows[0]?.payload ?? null;
  } catch {
    return null;
  }
}

/** Mark the run failed so a redelivery re-runs it. */
export async function failAgentRun(input: {
  tenantId: string;
  triggerKey: string;
  error: string;
}): Promise<void> {
  await ledgerPool()
    .query(
      `UPDATE event_processing_ledger SET status='failed', error=$3, updated_at=NOW()
       WHERE tenant_id=$1::uuid AND event_id=$2 AND status='processing'`,
      [input.tenantId, input.triggerKey, input.error.slice(0, 1024)],
    )
    .catch(() => undefined);
}
