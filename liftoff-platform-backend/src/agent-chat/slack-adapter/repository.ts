// Slack-adapter repository.
//
// Per-agent installs are gone (ADR-040): one Liftoff app per environment
// serves every agent, and its install lives in slack_workspace_installs
// (see workspace-repository.ts). What remains here is the presence check
// distillation uses to decide whether to surface the slack_* tools.

import { withTenantScope } from '../../infrastructure/database';

/**
 * Whether Slack is connected for this tenant, as a count so callers can keep
 * treating it as "how many workspaces". The workspace install serves EVERY
 * agent, so this is tenant-level: agentId is accepted for call-site symmetry
 * and deliberately unused.
 */
export async function getInstalledSlackAppCount(
  tenantId: string,
  _agentId: string,
): Promise<number> {
  return withTenantScope(tenantId, async (client) => {
    const res = await client.query(
      `SELECT COUNT(*)::int AS c FROM slack_workspace_installs
        WHERE tenant_id = $1 AND install_status = 'installed'`,
      [tenantId],
    );
    return Number(res.rows[0]?.c ?? 0);
  });
}
