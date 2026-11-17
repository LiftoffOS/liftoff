// CAIO Workforce Planning Tools Module
//
// Public API for the workforce planning chat service. The chat service:
//   1. Calls `getToolDefinitionsForRole(role)` to get the filtered tool
//      list for the requesting user, then hands it to the LLM client as
//      the `tools` field.
//   2. When the LLM emits a tool_use event, calls `dispatchToolCall(name,
//      input, ctx)` and feeds the result back as a tool_result message.
//   3. The system message is rendered from the CAIO seed's
//      system_prompt template by platform-agent/system-prompt-render.ts —
//      `formatPlanState()` here is no longer used.
//
// The registry populates itself. Both entry points below call
// registerWorkforcePlanTools() first, so the tool list can never be empty
// because somebody forgot a startup call. That is not hypothetical: this
// module was extracted from platform-backend without its `src/index.ts`
// bootstrap line, and for three months the CAIO ran with zero tools —
// improvising `[Tool Call: ...]` text at the user and claiming writes it
// never made. buildApp() still registers eagerly so a malformed tool
// definition fails at startup rather than on the first chat turn.
//
// Adapted from platform-backend src/workforce-plans/tools/index.ts.
// Import paths use .js extensions (ESM).

export {
  getRegisteredWorkforcePlanTool,
  registerWorkforcePlanTool,
  _resetWorkforcePlanToolRegistry,
} from './dispatcher.js';

export {
  TOOL_ACCESS_MATRIX,
  REMOTE_TOOL_PERMISSIONS,
  canRoleCallTool,
  toolsForRole,
} from './role-matrix.js';

export {
  BRING_IN_COLLEAGUE_TOOL,
  CAIO_HANDOVER_TARGETS,
  bringInColleagueTool,
  resolveCAIOHandoverTarget,
  type CAIOHandoverTarget,
} from './bring-in-colleague.js';

export {
  registerRemoteWorkspaceActions,
  refreshRemoteWorkspaceActions,
  ensureRemoteWorkspaceActions,
  getRemoteWorkspaceActionsStatus,
  startupRetriesSettled,
  _resetRemoteWorkspaceActions,
} from './remote-workspace-actions.js';

export {
  renderSystemInstruction,
  renderAgentTemplate,
  renderWorkflowTemplate,
  AGENT_HITL_GUIDANCE,
  WORKFLOW_HITL_GUIDANCE,
} from './si-templates.js';
export type { TemplateInput } from './si-templates.js';

export type {
  WorkforcePlanRole,
  WorkforcePlanTool,
  WorkforcePlanToolContext,
  WorkforcePlanToolResult,
} from './types.js';

import {
  dispatchToolCall as dispatchRegisteredToolCall,
  getToolDefinitionsForRole as getRegisteredToolDefinitionsForRole,
  getRegisteredWorkforcePlanTool,
  registerWorkforcePlanTool,
} from './dispatcher.js';
import type {
  WorkforcePlanToolContext,
  WorkforcePlanToolResult,
} from './types.js';
import { workforcePlanDraftTool } from './workforce-plan-draft.js';
import { workforcePlanCommitTool } from './workforce-plan-commit.js';
import { workforcePlanApproveTool } from './workforce-plan-approve.js';
import { orgGetExistingStructureTool } from './org-get-existing.js';
import { connectorsListAvailableTool } from './connectors-list-available.js';
import { memorySaveTool } from './memory-save.js';
import { memoryRetrieveTool } from './memory-retrieve.js';
import { agentTemplatesListTool } from './agent-templates-list.js';
import { agentTemplatesGetTool } from './agent-templates-get.js';
import { sourceConversationReadTool } from './source-conversation.js';
import { previewWithLiftoffTool } from './preview-with-liftoff.js';
import { conversationsListTool, conversationReadTool } from './conversations.js';
import { recallConversationsTool } from './recall-conversations.js';
import { teamGetConfigTool } from './team-get-config.js';
import { teamProposeUpdateTool } from './team-propose-update.js';
import { browserWorkforceTools } from './browser.js';
import { capabilitySearchTool, datasetExtractTool, datasetListTool, datasetQueryTool, runCapabilityTool } from './capability.js';
import { showFileTool } from './show-file.js';

const BUILT_IN_TOOLS = [
  workforcePlanDraftTool,
  workforcePlanCommitTool,
  workforcePlanApproveTool,
  orgGetExistingStructureTool,
  connectorsListAvailableTool,
  memorySaveTool,
  memoryRetrieveTool,
  agentTemplatesListTool,
  agentTemplatesGetTool,
  // The Liftoff conversation a delegated thread was brought in from, for
  // drafting from work the person already did there instead of re-interviewing.
  sourceConversationReadTool,
  // The inverse edge of the same loop: create the paired Liftoff conversation
  // where the person can do the task once and see the deliverable first.
  previewWithLiftoffTool,
  // The conversations with the CAIO the person can see, transcript, trail and
  // work record, so work done across one or more chats can be turned into a team.
  conversationsListTool,
  conversationReadTool,
  recallConversationsTool,
  // Changing an EXISTING team: read its real prose, confirm the edit with the
  // user, and land it through the same prose-then-redistill path the settings
  // page uses. Nothing here writes triggers, prompts or workflows.
  teamGetConfigTool,
  teamProposeUpdateTool,
  // The same browser Liftoff and the Insights Manager offer, reached through
  // platform-backend because the session belongs to the tenant runtime.
  ...browserWorkforceTools,
  // The absorbed data-vendor capabilities, reached through platform-backend and
  // exposed capability-first (never a vendor name), so the CAIO can do the work
  // without leaking which vendor served it into any agent it then builds.
  capabilitySearchTool,
  runCapabilityTool,
  // A large result is parked as a dataset for this thread; these read it
  // back, only what is asked for.
  datasetQueryTool,
  datasetExtractTool,
  datasetListTool,
  // Showing a file this workspace already holds. Storing a file and showing it
  // are separate acts, and this is the second one — without it a file fetched
  // on the person's behalf sits in the store where nobody looks.
  showFileTool,
];

/**
 * Register all built-in CAIO workforce planning tools. Safe to call any
 * number of times: a tool already in the registry is skipped rather than
 * re-registered, which would throw. Called eagerly from buildApp() and
 * lazily from both accessors below.
 */
export function registerWorkforcePlanTools(): void {
  for (const tool of BUILT_IN_TOOLS) {
    if (getRegisteredWorkforcePlanTool(tool.definition.name)) continue;
    registerWorkforcePlanTool(tool);
  }
}

/** Tool definitions the given role may call. Registers on first use.
 *  `handover` withholds the colleague to bring in: see bring-in-colleague.ts. */
export function getToolDefinitionsForRole(
  role: WorkforcePlanToolContext['role'],
  opts: { handover?: boolean } = {},
): ReturnType<typeof getRegisteredToolDefinitionsForRole> {
  registerWorkforcePlanTools();
  return getRegisteredToolDefinitionsForRole(role, opts);
}

/** Dispatch a single tool call. Registers on first use. */
export async function dispatchToolCall(
  toolName: string,
  input: Record<string, unknown>,
  ctx: WorkforcePlanToolContext,
): Promise<WorkforcePlanToolResult> {
  registerWorkforcePlanTools();
  return dispatchRegisteredToolCall(toolName, input, ctx);
}
