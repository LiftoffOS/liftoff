// J3 — consecutive-failure tracking per routine.
//
// A run that fails is a normal event. A routine where EVERY run fails is a
// configuration problem that no amount of retrying will fix, and left alone it
// produces one error per tick forever. This counts the unbroken streak and, at
// the threshold, pauses that routine's Cloud Scheduler job.
//
// Deliberately per-routine, not per-agent: an agent with four routines should
// not lose the three that work because the fourth is broken.

import { getPoolForService } from '../infrastructure/database';
import { logger } from '../infrastructure/logging';
import type { FailureClass } from '../invocations/types';

/** Failure classes that say nothing about whether the routine is CONFIGURED
 *  wrong, which is the only thing this counter exists to detect.
 *
 *  Every provider_* class is somebody else's outage or somebody else's account
 *  problem; `context_overflow` is a conversation that grew, not a routine that
 *  is broken; and the three pre-invocation guards mean the run never started at
 *  all — an agent that is busy or paused, or a tenant whose entitlement lapsed.
 *  Counting any of these lets a healthy routine reach the threshold and have
 *  its agent stopped for a reason that would have cleared itself. */
const NON_ROUTINE_FAILURE_CLASSES: ReadonlySet<FailureClass> = new Set<FailureClass>([
  'provider_capacity',
  'provider_server_error',
  'provider_network',
  'provider_auth',
  'provider_quota',
  'context_overflow',
  'admission_denied',
  'agent_busy',
  'lifecycle_not_active',
]);

/** Whether a failure of this class is evidence the ROUTINE is broken.
 *
 *  An absent class counts. That preserves today's behaviour for callers that do
 *  not classify — notably the routine-script failures in
 *  scheduled-invoke-handler, which are deterministic configuration faults and
 *  are exactly what the threshold is for. */
export function countsTowardRoutinePause(failureClass?: FailureClass | null): boolean {
  if (!failureClass) return true;
  return !NON_ROUTINE_FAILURE_CLASSES.has(failureClass);
}

/** Consecutive failures before the routine is paused. Three is enough to rule
 *  out a transient upstream (one bad tick, or two) without letting a genuinely
 *  broken routine run all day. */
export const ROUTINE_FAILURE_PAUSE_THRESHOLD = Number(
  process.env.ROUTINE_FAILURE_PAUSE_THRESHOLD ?? 3,
);

function pool() {
  return getPoolForService('scheduled-execution');
}

/** A routine finished successfully: forget the streak. Also clears a pause that
 *  a human has already released, so a healed routine does not carry a stale
 *  flag that would block the reconciler forever. */
export async function recordRoutineSuccess(
  agentId: string,
  triggeredByLabel: string | undefined,
): Promise<void> {
  if (!triggeredByLabel) return;
  try {
    await pool().query(
      `UPDATE routine_failure_state
          SET consecutive_failures = 0, last_error = NULL, updated_at = NOW()
        WHERE agent_id = $1::uuid AND triggered_by_label = $2`,
      [agentId, triggeredByLabel],
    );
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, agentId, triggeredByLabel },
      'routine failure state: success reset failed (non-fatal)',
    );
  }
}

/** A routine failed. Returns the new streak length, or null when it could not
 *  be recorded — callers treat null as "do not act". */
export async function recordRoutineFailure(
  agentId: string,
  triggeredByLabel: string | undefined,
  errorMessage: string | undefined,
): Promise<number | null> {
  if (!triggeredByLabel) return null;
  try {
    const r = await pool().query<{ consecutive_failures: number }>(
      `INSERT INTO routine_failure_state (agent_id, triggered_by_label, consecutive_failures, last_failure_at, last_error)
       VALUES ($1::uuid, $2, 1, NOW(), $3)
       ON CONFLICT (agent_id, triggered_by_label) DO UPDATE
         SET consecutive_failures = routine_failure_state.consecutive_failures + 1,
             last_failure_at = NOW(),
             last_error = EXCLUDED.last_error,
             updated_at = NOW()
       RETURNING consecutive_failures`,
      [agentId, triggeredByLabel, (errorMessage ?? '').slice(0, 2000)],
    );
    return r.rows[0]?.consecutive_failures ?? null;
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, agentId, triggeredByLabel },
      'routine failure state: failure record failed (non-fatal)',
    );
    return null;
  }
}

/** Record a routine run's outcome and, at the threshold, pause the agent.
 *
 *  Everything here is best-effort: a routine that ran must never be reported as
 *  failed because the bookkeeping around it failed. */
export async function recordRoutineOutcome(params: {
  tenantId: string;
  agentId: string;
  triggeredByLabel: string | undefined;
  success: boolean;
  error?: string;
  /** WHY it failed. Absent counts as a routine failure — see
   *  countsTowardRoutinePause. */
  failureClass?: FailureClass | null;
}): Promise<void> {
  // Only per-routine jobs are pausable in isolation. An unlabelled run belongs
  // to the agent's primary schedule, and pausing that is an agent-level
  // decision a human makes, not one a failure counter should make.
  if (!params.triggeredByLabel?.startsWith('companion:')) return;

  // A failure that says nothing about the routine's configuration is not
  // evidence, so it neither adds to the streak nor clears it: the run simply did
  // not happen. Clearing would let one 429 between two genuine failures reset a
  // routine that IS broken back to zero, forever.
  if (!params.success && !countsTowardRoutinePause(params.failureClass)) {
    logger.info(
      {
        event: 'routine_failure_not_counted',
        tenantId: params.tenantId,
        agentId: params.agentId,
        triggeredByLabel: params.triggeredByLabel,
        failureClass: params.failureClass,
      },
      'routine failure not counted toward the pause threshold (not a routine configuration fault)',
    );
    return;
  }

  try {
    if (params.success) {
      await recordRoutineSuccess(params.agentId, params.triggeredByLabel);
      return;
    }

    const streak = await recordRoutineFailure(params.agentId, params.triggeredByLabel, params.error);
    if (streak == null || streak < ROUTINE_FAILURE_PAUSE_THRESHOLD) return;

    // Stop the AGENT, through the same status the operator's Pause button sets.
    // Pausing the Cloud Scheduler job instead — which is what this did — put the
    // routine in a state the status column did not show and the Resume button
    // did not reach.
    //
    // PB's status is the control-plane id space, so the runtime id has to be
    // translated first; a runtime id matches zero rows there and would fail
    // silently (INV-TR-010).
    const { resolveInternalAgentId } = await import('../agent-lifecycle/resolve-runtime-agent-id');
    const internalAgentId = await resolveInternalAgentId(
      params.tenantId,
      params.agentId,
      'routine-failure-pause',
    );
    if (!internalAgentId) return;

    const { pauseCanonicalAgent } = await import('../clients/platform-backend-client');
    await pauseCanonicalAgent(params.tenantId, internalAgentId);

    logger.error(
      {
        event: 'routine_failure_paused',
        tenantId: params.tenantId,
        agentId: params.agentId,
        internalAgentId,
        triggeredByLabel: params.triggeredByLabel,
        consecutiveFailures: streak,
        lastError: params.error,
      },
      'agent paused after consecutive routine failures; Resume in the dashboard restarts it',
    );
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, agentId: params.agentId, triggeredByLabel: params.triggeredByLabel },
      'routine failure state: outcome handling failed (non-fatal)',
    );
  }
}
