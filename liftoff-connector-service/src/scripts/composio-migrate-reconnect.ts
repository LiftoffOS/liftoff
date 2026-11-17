// Composio migration: force-reconnect existing cal_com / mailchimp / trello
// rows.
//
// These three connectors previously used Liftoff's own auth (api_key) and
// sidecar MCP. Phase 2 flipped them to Composio managed OAuth. Existing
// active rows still point at stored Liftoff credentials and the now-removed
// sidecar — they MUST be reconnected through Composio before any agent
// call against them can succeed.
//
// Strategy: flip `status='active' → 'error'` with a `disconnect_reason`
// stamp in `config`, then emit a `connector.disconnected` control-plane
// event. The choice of 'error' (not 'disconnected') is deliberate: the
// frontend's useIntegrations hook surfaces `status === 'error'` rows as
// `needs_reconnect` in the Connections UI (Liftoff-React/src/hooks/
// useIntegrations.ts:92) and renders a "Reconnect" affordance, whereas
// rows with `status === 'disconnected'` are filtered out entirely and the
// user has no way to discover the migration. The event also fires
// tenant-runtime's connector-disconnected handler which disables the
// manifest + revokes the now-stale Liftoff credentials.
//
// Idempotent + dry-run-default. Run via Cloud Run Job after the cutover
// deploy:
//
//   DRY_RUN=true  npm run composio:migrate-reconnect    # shows what would change
//   DRY_RUN=false npm run composio:migrate-reconnect    # applies the flip

import { logger } from '../infra/logging.js';
import { withAdminScope } from '../db/pool.js';
import { publishEvent } from '../events/publisher.js';

const AFFECTED_TYPES = ['cal_com', 'mailchimp', 'trello'];
const DRY_RUN = process.env.DRY_RUN !== 'false';

interface AffectedRow {
  id: string;
  tenantId: string;
  type: string;
  status: string;
}

async function loadAffected(): Promise<AffectedRow[]> {
  return withAdminScope(
    {
      caller: 'composio-migrate-reconnect.loadAffected',
      reason: 'Cross-tenant list of pre-Composio active rows for migration',
    },
    async (client) => {
      const res = await client.query(
        `SELECT id, tenant_id, type, status
           FROM connectors
           WHERE type = ANY($1::text[])
             AND status = 'active'`,
        [AFFECTED_TYPES],
      );
      return res.rows.map((r) => ({
        id: r.id as string,
        tenantId: r.tenant_id as string,
        type: r.type as string,
        status: r.status as string,
      }));
    },
  );
}

async function flipRow(row: AffectedRow): Promise<void> {
  await withAdminScope(
    {
      caller: 'composio-migrate-reconnect.flipRow',
      reason: 'Mark pre-Composio active row as error for forced reconnect',
    },
    async (client) => {
      await client.query(
        `UPDATE connectors
           SET status = 'error',
               config = COALESCE(config, '{}'::jsonb)
                          || '{"disconnect_reason":"composio_migration"}'::jsonb,
               updated_at = NOW()
           WHERE id = $1`,
        [row.id],
      );
    },
  );

  // Emit the existing `connector.disconnected` event so:
  //   - tenant-runtime disables the local connector_manifests row (so the
  //     tool gateway stops attempting calls against the stale Liftoff creds)
  //     and marks the credentials revoked,
  //   - platform-backend's audit subscriber logs the migration for ops.
  // The user-facing "Reconnect" affordance comes from `status = 'error'`
  // above, NOT from any notification row written by a subscriber.
  await publishEvent({
    entityType: 'connector',
    entityId: row.id,
    eventType: 'connector.disconnected',
    eventVersion: 1,
    tenantId: row.tenantId,
    payload: {
      connectorId: row.id,
      connectorType: row.type,
      reason: 'composio_migration',
    },
    attributes: { connectorType: row.type, reason: 'composio_migration' },
  });
}

async function main(): Promise<void> {
  const rows = await loadAffected();
  console.log(`Affected rows: ${rows.length}`);
  if (DRY_RUN) {
    console.log('DRY_RUN=true — not mutating. Set DRY_RUN=false to apply.');
    rows.forEach((r) => console.log(`  ${r.tenantId} ${r.type} ${r.id}`));
    return;
  }
  for (const row of rows) {
    try {
      await flipRow(row);
      console.log(`Flipped ${row.id} (tenant=${row.tenantId}, type=${row.type})`);
    } catch (err) {
      logger.error(
        { err: (err as Error).message, connectorId: row.id, tenantId: row.tenantId },
        'composio_migrate_reconnect_flip_failed',
      );
    }
  }
}

// `withAdminScope` initialises the Postgres pool on first use; its idle
// TCP connections + the Pub/Sub client's keepalive timers hold the event
// loop open after main() resolves, so the script never naturally exits.
// In Cloud Run that means the task runs the migration successfully,
// returns from main(), and then sits idle until the 300s task timeout
// SIGKILLs the container — which Cloud Run records as FAILED. An
// operator seeing FAILED would reasonably re-execute, double-publishing
// every `connector.disconnected` event. Force-exit on success.
main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
