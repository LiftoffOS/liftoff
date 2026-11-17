// workforce_plan__commit Tool
//
// Transitions the current draft plan to pending_approval, finalising the
// spec. The CAIO calls this only after the user has explicitly confirmed
// that the plan is ready - never autonomously. The service layer validates
// that the plan has at least one agent spec before allowing the transition.
//
// After this call, the CAIO should ask for the user's approval and then
// call workforce_plan__approve to kick off provisioning.
//
// Adapted from platform-backend src/workforce-plans/tools/workforce-plan-commit.ts.
// Import paths use .js extensions (ESM).

import { workforcePlanService } from '../service.js';
import { WorkforcePlanLifecycleError } from '../types.js';
import type { WorkforcePlanTool, WorkforcePlanToolContext } from './types.js';

interface CommitOutput {
  planId: string;
  status: string;
  agentCount: number;
  message: string;
}

export const workforcePlanCommitTool: WorkforcePlanTool = {
  definition: {
    name: 'workforce_plan__commit',
    description:
      'Submit the current draft plan for human approval. Transitions the plan from draft to pending_approval. Requires at least one agent spec in the plan. Only call this AFTER the user has explicitly confirmed they are ready to commit - never autonomously. Once committed, the plan is locked from further edits until the user approves or rejects it. If no draft is attached to this conversation, the call fails and you must call workforce_plan__draft first.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },

  async execute(
    _input: Record<string, unknown>,
    ctx: WorkforcePlanToolContext,
  ): Promise<CommitOutput> {
    if (!ctx.workforcePlanId) {
      throw new Error(
        'No draft plan is attached to this conversation. Call workforce_plan__draft first.',
      );
    }

    try {
      const committed = await workforcePlanService.submitForApproval(
        ctx.workforcePlanId,
        ctx.tenantId,
      );
      return {
        planId: committed.id,
        status: committed.status,
        agentCount: committed.agents.length,
        message: `Plan finalised with ${committed.agents.length} agent${committed.agents.length === 1 ? '' : 's'}. Ask the user if they would like to approve it. When they confirm, call workforce_plan__approve to start provisioning.`,
      };
    } catch (err) {
      // Surface lifecycle errors as readable messages so the LLM can
      // explain to the user what went wrong (e.g. "plan has no agents").
      if (err instanceof WorkforcePlanLifecycleError) {
        throw new Error(err.message);
      }
      throw err;
    }
  },
};
