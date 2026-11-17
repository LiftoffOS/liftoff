// Backfill identity (externalAccountId + externalAccountLabel) on
// Composio-managed connectors whose label is still the opaque
// `ca_XXX` Composio id.
//
// Root cause: the original extractComposioIdentity scanned a flat list of
// vendor field names; for OIDC providers (Google, Microsoft, …) the
// identity lives inside `state.val.id_token` (a JWT), which the heuristic
// missed. Several non-OIDC vendors (Slack, Dropbox, Atlassian, …) also
// need a vendor whoami call.
//
// The new extractComposioIdentity layers:
//   1. flat-field heuristic
//   2. id_token JWT decode
//   3. composio.tools.execute('<vendor whoami>')
//
// This backfill re-runs that chain against every legacy row. Idempotent:
// rows already carrying a non-`ca_XXX` label are skipped.
//
// Usage (Cloud Run Job pattern from CLAUDE.md):
//
//   DRY_RUN=true  node dist/scripts/composio-identity-backfill.js
//   DRY_RUN=false node dist/scripts/composio-identity-backfill.js

import { logger } from '../infra/logging.js';
import { withAdminScope } from '../db/pool.js';
import { mergeConnectorConfig } from '../oauth/connector-ops.js';
import { extractComposioIdentity } from '../oauth/identity-fetchers.js';
import { getComposio, type ComposioConnectedAccount } from '../oauth/composio-client.js';

const DRY_RUN = process.env.DRY_RUN !== 'false';

interface AffectedRow {
  id: string;
  tenantId: string;
  type: string;
  composioConnectedAccountId: string;
  currentLabel: string;
}

async function loadAffected(): Promise<AffectedRow[]> {
  return withAdminScope(
    {
      caller: 'composio-identity-backfill.loadAffected',
      reason: 'List composio_managed connectors whose label is still the ca_XXX placeholder',
    },
    async (client) => {
      const res = await client.query<{
        id: string;
        tenant_id: string;
        type: string;
        composio_id: string;
        label: string;
      }>(
        `SELECT
           id,
           tenant_id::text AS tenant_id,
           type,
           config->>'composioConnectedAccountId' AS composio_id,
           config->>'externalAccountLabel' AS label
         FROM connectors
         WHERE config ? 'composioConnectedAccountId'
           AND (
             config->>'externalAccountLabel' LIKE 'ca\\_%' ESCAPE '\\'
             OR config->>'externalAccountLabel' IS NULL
           )
         ORDER BY tenant_id, type`,
      );
      return res.rows.map((r) => ({
        id: r.id,
        tenantId: r.tenant_id,
        type: r.type,
        composioConnectedAccountId: r.composio_id,
        currentLabel: r.label ?? '(null)',
      }));
    },
  );
}

async function refetchAccount(
  composioConnectedAccountId: string,
): Promise<ComposioConnectedAccount | null> {
  try {
    const composio = getComposio();
    // @composio/core's connectedAccounts.get returns the canonical row
    // with both `params` (legacy) and `state.val` (modern). The shape we
    // accept is loose — see ComposioConnectedAccount type.
    const acc = (await composio.connectedAccounts.get(
      composioConnectedAccountId,
    )) as unknown as ComposioConnectedAccount;
    return acc;
  } catch (err) {
    logger.warn(
      { composioConnectedAccountId, error: (err as Error).message },
      'composio-identity-backfill: connectedAccounts.get failed',
    );
    return null;
  }
}

async function fixRow(row: AffectedRow): Promise<'fixed' | 'unchanged' | 'errored'> {
  const account = await refetchAccount(row.composioConnectedAccountId);
  if (!account) return 'errored';
  const identity = await extractComposioIdentity(
    row.type,
    account,
    getComposio(),
    row.tenantId,
  );
  // If the extractor still returned ca_XXX, log and move on — nothing to
  // backfill until a per-toolkit whoami spec is added.
  if (identity.externalAccountLabel === row.composioConnectedAccountId) {
    logger.warn(
      {
        connectorId: row.id,
        tenantId: row.tenantId,
        type: row.type,
        composioConnectedAccountId: row.composioConnectedAccountId,
      },
      'composio-identity-backfill: extractor still returned ca_XXX — add a whoami spec for this toolkit',
    );
    return 'unchanged';
  }
  if (DRY_RUN) {
    logger.info(
      {
        connectorId: row.id,
        tenantId: row.tenantId,
        type: row.type,
        before: row.currentLabel,
        after: identity.externalAccountLabel,
      },
      'composio-identity-backfill: DRY_RUN would fix',
    );
    return 'fixed';
  }
  await mergeConnectorConfig(row.tenantId, row.id, {
    externalAccountId: identity.externalAccountId,
    externalAccountLabel: identity.externalAccountLabel,
  });
  logger.info(
    {
      connectorId: row.id,
      tenantId: row.tenantId,
      type: row.type,
      before: row.currentLabel,
      after: identity.externalAccountLabel,
    },
    'composio-identity-backfill: fixed',
  );
  return 'fixed';
}

async function main(): Promise<void> {
  const rows = await loadAffected();
  console.log(`Affected rows: ${rows.length}`);
  if (rows.length === 0) {
    console.log('Nothing to backfill.');
    return;
  }
  if (DRY_RUN) {
    console.log('DRY_RUN=true — not mutating. Set DRY_RUN=false to apply.');
  }
  const counts = { fixed: 0, unchanged: 0, errored: 0 };
  for (const row of rows) {
    try {
      const outcome = await fixRow(row);
      counts[outcome] += 1;
    } catch (err) {
      counts.errored += 1;
      logger.warn(
        { connectorId: row.id, type: row.type, error: (err as Error).message },
        'composio-identity-backfill: row failed',
      );
    }
  }
  console.log(JSON.stringify(counts, null, 2));
}

main().then(
  () => process.exit(0),
  (err) => {
    logger.error({ error: (err as Error).message }, 'composio-identity-backfill: fatal');
    process.exit(1);
  },
);
