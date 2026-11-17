// Role-Based Tool Availability Matrix
//
// Not every user role should access every tool. Before each LLM invocation,
// the chat service filters available tools based on the requesting user's
// role from `tenant_members`. The system prompt is also adjusted per-user
// to match available tools, so the LLM cannot call tools that are not in
// its tool list — but this matrix is the second line of defense at dispatch
// time in case the LLM hallucinates a tool name.
//
// The matrix here matches the table in the implementation plan exactly:
//
//   | Tool                      | owner | admin | member    | viewer    |
//   |---------------------------|-------|-------|-----------|-----------|
//   | get_agent_performance     | yes   | yes   | yes       | yes       |
//   | get_cost_breakdown        | yes   | yes   | yes       | read-only |
//   | get_human_activity        | yes   | yes   | own only  | no        |
//   | get_oversight_config      | yes   | yes   | yes       | yes       |
//   | get_workforce_composition | yes   | yes   | yes       | yes       |
//   | get_execution_trends      | yes   | yes   | yes       | yes       |
//   | get_connector_health      | yes   | yes   | yes       | yes       |
//   | get_data_landscape        | yes   | yes   | yes       | yes       |
//   | get_data_source_rates     | yes   | yes   | yes       | yes       |
//   | bring_in_colleague        | yes   | yes   | yes       | yes       |
//
// "read-only" and "yes" both currently mean "tool is callable" — the
// distinction would matter if we had any write tools, which we don't yet.
// "own only" is enforced inside the tool executor itself by reading
// ctx.role and ctx.accountId.

import type { InsightsRole } from './types';
import { workspaceActionPermits, isWorkspaceActionTool, WORKSPACE_ACTION_TOOLS } from '../../workspace-actions/tools';
import { BRING_IN_COLLEAGUE_TOOL } from './bring-in-colleague';
import { DATASET_TOOL_NAMES } from '../../datasets/tools';
import { SHOW_FILE_TOOL } from '../../generated-files/assistant-tools';
import { READ_CONVERSATION_HISTORY_TOOL, RECALL_CONVERSATIONS_TOOL } from '../../chat-recall/tools';

export type ToolAccess =
  | 'allow'        // can call freely
  | 'allow_own'    // can call but executor narrows to own data only
  | 'allow_read'   // can call (synonym for 'allow' today; reserved for future)
  | 'deny';

export interface ToolAccessMatrix {
  readonly [toolName: string]: Readonly<Record<InsightsRole, ToolAccess>>;
}

// The browser tools are actions, not reads, and a session costs money for as
// long as it is open. Everyone who can act in a workspace gets them; a viewer,
// whose whole role is to look without changing anything or spending anything,
// does not.
const BROWSER_TOOL_ACCESS = Object.freeze({
  owner: 'allow', admin: 'allow', member: 'allow', viewer: 'deny',
} as const);

/** Read-only access to this conversation's own parked results, for every
 *  role. Built from the tool list rather than written out, so a fourth dataset
 *  tool is offered here on the same edit that adds it. */
const DATASET_TOOL_ACCESS: Record<string, Readonly<Record<InsightsRole, ToolAccess>>> =
  Object.fromEntries(DATASET_TOOL_NAMES.map((name) => [name, Object.freeze({
    owner: 'allow', admin: 'allow', member: 'allow', viewer: 'allow',
  } as const)]));

/** The browser tools by name, the set an answer-only turn is not offered. */
const BROWSER_TOOL_NAMES = new Set([
  'navigate_browser_session', 'run_browser_task', 'start_browser_session', 'read_active_browser_session',
]);

