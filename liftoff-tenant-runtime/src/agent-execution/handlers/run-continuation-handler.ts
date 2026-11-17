// Continuing a run that outgrew one invocation.
//
// The wall clock is two ceilings wearing one hat. It stops a runaway, and it
// stops work that is simply LONGER than a single invocation. Only the second is
// a false positive, and it is the common one: a sixteen-step workflow asked for
// on demand is behaving perfectly and needs more than ten minutes. Treating it
// as a failure loses everything the run did and tells the person nothing.
//
// So a run that reaches the ceiling AT A STEP BOUNDARY parks and continues in a
// fresh invocation, and the runaway half of the ceiling is preserved by capping
// the CHAIN instead of the single run.
//
// The step boundary is what makes this safe. The ceiling is checked at the top
// of the step loop, before the step runs, so the cut point is between two steps:
// nothing is half-done, nothing is repeated, and the carried cursor is the step
// that was about to start. A mid-step cut would have to re-run the step, and a
// step that already sent an email cannot be re-run.
//
// Rides the delay-step rails rather than inventing new ones: the same
// agent_scheduled_invocations row, the same Cloud Task, the same
// /api/tasks/resume-execution receiver, the same resumeWorkflow cursor. The one
// difference is that the payload lives in the ROW rather than the task body,
// because a carried stepOutput can be large and a Cloud Task body cannot.

import { enqueueAgentExecution } from '../../infrastructure/cloud-tasks';
import { agentScheduledInvocationsRepo } from '../../scheduling/agent-scheduled-invocations-repo';
import { logger } from '../../infrastructure/logging';
import {
  MAX_RUN_CONTINUATIONS, MAX_CONTINUATION_TOOL_CALLS, MAX_NON_ADVANCING_CONTINUATIONS,
} from '../constants';
import type { AdmissionResult } from '../../admission/service';
import type { HybridResumeState } from '../service';
import type { SalvageNote } from '../engine/step-salvage-prompt';

/** Everything the next invocation needs to pick the run up where it stopped.
 *
 *  Persisted on the scheduled row, not in the Cloud Task body. */
export interface RunContinuationPayload {
  kind: 'run-continuation';
  workflowId: string;
  taskId: string;
  /** The step that was ABOUT to run when the clock ran out. */
  resumeAtStepId: string;
  stepOutput: unknown;
  objective: string;
  inputData: Record<string, unknown> | undefined;
  perStepRecoveries: Record<string, number>;
  totalRecoveries: number;
  recoveryHistory: HybridResumeState['recoveryHistory'];
  /** Every completed step's output, keyed by step id. The half of the state
   *  that is invisible when it goes missing: the run resumes, the cursor is
   *  right, and every `$.steps.<id>` reference into the first half reads
   *  undefined. */
  stepOutputs?: Record<string, unknown>;
  enteredSteps?: string[];
  unsatisfiedSteps?: string[];
  /** Steps a salvage turn finished from partial material, and what each was
   *  missing — the same two fields every other pause payload carries. */
  salvagedSteps?: string[];
  salvageNotes?: Record<string, SalvageNote>;
  /** 1 for the first continuation of an original run. Bounds the chain. */
  continuationDepth: number;
  /** Tool calls executed across the whole chain so far. The per-run ceiling
   *  resets every continuation, so the chain needs its own. */
  cumulativeToolCalls: number;
  /** The chat thread that asked, when a person did. Null for autonomous runs,
   *  which have nowhere to deliver and simply finish. */
  threadId: string | null;
}

/** Whether a chain has moved since its last continuation.
 *
 *  Progress is any of three things, because a workflow can advance in three
 *  ways and a chain that is doing one of them is not stuck:
 *
 *    - the cursor moved to another step;
 *    - a step registered an output it had not before;
 *    - a LOOP consumed another item, which is how a long per-item step
 *      advances while its cursor deliberately stays put.
 *
 *  The third is why "the cursor did not move" cannot be the test on its own:
 *  once a loop parks on its own step, every continuation of a hundred-item
 *  loop reports the same cursor and is progressing perfectly. */
export interface ContinuationProgress {
  cursor: string;
  stepOutputCount: number;
  loopIndex: number | null;
}

export function hasAdvanced(
  previous: ContinuationProgress | null,
  next: ContinuationProgress,
): boolean {
  if (!previous) return true;
  if (previous.cursor !== next.cursor) return true;
  if (next.stepOutputCount > previous.stepOutputCount) return true;
  if (next.loopIndex !== null && (previous.loopIndex === null || next.loopIndex > previous.loopIndex)) {
    return true;
  }
  return false;
}

/** Whether a run that ran out of wall clock may continue, and what to say when
 *  it may not.
 *
 *  THE CAP IS THE SPEND, not the clock. A run doing the work it was asked to do
 *  continues while the workspace can pay for it; a workspace that cannot is
 *  stopped by the one money authority. That signal is read from
 *  `admissionService` and never computed here — the runtime forming its own
 *  opinion about a balance is what INV-PB-010 forbids, and two gates reading
 *  different facts is how they diverge.
 *
 *  Three other things can stop a chain, in descending likelihood of mattering:
 *  it stopped ADVANCING (a defect burning a balance, which the person is better
 *  served by stopping), or an operator has imposed one of the two backstops,
 *  which are unset by default.
 *
 *  Async now. It was pure, and the comment said that was so the bounds could be
 *  exercised directly — true of the arithmetic and not of the question actually
 *  being asked, which is whether this workspace may keep working. */
