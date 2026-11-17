// CAIO Workforce Planning Tool Access Matrix
//
// Workforce plan mutations are an owner/admin-only activity: plans decide
// which agents get provisioned across the tenant's infrastructure, and the
// cost of getting it wrong (spinning up the wrong agents, granting the wrong
// connectors) is borne by the whole org. Member and viewer roles can chat
// with the CAIO but cannot draft or commit plans.
//
// Read-only tools (org snapshot, connector catalog, memory retrieve) are
// available to every role so a member can hold a strategy conversation
// without being able to commit changes.
//
// Matrix (matches the plan's "owner/admin only for mutations" rule):
//
//   | Tool                          | owner | admin | member | viewer |
//   |-------------------------------|-------|-------|--------|--------|
//   | workforce_plan__draft         | yes   | yes   | no     | no     |
//   | workforce_plan__commit        | yes   | yes   | no     | no     |
//   | workforce_plan__approve       | yes   | yes   | no     | no     |
//   | org__get_existing_structure   | yes   | yes   | yes    | yes    |
//   | connectors__list_available    | yes   | yes   | yes    | yes    |
//   | agent_templates__list         | yes   | yes   | yes    | yes    |
//   | agent_templates__get          | yes   | yes   | yes    | yes    |
//   | source_conversation__read     | yes   | yes   | no     | no     |
//   | preview_with_liftoff          | yes   | yes   | no     | no     |
//   | conversations__list       | yes   | yes   | no     | no     |
//   | conversation__read        | yes   | yes   | no     | no     |
//   | recall_conversations      | yes   | yes   | no     | no     |
//   | team__get_config              | yes   | yes   | no     | no     |
//   | team__propose_update          | yes   | yes   | no     | no     |
//   | memory_save                   | yes   | yes   | no     | no     |
//   | memory_retrieve               | yes   | yes   | yes    | yes    |
//   | bring_in_colleague            | yes   | yes   | yes    | yes    |
//
// memory_save is mutation-adjacent: it writes to the tenant's global memory
// and can shape downstream agent behaviour, so we restrict it to owner/admin.
// memory_retrieve is read-only and open to everyone in the tenant.

import type { WorkforcePlanRole } from './types.js';
import { BRING_IN_COLLEAGUE_TOOL } from './bring-in-colleague.js';

export type ToolAccess = 'allow' | 'deny';

export interface ToolAccessMatrix {
  readonly [toolName: string]: Readonly<Record<WorkforcePlanRole, ToolAccess>>;
}

// The browser tools are actions, and a session costs money for as long as it is
// open. Everyone who can act in a workspace gets them; a viewer, whose role is
// to look without changing or spending anything, does not. Same rule the
// Insights Manager applies to the same four tools.
const BROWSER_TOOL_ACCESS = Object.freeze({
  owner: 'allow', admin: 'allow', member: 'allow', viewer: 'deny',
} as const);

