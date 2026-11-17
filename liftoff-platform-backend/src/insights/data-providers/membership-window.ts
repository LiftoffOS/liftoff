// Membership Window Helper
//
// Returns the set of account_ids that were tenant members at any point during
// the time range [start, end). Combines current members with former members
// reconstructed from tenant_member_audit (member.joined / member.left /
// member.removed events).
//
// Used by insights data providers so headcount-style queries reflect the
// composition of the workspace AT the selected period — not the current
// snapshot. Without this:
//   - Members who joined after `end` would leak into past periods
//   - Members who left before `start` would still appear (only via
//     tenant_members with no time filter)
//   - Members who left during the period would be missing entirely
//     (tenant_members hard-deletes via ON DELETE CASCADE)
//
// SQL parameter convention: $1 = tenantId, $2 = range.start, $3 = range.end
//
// An account is in-window if EITHER:
//   1. It is currently in tenant_members AND joined_at < end, OR
//   2. There is a (joined, left/removed) interval pair in
//      tenant_member_audit that overlaps [start, end), and the account is
//      not currently in tenant_members.

export const MEMBERS_IN_WINDOW_CTE = `
WITH members_in_window AS (
  SELECT tm.account_id
  FROM tenant_members tm
  WHERE tm.tenant_id = $1 AND tm.joined_at < $3
  UNION
  SELECT joins.account_id
  FROM tenant_member_audit joins
  JOIN tenant_member_audit leaves
    ON leaves.tenant_id = joins.tenant_id
    AND leaves.account_id = joins.account_id
  WHERE joins.tenant_id = $1
    AND joins.action = 'member.joined'
    AND joins.created_at < $3
    AND leaves.action IN ('member.left', 'member.removed')
    AND leaves.created_at > joins.created_at
    AND leaves.created_at >= $2
    AND joins.account_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM tenant_members tm2
      WHERE tm2.tenant_id = $1 AND tm2.account_id = joins.account_id
    )
)
`;
