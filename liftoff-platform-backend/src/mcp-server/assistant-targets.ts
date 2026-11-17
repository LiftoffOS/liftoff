// The MCP surface's view of the three platform assistants: the shared list
// under the names this module's callers use. The roster a coding tool sees
// and the name a Slack DM addresses read the same vocabulary because they
// are the same list; only the Insights Manager's one-liner is written for
// this audience, since to a coding tool "workspace" means the repository it
// is sitting in.

import {
  ASSISTANT_TARGETS,
  assistantByKind as sharedAssistantByKind,
  type AssistantKind,
  type AssistantTarget,
} from '../agent-chat/assistant-targets';

export type McpAssistantKind = AssistantKind;

export interface McpAssistantTarget {
  kind: McpAssistantKind;
  /** The reserved address: 'liftoff', 'caio' or 'insights'. Deliberately not a
   *  UUID, so it can never collide with an internal_agents id. */
  id: McpAssistantKind;
  /** The name a person and the calling model see. */
  name: string;
  /** One line on what this assistant is for, shown in the roster. */
  summary: string;
}

const INSIGHTS_SUMMARY_FOR_CODING_TOOLS =
  'Answers questions from their real Liftoff workspace data: cost, task volume, '
  + 'trends, and who did what. It has the data tools; nobody else does.';

function forMcp(a: AssistantTarget): McpAssistantTarget {
  return {
    kind: a.kind,
    id: a.id,
    name: a.name,
    summary: a.kind === 'insights' ? INSIGHTS_SUMMARY_FOR_CODING_TOOLS : a.description,
  };
}

export const MCP_ASSISTANT_TARGETS: readonly McpAssistantTarget[] = ASSISTANT_TARGETS.map(forMcp);

/** The assistant a target_kind names, or null for 'agent'. */
export function assistantByKind(kind: string): McpAssistantTarget | null {
  const a = sharedAssistantByKind(kind);
  return a ? forMcp(a) : null;
}
