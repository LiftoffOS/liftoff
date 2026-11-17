// Extracted from chat-turn-handler.ts:452-476 so PR0's `resolveClarification`
// in hitl-enforcement/service.ts and the existing chat-turn-handler share the
// same Cloud Task enqueue logic. Keeps the two surfaces from drifting.

import { enqueueAgentExecution } from '../infrastructure/cloud-tasks';

export async function enqueueResumeForRecoveryClarification(args: {
  tenantId: string;
  agentId: string;
  threadId: string;
  scheduledRowId: string;
  scheduledByInvocationId: string;
  userAnswer: string;
}): Promise<void> {
  const scheduleKey = new Date().toISOString().slice(0, 16);
  await enqueueAgentExecution(args.tenantId, args.agentId, {
    // Recovered by resumeFromClarificationAnswer from the pause row; none passed here.
    objective: 'clarification-resume',
    threadId: args.threadId,
    triggeredBy: 'human',
    triggeredByLabel: `clarification_answered:${args.scheduledByInvocationId}`,
    scheduleKey,
    contextRef: `clarification-resume:${args.scheduledByInvocationId}`,
    receiverPath: '/api/tasks/resume-execution',
    receiverBody: {
      tenantId: args.tenantId,
      agentId: args.agentId,
      invocationId: args.scheduledByInvocationId,
      workflowResume: {
        scheduledInvocationId: args.scheduledRowId,
        kind: 'clarification-answered',
        invocationId: args.scheduledByInvocationId,
        userAnswer: args.userAnswer,
      },
    },
  } as Parameters<typeof enqueueAgentExecution>[2]);
}
