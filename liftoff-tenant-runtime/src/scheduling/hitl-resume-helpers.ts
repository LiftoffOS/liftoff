// HITL approval / rejection resume — Cloud Task enqueue helper.
//
// Modeled exactly on `clarification-resume-helpers.ts`. Called by the
// approval router (`hitl-enforcement/router.ts`) after the operator clicks
// Approve or Reject; fires a Cloud Task that the dispatcher routes via
// `workflowResume.kind ∈ {'hitl-approved','hitl-rejected'}` to
// `agentExecutionService.resumeFromHitlApproval`.
//
// The 24h expiry timer that `createHitlPause` arms is independent — it
// fires its own task with `kind: 'hitl-expiry'`. If a user approves /
// rejects before 24h, the resume task fires first; the expiry task
// arrives later and `resumeFromHitlApproval`'s `fired_at != null` check
// short-circuits the duplicate cleanly.

import { enqueueAgentExecution } from '../infrastructure/cloud-tasks';

export async function enqueueResumeForHitl(args: {
  tenantId: string;
  agentId: string;
  threadId: string;
  scheduledRowId: string;
  scheduledByInvocationId: string;
  kind: 'hitl-approved' | 'hitl-rejected';
  /** A deferred resume re-arms itself for later. The task is named by the
   *  minute it is due, so a re-arm within the minute it was enqueued is one
   *  task, and the next minute's is another. */
  scheduleTime?: Date;
}): Promise<void> {
  const scheduleKey = (args.scheduleTime ?? new Date()).toISOString().slice(0, 16);
  await enqueueAgentExecution(args.tenantId, args.agentId, {
    ...(args.scheduleTime ? { scheduleTime: args.scheduleTime } : {}),
    // Recovered by resumeFromHitlApproval from the pause payload and the
    // approval row; the task body carries none, so none are passed.
    objective: `${args.kind}-resume`,
    threadId: args.threadId,
    triggeredBy: 'human',
    triggeredByLabel: `${args.kind}:${args.scheduledByInvocationId}`,
    scheduleKey,
    contextRef: `${args.kind}-resume:${args.scheduledByInvocationId}`,
    receiverPath: '/api/tasks/resume-execution',
    receiverBody: {
      tenantId: args.tenantId,
      agentId: args.agentId,
      invocationId: args.scheduledByInvocationId,
      workflowResume: {
        scheduledInvocationId: args.scheduledRowId,
        kind: args.kind,
        invocationId: args.scheduledByInvocationId,
      },
    },
  } as Parameters<typeof enqueueAgentExecution>[2]);
}
