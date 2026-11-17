// Backfill external account identifiers on existing connector rows.
//
// Identity fetchers (see ./identity-fetchers.ts) populate
// `config.externalAccountId` and `config.externalAccountLabel` on the
// OAuth callback path going forward. Existing rows in the DB pre-date
// that flow and have `config = {}` (or only the legacy `email` field on
// the Gmail-special-case rows). Without a backfill the Connected card
// subtitle has nothing to render for those rows except a category
// fallback, which is unacceptable UX.
//
// This module walks every connector row that:
//   - has status in (pending, active, error, disabled, disconnected)  ← we
//     keep disconnected rows here too because re-connecting them should
//     resurrect with a populated identity, and the backfill works as long
//     as the stored credentials are still valid
//   - belongs to an OAuth provider with a registered identity fetcher
//   - is missing `config.externalAccountId`
//
// For each row it fetches credentials (refreshing OAuth tokens if needed),
// calls the per-provider whoami via fetchExternalIdentity, and writes the
// result via mergeConnectorConfig. Failures are logged and skipped —
// network blips, revoked tokens, etc. don't block the rest of the run.
//
// The backfill is wired to run once on service startup, after the HTTP
// server is up so it never delays readiness. It's idempotent — subsequent
// boots re-scan and find zero rows needing work, so re-running is cheap.

import { withAdminScope } from '../db/pool.js';
import { logger } from '../infra/logging.js';
import { credentialService } from '../credentials/service.js';
import { getConnectorCredential } from '../secrets/client.js';
import { mergeConnectorConfig } from './connector-ops.js';
import {
  fetchExternalIdentity,
  providerSupportsMultiInstance,
} from './identity-fetchers.js';
import {
  fetchApiKeyIdentity,
  apiKeyConnectorSupportsMultiInstance,
} from './api-key-identity-fetchers.js';
import { getOAuthProvider, type ConnectorType } from '../types.js';

interface ConnectorRowForBackfill {
  id: string;
  tenant_id: string;
  type: string;
  status: string;
  config: Record<string, unknown> | null;
}

/**
 * Find every connector that's missing an externalAccountId AND belongs to
 * an OAuth provider whose identity fetcher we've implemented.
 *
 * Uses withAdminScope (RLS bypass) because the backfill runs cross-tenant.
 */
async function listConnectorsNeedingBackfill(): Promise<
  ConnectorRowForBackfill[]
> {
  const rows = await withAdminScope(
    { caller: 'backfill-account-ids', reason: 'one-shot identity backfill' },
    async (client) => {
      const res = await client.query<ConnectorRowForBackfill>(
        `SELECT id, tenant_id::text AS tenant_id, type, status, config
           FROM connectors
          WHERE (config IS NULL OR config->>'externalAccountId' IS NULL)
          ORDER BY created_at ASC`,
      );
      return res.rows;
    },
  );
  return rows;
}

interface BackfillStats {
  scanned: number;
  skipped_no_provider: number;
  skipped_no_fetcher: number;
  skipped_no_credentials: number;
  skipped_identity_unavailable: number;
  filled: number;
  errored: number;
}

