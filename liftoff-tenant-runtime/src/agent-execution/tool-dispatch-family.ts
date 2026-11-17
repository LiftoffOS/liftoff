// Which subsystem can execute a tool, decided once, from its name.
//
// WHY THIS EXISTS
// ───────────────
// A tool name reaches the dispatcher as a bare string, and two places turned it
// into a `{connector, actionType}` pair independently: `buildToolCallRequest`
// (workflow steps, loop iterations, wake polls) and `mapLlmToolCallsToRequests`
// (the recovery advisor's corrected calls). Both used the same rule — split on
// `__`, and if there is no separator it must be a standard tool — and both were
// wrong in the same way.
//
// `executeStandardTool` returns null for a name it does not handle, so every
// bare-named tool that is NOT a standard tool became:
//
//     no handler registered for standard tool: shell_exec
//
// Measured against this checkout: 34 standard tools dispatch correctly, and 116
// do not — 97 sandbox primitives, `code_session`, 10 agent_slack tools, 7
// agent_teams tools, and `delegate_to_agent`. Five of the seven `tool_call`
// steps stored across the production fleet name one of those 116.
//
// THE GATEWAY WAS ALWAYS WILLING. `toolGateway.executeInner` already routes all
// three families off the tool NAME, before any allowlist check:
//
//     isAgentSlackToolName(actionType)                        → agentSlackHandler
//     isAgentTeamsToolName(actionType)                        → agentTeamsHandler
//     connector === 'execution_environment' || isSandboxTool  → sandboxExecutor
//
// so the defect was never that the runtime could not route these. It was that
// agent-execution intercepted them first and handed them to the wrong executor.
// This module makes the caller ask the same question the gateway answers, in
// one place, so the two cannot drift.
//
// WHY A FAMILY AND NOT JUST A CONNECTOR STRING. The connector value alone is
// not enough to dispatch correctly:
//   - `agent_slack` / `agent_teams` must be excluded from connector BATCHING.
//     The batch fast-path folds calls into one ConnectorService.ExecuteBatch
//     RPC, and its own comment scopes it to "a real connector (not standard,
//     not external agent, not sandbox)" — a per-agent Slack call is none of
//     those either. Giving these names a connector without teaching the batcher
//     would send them to connector-service as connector operations.
//   - the sandbox family needs a run identity threaded through, because
//     `sandboxSessionIdFor` THROWS without one rather than falling back to the
//     trace id.
//   - `delegate_to_agent` is not gateway-routed at all; it is a method on
//     AgentExecutionService and needs the `__builtin:` sentinel.
//
// UNRESOLVED IS A VERDICT, NOT A DEFAULT. The old rule had no way to say "I do
// not know what this is" — an unknown name silently became a standard tool and
// failed at dispatch. `kind: 'unresolved'` lets validation refuse the step
// before a run starts, which is what `validateWorkflowGraph` now does.

import { isSandboxTool } from '../execution-environments/function-registry';
import { AGENT_SLACK_TOOL_NAMES } from '../tool-gateway/agent-slack-tool-catalog';
import { AGENT_TEAMS_TOOL_NAMES } from '../tool-gateway/agent-teams-tool-catalog';

const AGENT_SLACK_NAMES: ReadonlySet<string> = new Set(AGENT_SLACK_TOOL_NAMES);
const AGENT_TEAMS_NAMES: ReadonlySet<string> = new Set(AGENT_TEAMS_TOOL_NAMES);

/** The connector value the gateway's sandbox branch matches on, and the value
 *  mcp-server already sends for both sandbox primitives and `code_session`. */
export const SANDBOX_CONNECTOR = 'execution_environment';
export const AGENT_SLACK_CONNECTOR = 'agent_slack';
export const AGENT_TEAMS_CONNECTOR = 'agent_teams';

/** Runtime-owned pseudo-connectors. Not tenant connector policy, and not
 *  eligible for the connector batch fast-path. */
export const RUNTIME_PSEUDO_CONNECTORS: ReadonlySet<string> = new Set([
  SANDBOX_CONNECTOR,
  AGENT_SLACK_CONNECTOR,
  AGENT_TEAMS_CONNECTOR,
]);

/** `code_session` is NOT in the sandbox function registry — `isSandboxTool`
 *  returns false for it — but it executes in the sandbox and mcp-server
 *  dispatches it with `connector: 'execution_environment'`. Resolving it by
 *  name here is what keeps a name-based resolver from missing it. */
const SANDBOX_EXTRA_NAMES: ReadonlySet<string> = new Set(['code_session']);

