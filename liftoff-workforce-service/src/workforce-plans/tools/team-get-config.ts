// team__get_config Tool
//
// The full prose of one existing team member (the settings page's source
// fields) plus a trigger summary. The CAIO reads this BEFORE proposing any
// change: a prose edit drafted against a paraphrase drifts from what the
// team member actually says, and the person confirms a diff of the real
// text, not a memory of it.
//
// Kept for one release as a thin call to the workspace action `team_get`,
// which platform-backend serves and remote-workspace-actions.ts registers;
// the CAIO prompt now names team_get directly. Import paths use .js
// extensions (ESM).

import { getRegisteredWorkforcePlanTool } from './dispatcher.js';
import type { WorkforcePlanTool, WorkforcePlanToolContext } from './types.js';

interface TriggerSummary {
  type: string;
  cronExpr: string | null;
  companions: Array<{ label: string | null; cronExpr: string | null }>;
}

type GetConfigOutput =
  | { found: false; message: string }
  | {
      found: true;
      id: string;
      role: string;
      status: string;
      responsibilities: string | null;
      additionalContext: string | null;
      trigger: TriggerSummary | null;
    };

export const teamGetConfigTool: WorkforcePlanTool = {
  definition: {
    name: 'team__get_config',
    description:
      'Read one existing agent\'s full configuration source: its responsibilities and '
      + 'additional context exactly as stored, plus a summary of its current schedule '
      + '(primary cron and companion schedules with their labels). Call this BEFORE '
      + 'proposing any change to an existing agent, and quote the real text when you '
      + 'present the change. Get ids from org__get_existing_structure.',
    input_schema: {
      type: 'object',
      properties: {
        internalAgentId: {
          type: 'string',
          description: 'The agent\'s id, from org__get_existing_structure.',
        },
      },
      required: ['internalAgentId'],
    },
  },

  async execute(
    rawInput: Record<string, unknown>,
    ctx: WorkforcePlanToolContext,
  ): Promise<GetConfigOutput> {
    const internalAgentId = String(rawInput.internalAgentId ?? '');
    const teamGet = getRegisteredWorkforcePlanTool('team_get');
    if (!teamGet) {
      throw new Error('team__get_config: the workspace actions are not available; the workspace could not be reached');
    }
    const result = (await teamGet.execute({ teamId: internalAgentId }, ctx)) as Record<string, unknown>;
    if (result.refused === true || typeof result.id !== 'string') {
      return {
        found: false,
        message: 'No agent with that id exists in this workspace. Check org__get_existing_structure.',
      };
    }
    const trigger = result.trigger && typeof result.trigger === 'object'
      ? result.trigger as { type: string; cronExpr: string | null; companions?: Array<{ label: string | null; cronExpr: string | null }> }
      : null;
    return {
      found: true,
      id: result.id,
      role: String(result.role ?? ''),
      status: String(result.status ?? ''),
      responsibilities: typeof result.responsibilities === 'string' ? result.responsibilities : null,
      additionalContext: typeof result.additionalContext === 'string' ? result.additionalContext : null,
      trigger: trigger
        ? {
            type: trigger.type,
            cronExpr: trigger.cronExpr ?? null,
            companions: (trigger.companions ?? []).map((c) => ({ label: c.label ?? null, cronExpr: c.cronExpr ?? null })),
          }
        : null,
    };
  },
};
