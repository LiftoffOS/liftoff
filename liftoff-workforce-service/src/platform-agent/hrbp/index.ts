// HRBP tool registry + dispatcher.
//
// Exports the 6-tool list and a dispatcher that maps tool names to handlers.
// runPlatformAgent receives the tool list and the dispatcher when invoked
// from the hrbp-task-handler.

import type { LLMToolDefinition } from '../../llm/types.js';
import type { HrbpToolContext } from './types.js';
import {
  TEAMBUILDER_DISTILL_TOOL,
  handleTeambuilderDistill,
} from './tools/teambuilder-distill.js';
import {
  TEAMBUILDER_CREATE_TOOL,
  handleTeambuilderCreate,
} from './tools/teambuilder-create.js';
import {
  PROVISIONING_RECORD_EVENT_TOOL,
  handleProvisioningRecordEvent,
} from './tools/provisioning-record-event.js';
import {
  PROVISIONING_UPDATE_SPEC_STATUS_TOOL,
  handleProvisioningUpdateSpecStatus,
} from './tools/provisioning-update-spec-status.js';
import {
  PROVISIONING_COMPENSATE_TOOL,
  handleProvisioningCompensate,
} from './tools/provisioning-compensate.js';
import {
  PROVISIONING_TRANSITION_TO_BLOCKER_TOOL,
  handleProvisioningTransitionToBlocker,
} from './tools/provisioning-transition-to-blocker.js';

export const HRBP_TOOLS: LLMToolDefinition[] = [
  TEAMBUILDER_DISTILL_TOOL,
  TEAMBUILDER_CREATE_TOOL,
  PROVISIONING_RECORD_EVENT_TOOL,
  PROVISIONING_UPDATE_SPEC_STATUS_TOOL,
  PROVISIONING_COMPENSATE_TOOL,
  PROVISIONING_TRANSITION_TO_BLOCKER_TOOL,
];

type HrbpToolHandler = (
  input: Record<string, unknown>,
  ctx: HrbpToolContext,
) => Promise<{ ok: boolean; data: unknown }>;

const HANDLERS: Record<string, HrbpToolHandler> = {
  teambuilder__distill: handleTeambuilderDistill,
  teambuilder__create: handleTeambuilderCreate,
  provisioning__record_event: handleProvisioningRecordEvent,
  provisioning__update_spec_status: handleProvisioningUpdateSpecStatus,
  provisioning__compensate: handleProvisioningCompensate,
  provisioning__transition_to_blocker: handleProvisioningTransitionToBlocker,
};

export async function dispatchHrbpToolCall(
  name: string,
  input: Record<string, unknown>,
  ctx: Record<string, unknown>,
): Promise<{ ok: boolean; data: unknown }> {
  const handler = HANDLERS[name];
  if (!handler) {
    return { ok: false, data: { error: `Unknown HRBP tool: ${name}` } };
  }
  return handler(input, ctx as unknown as HrbpToolContext);
}