export async function assessContinuation(args: {
  /** The admission check, injected rather than constructed here: the execution
   *  service already holds an `AdmissionService` with its own entitlement
   *  cache, and a second instance would answer the same question off a
   *  different read. */
  admit: () => Promise<AdmissionResult>;
  depth: number;
  cumulativeToolCalls: number;
  /** Where the chain was at its previous park, absent on the first. */
  previousProgress?: ContinuationProgress | null;
  /** Where it is now. */
  progress?: ContinuationProgress;
  /** Consecutive non-advancing continuations before this one. */
  nonAdvancing?: number;
}): Promise<{ ok: true; nonAdvancing: number } | { ok: false; error: string }> {
  // THE CAP. Suspension, billing suspension, a paused agent, a kill switch —
  // all of it resolved by the service that owns the question.
  const admission = await args.admit();
  if (!admission.allowed) {
    return {
      ok: false,
      error: `Run stopped before continuing: ${admission.detail ?? admission.reason ?? 'not admitted'}`,
    };
  }

  // A chain that is not moving is a defect, not long work.
  const advanced = args.progress ? hasAdvanced(args.previousProgress ?? null, args.progress) : true;
  const nonAdvancing = advanced ? 0 : (args.nonAdvancing ?? 0) + 1;
  if (nonAdvancing >= MAX_NON_ADVANCING_CONTINUATIONS) {
    return {
      ok: false,
      error: `Run stopped after ${nonAdvancing} continuations that made no progress`
        + `${args.progress ? ` (still at ${args.progress.cursor})` : ''}`,
    };
  }

  // Operator backstops. Unset, these do not bound a progressing run.
  if (args.depth > MAX_RUN_CONTINUATIONS) {
    return {
      ok: false,
      error: `Run stopped after ${MAX_RUN_CONTINUATIONS} continuations without finishing`,
    };
  }
  if (args.cumulativeToolCalls > MAX_CONTINUATION_TOOL_CALLS) {
    return {
      ok: false,
      error: `Run stopped after ${args.cumulativeToolCalls} tool calls across its continuations`
        + ` (limit ${MAX_CONTINUATION_TOOL_CALLS})`,
    };
  }
  return { ok: true, nonAdvancing };
}

export interface ScheduleRunContinuationInput {
  tenantId: string;
  agentId: string;
  invocationId: string;
  payload: RunContinuationPayload;
}

/**
 * Park the run and schedule it to pick up immediately in a fresh invocation.
 *
 * Answers with the scheduled row's id, or null when the continuation could not
 * be scheduled. Null means the caller must fail the run the way it always has:
 * a continuation that was not actually scheduled must never be reported as one,
 * or the person is told their work is still running when nothing is.
 */
export async function scheduleRunContinuation(
  input: ScheduleRunContinuationInput,
): Promise<string | null> {
  const { tenantId, agentId, invocationId, payload } = input;
  // Now, not in a minute. The run is not waiting for anything — it ran out of
  // room, and the only reason for a new invocation is a fresh ceiling.
  const firesAt = new Date();
  const scheduleKey = firesAt.toISOString().slice(0, 16);
  // Unique per RUN, not per workflow step. Two runs of the same workflow can
  // park at the same step in the same minute, and the default task name is
  // built from (agent, minute, contextRef) -- so a shared ref would make one
  // run's continuation collide with the other's and quietly not be scheduled.
  const contextRef = `continuation:${payload.workflowId}:${invocationId}`;

  try {
    const row = await agentScheduledInvocationsRepo.insert({
      tenantId,
      agentId,
      threadId: payload.threadId,
      contextRef,
      scheduleKey,
      firesAt,
      objective: 'run-continuation',
      scheduledByInvocationId: invocationId,
      workflowResume: payload as unknown as Record<string, unknown>,
    });

    const enqueued = await enqueueAgentExecution(tenantId, agentId, {
      workflowId: payload.workflowId,
      taskId: payload.taskId,
      objective: 'run-continuation',
      threadId: payload.threadId ?? '',
      triggeredBy: 'agent',
      triggeredByLabel: `run_continuation:${payload.continuationDepth}`,
      scheduleKey,
      scheduleTime: firesAt,
      contextRef,
      // Names the task after the scheduled ROW, so Cloud Tasks itself enforces
      // one live continuation per row: a duplicate arming collides there rather
      // than becoming a second invocation running the same steps.
      taskIdentity: row.id,
      receiverPath: '/api/tasks/resume-execution',
      // Ids only. The state itself is on the row above, because a carried
      // stepOutput can be larger than a Cloud Task body is allowed to be.
      receiverBody: {
        tenantId,
        agentId,
        invocationId,
        workflowResume: {
          scheduledInvocationId: row.id,
          kind: 'run-continuation',
        },
      },
    });
    await agentScheduledInvocationsRepo.updateCloudTaskName(row.id, enqueued.taskName);

    logger.info('Run parked to continue in a fresh invocation', {
      tenant_id: tenantId,
      agent_id: agentId,
      invocation_id: invocationId,
      scheduled_invocation_id: row.id,
      resume_at_step_id: payload.resumeAtStepId,
      continuation_depth: payload.continuationDepth,
      cumulative_tool_calls: payload.cumulativeToolCalls,
    });
    return row.id;
  } catch (err) {
    // Reported, never thrown: the caller's fallback is the behaviour we already
    // had, and a failure to schedule must not also destroy the error the run
    // was going to return.
    logger.error('Could not schedule run continuation; run will end as it did before', {
      tenant_id: tenantId,
      agent_id: agentId,
      invocation_id: invocationId,
      error: (err as Error).message,
    });
    return null;
  }
}