async function backfillOne(
  row: ConnectorRowForBackfill,
  stats: BackfillStats,
): Promise<void> {
  const provider = getOAuthProvider(row.type as ConnectorType);

  // Two branches: OAuth (uses provider + access token) or API-key (uses raw
  // secret fields). Decide which based on whether an OAuth provider is
  // registered for the type.
  const isOAuth = provider !== null;
  const isApiKey = !isOAuth && apiKeyConnectorSupportsMultiInstance(row.type);

  if (!isOAuth && !isApiKey) {
    // Truly nothing to do — no OAuth provider and no API-key fetcher
    // registered (instant_connect connectors, providers we haven't built
    // fetchers for yet).
    if (provider === null) {
      stats.skipped_no_provider += 1;
    } else {
      stats.skipped_no_fetcher += 1;
    }
    return;
  }

  if (isOAuth) {
    if (!providerSupportsMultiInstance(provider!)) {
      stats.skipped_no_fetcher += 1;
      return;
    }

    let accessToken: string | undefined;
    let instanceUrl: string | undefined;
    try {
      const creds = await credentialService.getCredentials(row.tenant_id, row.id);
      accessToken = creds.accessToken;
      instanceUrl = creds.instanceUrl;
    } catch (err) {
      logger.info(
        {
          connectorId: row.id,
          tenantId: row.tenant_id,
          type: row.type,
          reason: (err as Error).message,
        },
        'backfill: skipping — no usable credentials',
      );
      stats.skipped_no_credentials += 1;
      return;
    }

    if (!accessToken) {
      stats.skipped_no_credentials += 1;
      return;
    }

    const identity = await fetchExternalIdentity(provider!, accessToken, {
      instanceUrl,
      connectorType: row.type,
    });

    if (!identity) {
      stats.skipped_identity_unavailable += 1;
      return;
    }

    return await writeIdentity(row, identity, stats);
  }

  // API-key branch — pull raw fields from Secret Manager.
  let fields: Record<string, unknown>;
  try {
    const secret = await getConnectorCredential(row.tenant_id, row.id);
    // The connect endpoint stores the primary key separately + the rest
    // under metadata.extraFields. Reassemble the original fields map for
    // the fetcher.
    const extra = (secret.metadata as { extraFields?: Record<string, unknown> })?.extraFields ?? {};
    fields = {
      ...extra,
      apiKey: secret.apiKey ?? extra.apiKey,
    };
  } catch (err) {
    logger.info(
      {
        connectorId: row.id,
        tenantId: row.tenant_id,
        type: row.type,
        reason: (err as Error).message,
      },
      'backfill: skipping — no usable api-key credentials',
    );
    stats.skipped_no_credentials += 1;
    return;
  }

  const identity = await fetchApiKeyIdentity(row.type, fields);
  if (!identity) {
    stats.skipped_identity_unavailable += 1;
    return;
  }
  return await writeIdentity(row, identity, stats);
}

async function writeIdentity(
  row: ConnectorRowForBackfill,
  identity: { externalAccountId: string; externalAccountLabel: string | null },
  stats: BackfillStats,
): Promise<void> {

  try {
    await mergeConnectorConfig(row.tenant_id, row.id, {
      externalAccountId: identity.externalAccountId,
      externalAccountLabel: identity.externalAccountLabel,
    });
    stats.filled += 1;
    logger.info(
      {
        connectorId: row.id,
        tenantId: row.tenant_id,
        type: row.type,
        externalAccountLabel: identity.externalAccountLabel,
      },
      'backfill: filled externalAccountId+Label',
    );
  } catch (err) {
    stats.errored += 1;
    logger.warn(
      {
        connectorId: row.id,
        tenantId: row.tenant_id,
        type: row.type,
        error: (err as Error).message,
      },
      'backfill: mergeConnectorConfig failed',
    );
  }
}

/**
 * Walk every connector row missing externalAccountId, fetch identity, and
 * write it. Idempotent: rows already carrying externalAccountId are not
 * selected, so re-running the backfill on next boot is a no-op.
 *
 * Designed to be invoked once on service startup (fire-and-forget). Any
 * thrown error here would crash startup, which we don't want, so we
 * absorb errors inside the function — callers don't need to wrap.
 */
export async function backfillExternalAccountIds(): Promise<BackfillStats> {
  const stats: BackfillStats = {
    scanned: 0,
    skipped_no_provider: 0,
    skipped_no_fetcher: 0,
    skipped_no_credentials: 0,
    skipped_identity_unavailable: 0,
    filled: 0,
    errored: 0,
  };

  let rows: ConnectorRowForBackfill[];
  try {
    rows = await listConnectorsNeedingBackfill();
  } catch (err) {
    logger.error(
      { error: (err as Error).message },
      'backfill: failed to list connectors — aborting',
    );
    return stats;
  }

  stats.scanned = rows.length;
  if (rows.length === 0) {
    logger.info('backfill: zero rows need externalAccountId — skipping');
    return stats;
  }

  logger.info(
    { count: rows.length },
    'backfill: scanning connectors missing externalAccountId',
  );

  // Bounded concurrency (cap 5): don't hammer a provider's whoami with every
  // row at once, but don't crawl strictly one-at-a-time either. Per-row
  // failures are isolated (best-effort).
  const CONCURRENCY = 5;
  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const batch = rows.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (row) => {
        try {
          await backfillOne(row, stats);
        } catch (err) {
          stats.errored += 1;
          logger.warn(
            {
              connectorId: row.id,
              tenantId: row.tenant_id,
              type: row.type,
              error: (err as Error).message,
            },
            'backfill: unexpected error processing row',
          );
        }
      }),
    );
  }

  logger.info({ stats }, 'backfill: complete');
  return stats;
}
