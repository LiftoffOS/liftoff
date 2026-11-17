// workforce_plan__approve Tool
//
// Approves a pending (or draft) workforce plan directly from the chat
// conversation. When the user tells the CAIO "yes, go ahead" or "I approve",
// the CAIO calls this tool to trigger provisioning via the HRBP Agent.
//
// This eliminates the need for a separate approval page — the conversation
// IS the approval UI. The human approval gate is the user saying "yes" in
// the chat; the CAIO never calls this tool autonomously.
//
// On success the plan transitions to `provisioning` and the HRBP Agent
// starts creating agents in the background. The CAIO should tell the user
// that their agents are being set up and will appear on the /teams page.
//
// Adapted from platform-backend src/workforce-plans/tools/workforce-plan-approve.ts.
// Import paths use .js extensions (ESM).

import { workforcePlanService } from '../service.js';
import { WorkforcePlanLifecycleError } from '../types.js';
import type { WorkforcePlanTool, WorkforcePlanToolContext } from './types.js';

interface ApproveOutput {
  planId: string;
  status: string;
  agentCount: number;
  message: string;
}

export const workforcePlanApproveTool: WorkforcePlanTool = {
  definition: {
    name: 'workforce_plan__approve',
    description:
      'Approve the current plan and start provisioning the agents. Call this ONLY after the user has explicitly approved the plan in the conversation (e.g. "yes", "approved", "go ahead", "looks good"). Never call autonomously. The plan must be in pending_approval or draft status. On success, the agents are created in the background and appear on the Teams page shortly.',
    input_schema: {
      type: 'object',
      properties: {
        launch: {
          type: 'boolean',
          description:
            'The person\'s answer to the builder\'s question, asked with the approval: true when they chose to launch the agents as soon as they are ready (Launch Now), false when they chose to leave them as drafts (Maybe Later) or when the workspace cannot run agents right now. Never assumed: ask, and pass what they said. Absent means drafts.',
        },
      },
    },
  },

  async execute(
    input: Record<string, unknown>,
    ctx: WorkforcePlanToolContext,
  ): Promise<ApproveOutput> {
    if (!ctx.workforcePlanId) {
      throw new Error(
        'No plan is attached to this conversation. Draft and commit a plan first.',
      );
    }
    // The answer is the person's, carried by the model; a missing one is a
    // question not asked, and the plan then keeps the builder's Maybe Later.
    const launch = input.launch === true;

    try {
      const approved = await workforcePlanService.approve(
        ctx.workforcePlanId,
        ctx.tenantId,
        ctx.accountId,
        { launchOnCompletion: launch },
      );
      const n = approved.agents.length;
      const teams = `${n} agent${n === 1 ? '' : 's'}`;
      return {
        planId: approved.id,
        status: approved.status,
        agentCount: n,
        message: launch
          ? `Plan approved. ${teams} ${n === 1 ? 'is' : 'are'} being set up in the background and will be started for the person as soon as ${n === 1 ? 'it is' : 'they are'} ready; a notice will be posted here saying which started. Tell the person that.`
          : `Plan approved. ${teams} ${n === 1 ? 'is' : 'are'} being set up in the background and will appear on the Teams page in draft status; a notice will be posted here when ${n === 1 ? 'it is' : 'they are'} ready. Tell the person that.`,
      };
    } catch (err) {
      if (err instanceof WorkforcePlanLifecycleError) {
        throw new Error(err.message);
      }
      throw err;
    }
  },
};
