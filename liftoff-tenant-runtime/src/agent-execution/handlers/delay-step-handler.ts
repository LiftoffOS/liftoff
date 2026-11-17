// Workflow delay step handler.
//
// When the workflow executor encounters a `delay` step, this handler:
//   1. Computes resumeAt from durationSeconds or untilIso (60s..30d bounds).
//   2. Persists a row in agent_scheduled_invocations with workflow_resume_payload
//      carrying everything needed to restart the workflow at the next step
//      (workflowId, taskId, agentId, resumeAfterStepId, carry-over stepOutput).
//   3. Enqueues a Cloud Task with scheduleTime=resumeAt that targets the
//      existing /api/tasks/resume-execution handler. The handler detects the
//      pending row by scheduled_by_invocation_id and dispatches to the
//      workflow-resume path instead of the engine-session-resume path
//      (workflows have no JSONL engine session — their entire state is the
//      deterministic step position).

import { enqueueAgentExecution } from '../../infrastructure/cloud-tasks';
import { agentScheduledInvocationsRepo } from '../../scheduling/agent-scheduled-invocations-repo';
import { logger } from '../../infrastructure/logging';

export interface DelayHandlerInput {
  tenantId: string;
  agentId: string;
  workflowId: string;
  taskId: string;
  stepId: string;
  invocationId: string;
  threadId?: string;
  config: { durationSeconds?: number; untilIso?: string; contextRef?: string };
  resumeAfterStepId: string;
  /** Carry-over stepOutput at the moment of suspension. JSON-serialisable. */
  stepOutput?: unknown;
  /** The rest of the run's state — the step-output registry above all.
   *
   *  A delay resume used to carry the cursor and the last output and nothing
   *  else, so every `$.steps.<id>` reference into the part of the graph that
   *  ran before the wait read undefined after it. */
  carried?: Record<string, unknown>;
}

export async function handleDelayStep(input: DelayHandlerInput): Promise<{ paused: true; resumeAt: Date }> {
  // 1. Compute fire time
  const now = new Date();
  let resumeAt: Date;
  if (input.config.durationSeconds != null) {
    resumeAt = new Date(now.getTime() + input.config.durationSeconds * 1000);
  } else if (input.config.untilIso) {
    resumeAt = new Date(input.config.untilIso);
    if (Number.isNaN(resumeAt.getTime())) {
      throw new Error(`delay.untilIso is not a valid ISO date: ${input.config.untilIso}`);
    }
  } else {
    throw new Error('delay step requires durationSeconds or untilIso');
  }
  const deltaMs = resumeAt.getTime() - now.getTime();
  if (deltaMs < 60_000 || deltaMs > 30 * 24 * 60 * 60 * 1000) {
    throw new Error(`delay step out of range: must be 60s-30d, got ${deltaMs}ms`);
  }

  const contextRef = input.config.contextRef ?? `${input.workflowId}:${input.stepId}`;
  const scheduleKey = resumeAt.toISOString().slice(0, 16);

  // 2. Persist the scheduling intent with full workflow-resume payload.
  const row = await agentScheduledInvocationsRepo.insert({
    tenantId: input.tenantId,
    agentId: input.agentId,
    contextRef,
    threadId: input.threadId ?? null,
    firesAt: resumeAt,
    objective: 'workflow-resume',
    scheduleKey,
    scheduledByInvocationId: input.invocationId,
    // The whole payload lives HERE, not in the Cloud Task body.
    //
    // A task body is capped at 100KB and the carried registry holds every
    // completed step's output, which for a research workflow is the gathered
    // data itself. Putting it on the row makes the size Postgres's problem
    // rather than a delivery failure nobody sees until a long run pauses.
    workflowResume: {
      kind: 'workflow-delay',
      workflowId: input.workflowId,
      invocationId: input.invocationId,
      taskId: input.taskId,
      resumeAfterStepId: input.resumeAfterStepId,
      stepOutput: input.stepOutput,
      ...(input.carried ?? {}),
    },
  });

  // 3. Enqueue the resume task. Receiver body carries the IDs the resume route
  //    needs; the route looks up the agent_scheduled_invocations row by
  //    scheduled_by_invocation_id to recover the carry-over state.
  const enqueueResult = await enqueueAgentExecution(input.tenantId, input.agentId, {
    workflowId: input.workflowId,
    taskId: input.taskId,
    objective: 'workflow-resume',
    threadId: input.threadId ?? '',
    triggeredBy: 'agent',
    triggeredByLabel: `workflow_delay:${input.workflowId}`,
    scheduleKey,
    scheduleTime: resumeAt,
    contextRef,
    receiverPath: '/api/tasks/resume-execution',
    receiverBody: {
      tenantId: input.tenantId,
      agentId: input.agentId,
      invocationId: input.invocationId,
      // Ids only. The state is on the row above; the body keeps the cursor for
      // back-compat with a receiver that has not learned to read the row yet.
      workflowResume: {
        scheduledInvocationId: row.id,
        workflowId: input.workflowId,
        taskId: input.taskId,
        resumeAfterStepId: input.resumeAfterStepId,
      },
    },
  });
  await agentScheduledInvocationsRepo.updateCloudTaskName(row.id, enqueueResult.taskName);

  logger.info('Workflow delay step paused', {
    workflowId: input.workflowId,
    stepId: input.stepId,
    resumeAt: resumeAt.toISOString(),
    scheduledInvocationId: row.id,
  });

  return { paused: true, resumeAt };
}