export const TOOL_ACCESS_MATRIX: ToolAccessMatrix = Object.freeze({
  navigate_browser_session: BROWSER_TOOL_ACCESS,
  run_browser_task: BROWSER_TOOL_ACCESS,
  start_browser_session: BROWSER_TOOL_ACCESS,
  read_active_browser_session: BROWSER_TOOL_ACCESS,
  get_agent_performance: Object.freeze({
    owner: 'allow', admin: 'allow', member: 'allow', viewer: 'allow',
  }),
  get_cost_breakdown: Object.freeze({
    owner: 'allow', admin: 'allow', member: 'allow', viewer: 'allow_read',
  }),
  get_human_activity: Object.freeze({
    owner: 'allow', admin: 'allow', member: 'allow_own', viewer: 'deny',
  }),
  get_oversight_config: Object.freeze({
    owner: 'allow', admin: 'allow', member: 'allow', viewer: 'allow',
  }),
  get_workforce_composition: Object.freeze({
    owner: 'allow', admin: 'allow', member: 'allow', viewer: 'allow',
  }),
  get_execution_trends: Object.freeze({
    owner: 'allow', admin: 'allow', member: 'allow', viewer: 'allow',
  }),
  get_connector_health: Object.freeze({
    owner: 'allow', admin: 'allow', member: 'allow', viewer: 'allow',
  }),
  // Entity COUNTS and types, no titles and no content, so there is nothing here
  // a viewer should not see about their own workspace.
  get_data_landscape: Object.freeze({
    owner: 'allow', admin: 'allow', member: 'allow', viewer: 'allow',
  }),
  // A price list: what one lookup costs this workspace. Nothing in it is
  // anyone's activity or spend, so every role may ask.
  get_data_source_rates: Object.freeze({
    owner: 'allow', admin: 'allow', member: 'allow', viewer: 'allow',
  }),
  // Everyone can ask for a colleague, as they can on Liftoff. What the
  // colleague may then do is the colleague's own role decision: the Chief AI
  // Officer previews a change against the person's real role and refuses what
  // that role cannot do.
  [BRING_IN_COLLEAGUE_TOOL]: Object.freeze({
    owner: 'allow', admin: 'allow', member: 'allow', viewer: 'allow',
  }),
  // The three dataset tools read back what THIS conversation already fetched
  // and paid for — nothing else is reachable through them, because a dataset
  // is scoped to its job. So the rule is the rule of the reads around them
  // rather than the browser's: whoever could see the result inline can see it
  // parked. Every role, viewer included.
  ...DATASET_TOOL_ACCESS,
  // Showing a file puts something already in this workspace in front of the
  // person who is already in the conversation. It reads nothing new and
  // changes nothing, so the rule is the rule of the reads around it: every
  // role, viewer included. The tenancy check is the file's own — it is read
  // under tenant scope, so a file from another workspace reads as absent.
  // Reading further back in THIS conversation shows the person what their own
  // client already renders: they are in the thread and can scroll it. It
  // reaches no other conversation, so there is no role that may be in a
  // conversation and may not read it. Every role, viewer included.
  [READ_CONVERSATION_HISTORY_TOOL]: Object.freeze({
    owner: 'allow', admin: 'allow', member: 'allow', viewer: 'allow',
  }),
  // Searching the person's OTHER conversations with this assistant reaches only
  // turns THEY spoke in (the search is scoped to their own account), so it shows
  // them nothing they could not open themselves. Every role, viewer included, on
  // the same reasoning as the read above.
  [RECALL_CONVERSATIONS_TOOL]: Object.freeze({
    owner: 'allow', admin: 'allow', member: 'allow', viewer: 'allow',
  }),
  [SHOW_FILE_TOOL]: Object.freeze({
    owner: 'allow', admin: 'allow', member: 'allow', viewer: 'allow',
  }),
});

/** Whether a given tool can be invoked by a user with the given role.
 *  'allow_own' counts as callable here — the per-tool executor is
 *  responsible for narrowing the data scope based on `ctx`.
 *
 *  A name this matrix does not know is answered by the workspace-action
 *  registry's own permission (src/tenant-members/permissions.ts, the single
 *  source of the role rule), so the shared tools carry one rule everywhere
 *  rather than a second copy here. */
export function canRoleCallTool(toolName: string, role: InsightsRole): boolean {
  const access = TOOL_ACCESS_MATRIX[toolName]?.[role];
  if (!access) {
    return isWorkspaceActionTool(toolName) ? workspaceActionPermits(toolName, role) : false;
  }
  return access !== 'deny';
}

/** Return the list of tool names that the given role is allowed to call.
 *
 *  `answerOnly`: a team brought the Insights Manager in for a number and
 *  nobody is present to confirm anything, so no mutating action, no browser
 *  and no colleague. `asColleague`: this turn IS a hand-over from Liftoff or
 *  the Chief AI Officer; everything stays on offer except a colleague of its
 *  own, so a hand-over is one deep on every surface. */
export function toolsForRole(
  role: InsightsRole,
  opts: { answerOnly?: boolean; asColleague?: boolean } = {},
): string[] {
  // A change to an agent is the Chief AI Officer's: a steward tool is never
  // listed here. An answer-only turn (a colleague a team brought in) lists no
  // mutating workspace action and no browser either.
  const withheld = (name: string): boolean =>
    (opts.answerOnly === true && BROWSER_TOOL_NAMES.has(name))
    || ((opts.answerOnly === true || opts.asColleague === true) && name === BRING_IN_COLLEAGUE_TOOL);
  return [
    ...Object.keys(TOOL_ACCESS_MATRIX).filter((name) => !withheld(name)),
    ...WORKSPACE_ACTION_TOOLS
      .filter((t) => t.steward === undefined && !(opts.answerOnly && t.mutating))
      .map((t) => t.definition.name),
  ].filter(name => canRoleCallTool(name, role));
}
