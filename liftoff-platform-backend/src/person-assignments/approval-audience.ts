// Who an approval or escalation is for.
//
// One resolver, because this question was previously answered by two
// byte-identical copies (the Slack and Teams internal routers) that could
// drift, and answered differently again by the review page, which ignored
// assignment entirely. Every surface now asks here.
//
// Two axes, and they are not the same question:
//
//   notifyAccountIds — who is *asked*. The assignees, minus anyone who cannot
//     actually approve. No eligible assignee falls through to the workspace
//     admins and owners, who are the standing backstop.
//
//   visibility — who *sees* it without being asked. An assigned agent's
//     requests belong to its assignees; an unassigned agent's belong to the
//     whole workspace. This drives the chat banner and the default review
//     queue, and is deliberately narrower than "who may act": admins and
//     owners can always act, but do not get a banner for every agent in a
//     fifty-agent workspace, or the banner stops meaning anything.
//
// The viewer filter is the reason this exists. Assignment is a row in a table;
// authority is a workspace role. Nothing stops assigning a viewer to an agent,
// and when that happened the request routed to somebody who could not act,
// nobody else was told, and the Slack card offered them buttons that threw.

import { withTenantScope } from '../infrastructure/database';
import { canApproveHitl } from '../tenant-members/permissions';

export type ApprovalVisibility = 'assignees' | 'workspace';

export interface ApprovalAudience {
  /** Accounts to notify and route to. Never contains someone who cannot act. */
  notifyAccountIds: string[];
  /** Who sees it unasked: the assignees, or everyone when the agent has none. */
  visibility: ApprovalVisibility;
  /** Assignees as configured, including any who cannot approve at this level.
   *  Kept so a surface can say "assigned to Ada" even when Ada is a viewer and
   *  the request had to route past her. */
  assigneeAccountIds: string[];
  /** True when nobody assigned could act and this fell through to admins. */
  fellBackToAdmins: boolean;
}

interface AssigneeRow {
  account_id: string;
  role: string | null;
}

/**
 * Resolve the audience for an approval on `agentId` at `hitlLevel`.
 *
 * `hitlLevel` matters because authority is per level: owners and admins can
 * approve level 1 and 2, members only level 2, viewers neither. An assignee
 * who can take a level 2 gate may still have to be routed past on a level 1.
 */
export async function resolveApprovalAudience(
  tenantId: string,
  agentId: string,
  hitlLevel: 1 | 2 = 2,
): Promise<ApprovalAudience> {
  const assignees = await withTenantScope(tenantId, async (c) => {
    // LEFT JOIN so somebody assigned who has since left the workspace still
    // shows in assigneeAccountIds (with a null role) rather than vanishing —
    // the UI can then explain the gap instead of silently dropping them.
    const r = await c.query<AssigneeRow>(
      `SELECT pa.account_id, tm.role
         FROM person_agent_assignments pa
         LEFT JOIN tenant_members tm
           ON tm.tenant_id = pa.tenant_id AND tm.account_id = pa.account_id
        WHERE pa.tenant_id = $1 AND pa.agent_id = $2
          AND pa.agent_origin = 'internal' AND pa.deleted_at IS NULL
        ORDER BY pa.created_at ASC`,
      [tenantId, agentId],
    );
    return r.rows;
  });

  const assigneeAccountIds = assignees.map((a) => a.account_id);
  const eligible = assignees
    .filter((a) => a.role && canApproveHitl(a.role, hitlLevel))
    .map((a) => a.account_id);

  if (eligible.length > 0) {
    return {
      notifyAccountIds: eligible,
      visibility: 'assignees',
      assigneeAccountIds,
      fellBackToAdmins: false,
    };
  }

  const admins = await withTenantScope(tenantId, async (c) => {
    const r = await c.query<{ account_id: string }>(
      `SELECT account_id FROM tenant_members
        WHERE tenant_id = $1 AND role IN ('admin', 'owner')
        ORDER BY joined_at ASC`,
      [tenantId],
    );
    return r.rows.map((x) => x.account_id);
  });

  return {
    notifyAccountIds: admins,
    // An agent with assignees who simply cannot approve is still *assigned* —
    // its requests do not become everyone's business just because the routing
    // had to go past them.
    visibility: assigneeAccountIds.length > 0 ? 'assignees' : 'workspace',
    assigneeAccountIds,
    fellBackToAdmins: true,
  };
}