/** Tools dispatched by a dedicated method on AgentExecutionService rather than
 *  by the gateway. Each needs an arm in the `__builtin:` branch; the service
 *  constructor asserts that at startup, so adding a name here without a method
 *  fails the deploy rather than the first model call.
 *
 *  `delegate_to_agent` belongs here and not with the gateway families: it is
 *  `agentExecutionService.delegateToAgent(...)`, registered by mcp-server as a
 *  tool with its own handler, with no connector to route to.
 *
 *  `find_teammates` / `send_agent_message` / `read_agent_messages` are the same
 *  shape: universal peer-collaboration tools mcp-server registers as callbacks
 *  to Platform Backend (never gateway connectors), so a workflow `tool_call`
 *  step naming one used to resolve to no family and die UNDISPATCHABLE_TOOL at
 *  validation — every turn of any agent whose distilled graph wired one. They
 *  are surfaced to the distiller as step-eligible tools, so they must be
 *  dispatchable as steps. `send`/`read` carry the run's trust (origin stamp +
 *  taint upgrade); the arms below reuse `state.trustRef`, the same cell the
 *  interactive path mutates. */
export const BUILTIN_DISPATCH_NAMES: ReadonlySet<string> = new Set([
  'search',
  'delegate_to_agent',
  'find_teammates',
  'send_agent_message',
  'read_agent_messages',
]);

export type ToolDispatch =
  /** `<alias>__<func>` — a bound connector instance. */
  | { kind: 'connector'; connector: string; actionType: string }
  /** Sandbox primitive or `code_session`. Requires a run identity. */
  | { kind: 'sandbox'; connector: string; actionType: string }
  /** Per-agent Slack / Teams surface. Routed by name, never batched. */
  | { kind: 'agent_slack'; connector: string; actionType: string }
  | { kind: 'agent_teams'; connector: string; actionType: string }
  /** Dispatched by a method on AgentExecutionService via `__builtin:<name>`. */
  | { kind: 'builtin'; connector: string; actionType: string }
  /** A genuine standard tool — `executeStandardTool` has a case for it. */
  | { kind: 'standard'; connector: ''; actionType: string }
  /** Nothing can execute this name. Never silently a standard tool. */
  | { kind: 'unresolved'; actionType: string };

/**
 * Resolve a tool name to the subsystem that can execute it.
 *
 * Order matters. The `__` split runs FIRST because a connector instance alias
 * is arbitrary tenant data and could collide with a family name; a bound
 * connector's own tool must keep winning, exactly as it does today.
 *
 * @param toolName the catalog name, e.g. `shell_exec` or `gmail-1f2e__send`
 * @param isStandardTool predicate for the standard-tool catalog. Injected
 *        rather than imported so this module stays free of the standard-tool
 *        graph, which pulls in handlers, browser sessions and web vendors.
 */
export function resolveToolDispatch(
  toolName: string,
  isStandardTool: (name: string) => boolean,
): ToolDispatch {
  const separatorIndex = toolName.indexOf('__');
  if (separatorIndex !== -1) {
    return {
      kind: 'connector',
      connector: toolName.substring(0, separatorIndex),
      actionType: toolName.substring(separatorIndex + 2),
    };
  }

  if (isSandboxTool(toolName) || SANDBOX_EXTRA_NAMES.has(toolName)) {
    return { kind: 'sandbox', connector: SANDBOX_CONNECTOR, actionType: toolName };
  }
  if (AGENT_SLACK_NAMES.has(toolName)) {
    return { kind: 'agent_slack', connector: AGENT_SLACK_CONNECTOR, actionType: toolName };
  }
  if (AGENT_TEAMS_NAMES.has(toolName)) {
    return { kind: 'agent_teams', connector: AGENT_TEAMS_CONNECTOR, actionType: toolName };
  }
  if (BUILTIN_DISPATCH_NAMES.has(toolName)) {
    return { kind: 'builtin', connector: `__builtin:${toolName}`, actionType: toolName };
  }
  if (isStandardTool(toolName)) {
    return { kind: 'standard', connector: '', actionType: toolName };
  }
  return { kind: 'unresolved', actionType: toolName };
}

/** The entity type each family's executor expects, matching what mcp-server
 *  already sends. Connector calls keep whatever the caller resolved. */
export function entityTypeForDispatch(dispatch: ToolDispatch, fallback: string): string {
  switch (dispatch.kind) {
    case 'sandbox': return 'sandbox';
    case 'agent_slack': return AGENT_SLACK_CONNECTOR;
    case 'agent_teams': return AGENT_TEAMS_CONNECTOR;
    default: return fallback;
  }
}
