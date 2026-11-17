// get_oversight_config Tool
//
// Answers questions like:
//   "What's our autonomy level?"
//   "What categories require human approval?"
//   "Who has escalation authority?"
//
// Wraps:
//   - getOversightSettings (DB — internal_agent_oversight_settings)
//
// Point-in-time. No time_range parameter — oversight is always "as of now".

import { getOversightSettings } from '../data-providers';
import type { InsightsTool, InsightsToolContext } from './types';
import type { OversightSettings } from '../types';

interface OversightConfigOutput {
  /** Null when no oversight settings have been configured for this tenant. */
  settings: OversightSettings | null;
}

export const getOversightConfigTool: InsightsTool = {
  definition: {
    name: 'get_oversight_config',
    description:
      'Current oversight settings for the workspace: autonomy level, escalation rules, sensitive work categories, and HITL (human-in-the-loop) version. Use this when the user asks about how much autonomy the agents are configured with, what work requires human approval, or escalation policies. Point-in-time snapshot — no time range needed.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  async execute(_input, ctx: InsightsToolContext): Promise<OversightConfigOutput> {
    const settings = await getOversightSettings(ctx.tenantId);
    return { settings };
  },
};
