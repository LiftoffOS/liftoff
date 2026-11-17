// Which inputs have a dedicated handler, answered in ONE place.
//
// WHY THIS MODULE EXISTS. Six families are dispatched by a handler of their own
// inside `executeInner` — external MCP tools, per-agent Slack, per-agent Teams,
// custom MCP servers, external agents, and the sandbox. Which inputs those are
// was written twice: once as the `if` conditions in `executeInner`, and once as
// a LITERAL CONNECTOR LIST in `executeBatch`'s `fastPathEligible` and again in
// `executeToolCalls`'s `NON_BATCHABLE_CONNECTORS`. Three hand-maintained copies
// of one fact.
//
// They already disagree. `custom_mcp_server` appears in the `executeInner`
// branch and in NEITHER exclusion list, so a batched call carrying that
// connector is sent to connector-service as an ordinary connector operation and
// never reaches the custom-MCP handler at all. The lists also disagree in KIND:
// `executeInner` routes Slack and Teams by ACTION TYPE while both exclusion
// lists match on CONNECTOR, so an agent-Slack tool name arriving under any
// other connector value is batchable and skips its handler.
//
// The fix is not to add `custom_mcp_server` to two more lists. It is that
// "does this input have a dedicated handler" must have exactly one answer, and
// exclusion from the batch fast path must be DERIVED from it — so a family
// added tomorrow is excluded by existing.
//
// A family here is a PREDICATE ONLY, not a handler. The handlers stay in
// `executeInner` where their imports and their error contracts already live;
// this decides which one applies, and everything that needs to know "is this an
// ordinary connector call" asks the same question.

import { isSandboxTool } from '../execution-environments/function-registry';
import { AGENT_SLACK_TOOL_NAMES } from './agent-slack-tool-catalog';
import { AGENT_TEAMS_TOOL_NAMES } from './agent-teams-tool-catalog';
import { SANDBOX_CONNECTOR } from '../agent-execution/tool-dispatch-family';

const AGENT_SLACK_TOOL_NAME_SET: ReadonlySet<string> = new Set(AGENT_SLACK_TOOL_NAMES);
const AGENT_TEAMS_TOOL_NAME_SET: ReadonlySet<string> = new Set(AGENT_TEAMS_TOOL_NAMES);

/** Exported so `service.ts` routes on the SAME predicate this table matches on.
 *  Two copies of "is this a per-agent Slack tool" is how the family conditions
 *  and the batch exclusions came to disagree in the first place. */
export function isAgentSlackToolName(name: string): boolean {
  return AGENT_SLACK_TOOL_NAME_SET.has(name);
}
export function isAgentTeamsToolName(name: string): boolean {
  return AGENT_TEAMS_TOOL_NAME_SET.has(name);
}

/** The fields a family predicate may read. Deliberately narrow: a predicate
 *  that needed the payload would be routing on data rather than on identity. */
export type DispatchRouting = {
  connector: string;
  entityType?: string;
  actionType: string;
};

export type DispatchFamilyName =
  | 'external-mcp-tool'
  | 'agent-slack'
  | 'agent-teams'
  | 'custom-mcp-server'
  | 'external-agent'
  | 'sandbox';

/** ORDER IS THE ROUTING ORDER in `executeInner`, and must stay that way: the
 *  sandbox predicate matches on `isSandboxTool(actionType)` as well as on its
 *  connector, so a name that is both would resolve differently if this list
 *  were reordered. Same reasoning as any first-match router. */
export const DEDICATED_DISPATCH_FAMILIES: ReadonlyArray<{
  name: DispatchFamilyName;
  matches: (input: DispatchRouting) => boolean;
}> = [
  {
    name: 'external-mcp-tool',
    matches: (i) => i.connector === 'external' && Boolean(i.entityType),
  },
  {
    name: 'agent-slack',
    matches: (i) => Boolean(i.actionType) && isAgentSlackToolName(i.actionType),
  },
  {
    name: 'agent-teams',
    matches: (i) => Boolean(i.actionType) && isAgentTeamsToolName(i.actionType),
  },
  {
    name: 'custom-mcp-server',
    matches: (i) => i.connector === 'custom_mcp_server' && Boolean(i.entityType),
  },
  {
    name: 'external-agent',
    matches: (i) => i.connector === 'external-agent',
  },
  {
    name: 'sandbox',
    matches: (i) => i.connector === SANDBOX_CONNECTOR || isSandboxTool(i.actionType),
  },
];

/** The family that will handle this input, or null when it is an ordinary
 *  connector call. */
export function dedicatedDispatchFamily(input: DispatchRouting): DispatchFamilyName | null {
  for (const f of DEDICATED_DISPATCH_FAMILIES) {
    if (f.matches(input)) return f.name;
  }
  return null;
}

/** True when this input is an ordinary connector call — the ONLY kind the batch
 *  fast path may carry, because that path dispatches to connector-service's
 *  ExecuteBatch and a family call has no meaning there.
 *
 *  Derived rather than listed, so a family added to the table above is excluded
 *  from batching without anyone remembering to exclude it. */
export function isOrdinaryConnectorDispatch(input: DispatchRouting): boolean {
  return dedicatedDispatchFamily(input) === null;
}
