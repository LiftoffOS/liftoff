// Which workspace was waiting for this GitHub organization?
//
// The `installation.created` webhook is the ONLY signal that a non-owner's
// request was approved, and GitHub sends it with no `state` and no reference to
// whoever asked. GitHub support has confirmed there is no way to identify the
// original requester. So the match has to be made from what WE stored when the
// request was made: the org our own picker asked for.
//
// CROSS-TENANT BY NECESSITY. A webhook arrives with no tenant context at all —
// that is the whole problem — so this reads across tenants under
// `withAdminScope`. It returns identity only: the tenant id and the connector
// id, never config or credentials, so a caller cannot accidentally use it as a
// general-purpose cross-tenant reader.

import { withAdminScope } from '../db/pool.js';

export interface PendingInstallRow {
  tenantId: string;
  connectorId: string;
}

/**
 * Rows waiting on an owner to approve the App for `accountLogin`.
 *
 * Returns ALL matches rather than the first. The caller fails closed on more
 * than one: binding an installation to the wrong workspace would grant it write
 * access to another workspace's repositories, and picking arbitrarily is how
 * that happens. Two tenants requesting the same org is unlikely and entirely
 * possible — a contractor in two workspaces, an agency, a shared org.
 *
 * Matched case-insensitively: GitHub logins are case-preserving but
 * case-insensitive, so a picker that recorded `LiftoffOS` must still match a
 * webhook that says `liftoffos`.
 */
/**
 * Rows that already hold this installation.
 *
 * Used only to tell a routine webhook from a genuinely unattributable one: a
 * direct install is attributed by the callback ~0.1s before the webhook lands,
 * so the webhook finding no PENDING row is expected. Without this distinction
 * both cases log the same warning and the real one is buried.
 */
export async function findTenantsHoldingInstallation(
  installationId: number,
): Promise<PendingInstallRow[]> {
  if (!Number.isInteger(installationId) || installationId <= 0) return [];
  return withAdminScope(
    {
      caller: 'oauth/github-app-pending.findTenantsHoldingInstallation',
      reason: 'GitHub installation webhook carries no tenant context',
    },
    async (client) => {
      const res = await client.query(
        `SELECT tenant_id, id FROM connectors
          WHERE type = 'github' AND (config->>'installationId')::bigint = $1`,
        [installationId],
      );
      return res.rows.map((row: { tenant_id: string; id: string }) => ({
        tenantId: row.tenant_id,
        connectorId: row.id,
      }));
    },
  );
}

export async function findTenantsAwaitingInstall(
  accountLogin: string,
): Promise<PendingInstallRow[]> {
  const login = (accountLogin ?? '').trim();
  if (!login) return [];

  return withAdminScope(
    {
      caller: 'oauth/github-app-pending.findTenantsAwaitingInstall',
      reason: 'GitHub installation webhook carries no tenant context',
    },
    async (client) => {
      const res = await client.query(
        `SELECT tenant_id, id
           FROM connectors
          WHERE type = 'github'
            AND status = 'pending'
            AND lower(config->>'awaitingOrgLogin') = lower($1)`,
        [login],
      );
      return res.rows.map((row: { tenant_id: string; id: string }) => ({
        tenantId: row.tenant_id,
        connectorId: row.id,
      }));
    },
  );
}