export const TOOL_ACCESS_MATRIX: ToolAccessMatrix = Object.freeze({
  navigate_browser_session: BROWSER_TOOL_ACCESS,
  run_browser_task: BROWSER_TOOL_ACCESS,
  start_browser_session: BROWSER_TOOL_ACCESS,
  read_active_browser_session: BROWSER_TOOL_ACCESS,
  // Absorbed data-vendor capabilities. Discovery is light and run spends OUs,
  // so both follow the browser posture: everyone who can act (owner/admin/
  // member), not a viewer.
  capability_search: BROWSER_TOOL_ACCESS,
  run_capability: BROWSER_TOOL_ACCESS,
  // Showing a file this workspace already holds, to the person already in the
  // conversation. It reads nothing new and changes nothing, so the rule is the
  // rule of the reads around it rather than the browser's: every role. The
  // tenancy check is the file's own, on the control plane's side.
  show_file: Object.freeze({
    owner: 'allow', admin: 'allow', member: 'allow', viewer: 'allow',
  }),
  workforce_plan__draft: Object.freeze({
    owner: 'allow', admin: 'allow', member: 'deny', viewer: 'deny',
  }),
  workforce_plan__commit: Object.freeze({
    owner: 'allow', admin: 'allow', member: 'deny', viewer: 'deny',
  }),
  workforce_plan__approve: Object.freeze({
    owner: 'allow', admin: 'allow', member: 'deny', viewer: 'deny',
  }),
  org__get_existing_structure: Object.freeze({
    owner: 'allow', admin: 'allow', member: 'allow', viewer: 'allow',
  }),
  connectors__list_available: Object.freeze({
    owner: 'allow', admin: 'allow', member: 'allow', viewer: 'allow',
  }),
  agent_templates__list: Object.freeze({
    owner: 'allow', admin: 'allow', member: 'allow', viewer: 'allow',
  }),
  agent_templates__get: Object.freeze({
    owner: 'allow', admin: 'allow', member: 'allow', viewer: 'allow',
  }),
  // Reads the content of ANOTHER conversation (the paired Liftoff thread) and
  // exists to feed plan drafting, which is itself owner/admin-only — so it
  // follows workforce_plan__draft's row rather than the read-only default.
  source_conversation__read: Object.freeze({
    owner: 'allow', admin: 'allow', member: 'deny', viewer: 'deny',
  }),
  // The other end of the same pairing: it creates a Liftoff conversation as
  // the opening move of plan drafting, so it follows the same row.
  preview_with_liftoff: Object.freeze({
    owner: 'allow', admin: 'allow', member: 'deny', viewer: 'deny',
  }),
  conversations__list: Object.freeze({
    owner: 'allow', admin: 'allow', member: 'deny', viewer: 'deny',
  }),
  conversation__read: Object.freeze({
    owner: 'allow', admin: 'allow', member: 'deny', viewer: 'deny',
  }),
  // Searching those same conversations, narrowed to the turns this person spoke
  // in. Same row as the two above: whoever may read a team-plan conversation may
  // search their own.
  recall_conversations: Object.freeze({
    owner: 'allow', admin: 'allow', member: 'deny', viewer: 'deny',
  }),
  // Both halves of changing an existing team follow workforce_plan__draft's
  // row: the read exposes another team's full instructions, and the write
  // mutates the tenant's workforce.
  team__get_config: Object.freeze({
    owner: 'allow', admin: 'allow', member: 'deny', viewer: 'deny',
  }),
  team__propose_update: Object.freeze({
    owner: 'allow', admin: 'allow', member: 'deny', viewer: 'deny',
  }),
  memory_save: Object.freeze({
    owner: 'allow', admin: 'allow', member: 'deny', viewer: 'deny',
  }),
  memory_retrieve: Object.freeze({
    owner: 'allow', admin: 'allow', member: 'allow', viewer: 'allow',
  }),
  // Everyone can ask for a colleague, as they can on Liftoff and the Insights
  // Manager. What the colleague may then do is its own role decision, made
  // from the person's real role, which travels with the hand-over.
  [BRING_IN_COLLEAGUE_TOOL]: Object.freeze({
    owner: 'allow', admin: 'allow', member: 'allow', viewer: 'allow',
  }),
});

/** The permission a workspace action requires, as platform-backend names it
 *  (its tenant-members/permissions.ts is the one role rule), and the roles
 *  that rule admits. Filled by remote-workspace-actions.ts from the manifest;
 *  consulted for names TOOL_ACCESS_MATRIX does not hold. */
export interface RemoteToolPermission {
  permission: string | null;
  mutating: boolean;
  roles: readonly WorkforcePlanRole[];
}

export const REMOTE_TOOL_PERMISSIONS: Record<string, RemoteToolPermission> = {};

/** Whether a given tool can be invoked by a user with the given role. */
export function canRoleCallTool(toolName: string, role: WorkforcePlanRole): boolean {
  const access = TOOL_ACCESS_MATRIX[toolName]?.[role];
  if (access) return access !== 'deny';
  const remote = REMOTE_TOOL_PERMISSIONS[toolName];
  if (remote) return remote.roles.includes(role);
  return false;
}

/** Return the list of tool names that the given role is allowed to call.
 *
 *  `handover`: this turn IS a hand-over from Liftoff or the Insights Manager,
 *  so the Chief AI Officer is offered no colleague of its own and a hand-over
 *  is one deep on every surface. Everything else stays: the person is present. */
export function toolsForRole(role: WorkforcePlanRole, opts: { handover?: boolean } = {}): string[] {
  return [...Object.keys(TOOL_ACCESS_MATRIX), ...Object.keys(REMOTE_TOOL_PERMISSIONS)]
    .filter(name => !(opts.handover === true && name === BRING_IN_COLLEAGUE_TOOL))
    .filter(name => canRoleCallTool(name, role));
}
