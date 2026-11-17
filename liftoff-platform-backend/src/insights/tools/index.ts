// Insights Chat Tools Module
//
// Public API for the chat service. The chat service:
//   1. Calls `registerInsightsTools()` once at startup to populate the registry
//   2. Calls `getToolDefinitionsForRole(role)` to get the tool list for the
//      requesting user, hands it to llmClient.completeStream() as `tools`
//   3. When the LLM emits a tool_use event, calls `dispatchToolCall(name, input, ctx)`
//      and feeds the result back as a tool_result message in the next turn
//   4. Calls `buildInsightsSystemPrompt({ today, availableTools })` to generate
//      the system message that goes alongside the tools

export {
  dispatchToolCall,
  getToolDefinitionsForRole,
  getRegisteredTool,
  registerTool,
  _resetToolRegistry,
} from './dispatcher';

export { buildInsightsSystemPrompt } from './system-prompt';

export {
  TOOL_ACCESS_MATRIX,
  canRoleCallTool,
  toolsForRole,
} from './role-matrix';

export { sanitizeString, sanitizeToolResult } from './sanitize';

export {
  BRING_IN_COLLEAGUE_TOOL,
  INSIGHTS_HANDOVER_TARGETS,
  insightsBringInColleagueTool,
  resolveInsightsHandoverTarget,
} from './bring-in-colleague';

export type {
  InsightsRole,
  InsightsTool,
  InsightsToolContext,
  InsightsToolResult,
} from './types';

import { registerTool } from './dispatcher';
import { getAgentPerformanceTool } from './agent-performance';
import { getExecutionTrendsTool } from './execution-trends';
import { getCostBreakdownTool } from './cost-breakdown';
import { getHumanActivityTool } from './human-activity';
import { getOversightConfigTool } from './oversight-config';
import { getWorkforceCompositionTool } from './workforce-composition';
import { getConnectorHealthTool } from './connector-health';
import { getDataLandscapeTool } from './data-landscape';
import { getDataSourceRatesTool } from './data-source-rates';
import { browserInsightsTools } from './browser';
import { WORKSPACE_ACTION_TOOLS, dispatchWorkspaceAction, type WorkspaceActionTool } from '../../workspace-actions/tools';
import type { Actor } from '../../workspace-actions/actor';
import type { InsightsTool, InsightsToolContext } from './types';

/** The person behind an Insights turn, as the workspace actions see them. */
function actorFromInsightsContext(ctx: InsightsToolContext): Actor {
  return {
    tenantId: ctx.tenantId,
    accountId: ctx.accountId,
    role: ctx.role,
    displayName: '',
    surface: 'insights',
    ...(ctx.unattended ? { unattended: true } : {}),
    ...(ctx.origin ?? {}),
  };
}

/** A workspace-action tool as this registry holds it. The shared dispatcher
 *  runs the role rule, the preview → confirm protocol and the actor
 *  re-resolution; this adapter only translates the context and hands the
 *  model-facing string back as the object shape this dispatcher expects. */
function adaptWorkspaceTool(t: WorkspaceActionTool): InsightsTool {
  return {
    definition: t.definition,
    async execute(input, ctx) {
      const text = await dispatchWorkspaceAction(t.definition.name, input, actorFromInsightsContext(ctx));
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return { result: text };
      }
    },
  };
}

/** Register all built-in insights tools. The chat service calls this once
 *  at startup. Idempotent guard: re-registering throws (per dispatcher),
 *  so callers should only invoke this from a single init path. */
export function registerInsightsTools(): void {
  registerTool(getAgentPerformanceTool);
  registerTool(getExecutionTrendsTool);
  registerTool(getCostBreakdownTool);
  registerTool(getHumanActivityTool);
  registerTool(getOversightConfigTool);
  registerTool(getWorkforceCompositionTool);
  registerTool(getConnectorHealthTool);
  registerTool(getDataLandscapeTool);
  registerTool(getDataSourceRatesTool);
  // Shared with Liftoff, so both platform assistants offer the same browser.
  for (const tool of browserInsightsTools) registerTool(tool);
  // The workspace actions every assistant shares (reviews, teams, activity,
  // help centre, connections, administration), each under its own permission.
  for (const t of WORKSPACE_ACTION_TOOLS) registerTool(adaptWorkspaceTool(t));
}
