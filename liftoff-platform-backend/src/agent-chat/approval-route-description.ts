// Turn "who is this approval for" into something the chat can say out loud.
//
// A gate used to stop the thread with no explanation of who could unstick it.
// The person who triggered it was told "waiting on your review" even when the
// request had routed elsewhere, and everyone else in a shared thread saw only
// a conversation that stopped.
//
// Names, not account ids, because this is read by people. The ids ride along
// so a client can tell whether it is looking at its own name.

import { withTenantScope } from '../infrastructure/database';
import { resolveApprovalAudience } from '../person-assignments/approval-audience';
import { log } from '../infrastructure/logging';

export interface ApprovalRouteDescription {
  names: string[];
  accountIds: string[];
  /** True when this fell through to the workspace admins. The UI names the
   *  role rather than listing them — it is a role, not a chosen person. */
  toAdmins: boolean;
  /** True when the agent has nobody assigned, so the request is open to the
   *  workspace rather than escalated past specific people. The distinction
   *  changes the wording: open reads in second person ("your review"), while
   *  escalated names the admins it went to. */
  unassigned: boolean;
}

const EMPTY: ApprovalRouteDescription = {
  names: [], accountIds: [], toAdmins: false, unassigned: false,
};

export async function describeApprovalRoute(
  tenantId: string,
  agentId: string,
  hitlLevel: 1 | 2 = 2,
): Promise<ApprovalRouteDescription> {
  try {
    const audience = await resolveApprovalAudience(tenantId, agentId, hitlLevel);
    if (audience.notifyAccountIds.length === 0) return EMPTY;

    // Only resolve names when we are naming specific people. An admin fallback
    // is described by its role, so the lookup would be wasted.
    if (audience.fellBackToAdmins) {
      return {
        names: [],
        accountIds: audience.notifyAccountIds,
        toAdmins: true,
        unassigned: audience.assigneeAccountIds.length === 0,
      };
    }

    const names = await withTenantScope(tenantId, async (c) => {
      const r = await c.query<{ id: string; first_name: string | null; last_name: string | null; email: string }>(
        `SELECT id, first_name, last_name, email
           FROM accounts WHERE id = ANY($1::uuid[])`,
        [audience.notifyAccountIds],
      );
      // Preserve the audience order rather than the database's.
      const byId = new Map(r.rows.map((row) => [row.id, row]));
      return audience.notifyAccountIds
        .map((id) => byId.get(id))
        .filter((row): row is NonNullable<typeof row> => !!row)
        .map((row) => [row.first_name, row.last_name].filter(Boolean).join(' ').trim() || row.email);
    });

    return { names, accountIds: audience.notifyAccountIds, toAdmins: false, unassigned: false };
  } catch (err) {
    // Never let this break a turn. A gate with no route description still
    // works; it just says less.
    log.warn('could not describe approval route', {
      tenantId, agentId, error: (err as Error).message,
    });
    return EMPTY;
  }
}
