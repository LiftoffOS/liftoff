// Tenant Members Data Provider
// Queries tenant_members + accounts for workforce composition

import { getPool, withTenantScope } from '../../infrastructure/database';
import { log } from '../../infrastructure/logging';
import { getHumanTaskCounts } from '../../human-feedback/human-task-counts';
import type { TenantMemberInfo, MemberActivity, TimeRange } from '../types';
import { MEMBERS_IN_WINDOW_CTE } from './membership-window';

// Display name: first_name + last_name, falling back to email if both are empty
const DISPLAY_NAME_SQL = `COALESCE(NULLIF(TRIM(CONCAT(a.first_name, ' ', a.last_name)), ''), a.email)`;

/**
 * Get all tenant members with their account info.
 */
export async function getTenantMembers(
  tenantId: string,
): Promise<TenantMemberInfo[]> {
  try {
    // tenant_members is RLS-on (migration 095). accounts is RLS-excluded.
    // Run under tenant scope so the JOIN works once FORCE RLS is enabled.
    const result = await withTenantScope(tenantId, (client) =>
      client.query(
        `SELECT
           tm.account_id,
           ${DISPLAY_NAME_SQL} as display_name,
           a.email,
           tm.role
         FROM tenant_members tm
         JOIN accounts a ON a.id = tm.account_id
         WHERE tm.tenant_id = $1
         ORDER BY tm.role, a.first_name`,
        [tenantId],
      ),
    );

    return result.rows.map(row => ({
      accountId: row.account_id as string,
      displayName: row.display_name as string,
      email: row.email as string,
      role: row.role as string,
    }));
  } catch (error) {
    log.error({ tenantId, error: (error as Error).message }, 'Failed to fetch tenant members');
    return [];
  }
}

/**
 * Get member activity for the period.
 *
 * "approvalCount" = in-time HITL decisions + late HITL feedback for the account
 * "correctionCount" = corrections from agent_audit_logs for the account
 *
 * Counts are sourced from getHumanTaskCounts so /insights and /teams stay
 * aligned. Display rows include:
 *   - All current members in window (even with zero activity), and
 *   - Former members who had activity during the window.
 */
export async function getMemberActivity(
  tenantId: string,
  range: TimeRange,
): Promise<MemberActivity[]> {
  try {
    // tenant_members + tenant_member_audit (RLS-on per migration 095) run under
    // withTenantScope; the trailing accounts lookup for former-members below
    // uses the regular pool because accounts is RLS-excluded.
    const [membersResult, taskCounts] = await Promise.all([
      withTenantScope(tenantId, (client) =>
        client.query(
          `${MEMBERS_IN_WINDOW_CTE}
           SELECT miw.account_id::text AS account_id, ${DISPLAY_NAME_SQL} AS display_name
           FROM members_in_window miw
           JOIN accounts a ON a.id = miw.account_id`,
          [tenantId, range.start, range.end],
        ),
      ),
      getHumanTaskCounts(tenantId, range.start, range.end),
    ]);

    const memberMap = new Map<
      string,
      { displayName: string; approvalCount: number; correctionCount: number }
    >();

    for (const row of membersResult.rows) {
      memberMap.set(row.account_id as string, {
        displayName: row.display_name as string,
        approvalCount: 0,
        correctionCount: 0,
      });
    }

    // Apply counts to members already in window
    const formerIds: string[] = [];
    for (const [accountId, counts] of Object.entries(taskCounts)) {
      const existing = memberMap.get(accountId);
      if (existing) {
        existing.approvalCount = counts.approvalCount;
        existing.correctionCount = counts.correctionCount;
      } else {
        formerIds.push(accountId);
      }
    }

    // Look up display names for former members who had activity. accounts is
    // RLS-excluded so this can use the regular pool directly.
    if (formerIds.length > 0) {
      const formerResult = await getPool().query(
        `SELECT a.id::text AS account_id, ${DISPLAY_NAME_SQL} AS display_name
         FROM accounts a
         WHERE a.id = ANY($1::uuid[])`,
        [formerIds],
      );
      for (const row of formerResult.rows) {
        const counts = taskCounts[row.account_id as string];
        memberMap.set(row.account_id as string, {
          displayName: row.display_name as string,
          approvalCount: counts.approvalCount,
          correctionCount: counts.correctionCount,
        });
      }
    }

    return Array.from(memberMap.entries())
      .map(([accountId, info]) => ({
        accountId,
        displayName: info.displayName,
        approvalCount: info.approvalCount,
        correctionCount: info.correctionCount,
      }))
      .sort(
        (a, b) =>
          b.approvalCount + b.correctionCount - (a.approvalCount + a.correctionCount),
      );
  } catch (error) {
    log.error({ tenantId, error: (error as Error).message }, 'Failed to fetch member activity');
    return [];
  }
}
