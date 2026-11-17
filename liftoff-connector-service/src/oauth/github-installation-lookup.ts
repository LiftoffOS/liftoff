// Which installation should a GitHub call act as?
//
// The connector row a caller names is not necessarily the row that carries the
// installation. Agents are bound to a connector id at distillation time and that
// id is baked into their compiled instructions; the App's installation lands on
// a per-account row created later. So an agent bound before the App was
// installed asks for a row with no installation and gets the OAuth user token —
// writes are authored by a person, which is the whole defect the App exists to
// remove.
//
// Resolved per TENANT rather than per row, so it is fixed for every caller at
// once and survives bindings that predate the App.

import { withTenantScope } from '../db/pool.js';
import { logger } from '../infra/logging.js';

/**
 * The installation this tenant's GitHub calls should act as, or 0 for none.
 *
 * The row's OWN installation always wins — a caller that named a specific
 * account gets that account.
 *
 * AMBIGUITY FALLS BACK RATHER THAN GUESSES. With several installations (a
 * personal account plus organizations) the right one depends on the target
 * repository, which is not known here. Picking arbitrarily would act as the
 * wrong account on someone else's repositories; returning 0 falls through to
 * the user token, which is a worse identity but a correct permission set. The
 * ambiguity is logged so it is visible rather than inferred, and resolving it
 * properly needs the repository threaded down to this call.
 */
export async function resolveGithubInstallationId(
  tenantId: string,
  connectorConfig: Record<string, unknown>,
): Promise<number> {
  const own = Number(connectorConfig.installationId ?? 0);
  if (Number.isInteger(own) && own > 0) return own;

  const rows = await withTenantScope(tenantId, async (client) => {
    const res = await client.query(
      `SELECT (config->>'installationId')::bigint AS installation_id,
              config->>'externalAccountLabel'     AS account
         FROM connectors
        WHERE tenant_id = $1
          AND type = 'github'
          AND status = 'active'
          AND config->>'installationId' IS NOT NULL
        ORDER BY created_at DESC`,
      [tenantId],
    );
    return res.rows as Array<{ installation_id: string; account: string | null }>;
  });

  if (rows.length === 1) {
    const id = Number(rows[0].installation_id);
    logger.info(
      { tenant_id: tenantId, installation_id: id, account: rows[0].account },
      'github_installation_resolved_from_sibling_row',
    );
    return Number.isFinite(id) ? id : 0;
  }

  if (rows.length > 1) {
    logger.warn(
      { tenant_id: tenantId, candidates: rows.map((r) => r.account) },
      'github_installation_ambiguous_falling_back_to_user_token',
    );
  }
  return 0;
}
