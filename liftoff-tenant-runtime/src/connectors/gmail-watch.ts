// WS-9.2 — gmail-watch arm + re-arm helpers.
//
// Calls connector-service's POST /api/connectors/:connectorId/webhooks
// endpoint to arm Gmail users.watch for this binding, then records the
// resulting subscription in gmail_watch_subscriptions so the re-arm cron
// can refresh it before Google's 7-day expiry.

import { getPool } from '../infrastructure/database';
import { readBoundedErrorText } from '../infrastructure/bounded-error-body';
import { logger } from '../infrastructure/logging';
import { setTraceContext } from '../infrastructure/safe-trace-context';
import { getManagedSecret } from '../infrastructure/secret-store';
import { armDue, MAINTENANCE_PATHS } from '../infrastructure/maintenance-tasks';

interface WebhookArmResponse {
  subscriptionId: string;
  expiresAt: string | null;
  historyId?: string;
  expirationMs?: number;
}

/**
 * Arm Gmail users.watch for the given binding. On success, persists the
 * subscription in gmail_watch_subscriptions; on failure, increments the
 * binding's failure_count so the re-arm cron triages it.
 */
export async function armGmailWatchFor(
  connectorId: string,
  tenantId: string,
): Promise<void> {
  setTraceContext({ tenantId });
  const base = process.env.CONNECTOR_SERVICE_URL;
  if (!base) throw new Error('CONNECTOR_SERVICE_URL not set');
  const token = getManagedSecret('CONNECTOR_SERVICE_TOKEN') ?? '';
  const gcpProject = process.env.GCP_PROJECT;
  const env = process.env.ENVIRONMENT;
  if (!gcpProject || !env) {
    throw new Error('armGmailWatchFor: GCP_PROJECT + ENVIRONMENT required to compose Pub/Sub topic name');
  }
  const topicName = `projects/${gcpProject}/topics/gmail-history-${env}`;
  // tenantId in query string (connector-service's getTenantId reads from
  // ?tenantId or body.tenantId, NOT from x-tenant-id header).
  const url = `${base}/api/connectors/${encodeURIComponent(connectorId)}/webhooks?tenantId=${encodeURIComponent(tenantId)}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'X-Service-Auth': token } : {}),
    },
    body: JSON.stringify({
      externalId: 'me',
      channelToken: connectorId,
      // For Gmail, connector-service reinterprets this field as the
      // Pub/Sub topic name (vs. the HTTP webhook URL used for Drive /
      // OneDrive / SharePoint / Box). TR is per-tenant and knows its
      // own GCP project; connector-service is shared and must not guess.
      notificationUrl: topicName,
    }),
  });
  if (!resp.ok) {
    throw new Error(`armGmailWatchFor: HTTP ${resp.status} ${await readBoundedErrorText(resp)}`);
  }
  const body = (await resp.json()) as WebhookArmResponse;
  const expirationMs = body.expirationMs ?? (body.expiresAt ? Date.parse(body.expiresAt) : Date.now() + 7 * 24 * 60 * 60 * 1000);
  const historyId = body.historyId ?? '';
  await getPool().query(
    `INSERT INTO gmail_watch_subscriptions
       (tenant_id, connector_id, gmail_user_id, pubsub_topic, history_id, watch_expires_at)
     VALUES ($1, $2, 'me',
             $3,
             $4,
             to_timestamp($5 / 1000.0))
     ON CONFLICT (connector_id) DO UPDATE SET
       history_id = EXCLUDED.history_id,
       watch_expires_at = EXCLUDED.watch_expires_at,
       re_armed_at = NOW(),
       failure_count = 0`,
    [
      tenantId,
      connectorId,
      `projects/${process.env.GCP_PROJECT}/topics/gmail-history-${process.env.ENVIRONMENT}`,
      historyId,
      expirationMs,
    ],
  );
  logger.info(
    { connector_id: connectorId, tenant_id: tenantId, history_id: historyId, expires_at: new Date(expirationMs).toISOString() },
    'gmail-watch: armed',
  );
  await armNextGmailRearm();
}

/** How long before Google expires a watch it is re-armed. */
const REARM_LEAD_MS = 36 * 60 * 60 * 1000;

/**
 * Arm the re-arm pass for the earliest watch that will need it.
 *
 * Every watch stores the expiry Google gave it, so the pass is armed for
 * (earliest expiry − 36 h) instead of running on a 12-hourly clock: once
 * a week per watch, and never with no watches. Called after each arm (which
 * moves that watch's expiry out) and after each pass. A watch that has
 * failed three times is left out, as the pass itself leaves it out; the
 * daily housekeeping pass is the backstop for an arming that is lost.
 */
export async function armNextGmailRearm(): Promise<void> {
  try {
    const { rows } = await getPool().query<{ next: Date | null }>(
      `SELECT MIN(watch_expires_at) AS next FROM gmail_watch_subscriptions WHERE failure_count < 3`,
    );
    const next = rows[0]?.next;
    if (!next) return;
    // A pass that just failed leaves the expiry inside the lead window; the
    // hour floor makes that a retry an hour later, not a loop.
    armDue('gmail-watch-rearm', MAINTENANCE_PATHS.gmailWatchRearm, new Date(new Date(next).getTime() - REARM_LEAD_MS), {
      minDelayMs: 60 * 60 * 1000,
    });
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'Non-fatal: next gmail-watch re-arm not armed');
  }
}

/**
 * Arm Gmail watches for every google_mail connector_manifest row that has
 * NO matching gmail_watch_subscriptions row. Covers connectors that never
 * went through the normal arm path on connect (e.g. legacy rows from
 * before handleCredentialsStored auto-armed, or composio_managed
 * connectors that failed to arm while the webhook endpoint's credential
 * resolution did not yet understand composio_managed).
 *
 * Distinct from `rearmExpiringGmailWatches`, which only refreshes rows
 * that already exist + are nearing the 7-day Google expiry. This is the
 * "first-time arm" complement.
 *
 * Idempotent: armGmailWatchFor's INSERT uses ON CONFLICT DO UPDATE, so
 * re-running this with already-armed connectors is safe (it'll bump
 * re_armed_at + reset failure_count).
 */
export async function armMissingGmailWatches(): Promise<{
  armed: number;
  failed: number;
  candidates: number;
}> {
  const pool = getPool();
  const missing = await pool.query(
    `SELECT m.id AS connector_id, m.tenant_id
       FROM connector_manifests m
       LEFT JOIN gmail_watch_subscriptions s ON s.connector_id = m.id
      WHERE m.connector_type = 'google_mail'
        AND m.enabled = true
        AND s.connector_id IS NULL`,
  );
  let armed = 0;
  let failed = 0;
  for (const r of missing.rows) {
    try {
      await armGmailWatchFor(r.connector_id, r.tenant_id);
      armed++;
    } catch (err) {
      failed++;
      logger.warn(
        { err: (err as Error).message, connector_id: r.connector_id, tenant_id: r.tenant_id },
        'gmail-watch: initial arm failed (bulk backfill)',
      );
    }
  }
  return { armed, failed, candidates: missing.rows.length };
}

/**
 * Refresh every gmail watch expiring in the next 36 hours. Armed for the
 * earliest expiry by armNextGmailRearm, and run by the daily housekeeping
 * pass as the backstop.
 */
export async function rearmExpiringGmailWatches(): Promise<{ re_armed: number; failed: number }> {
  const pool = getPool();
  const expiring = await pool.query(
    `SELECT tenant_id, connector_id FROM gmail_watch_subscriptions
     WHERE watch_expires_at < NOW() + INTERVAL '36 hours'
       AND failure_count < 3`,
  );
  let reArmed = 0;
  let failed = 0;
  for (const r of expiring.rows) {
    try {
      await armGmailWatchFor(r.connector_id, r.tenant_id);
      reArmed++;
    } catch (err) {
      failed++;
      logger.warn(
        { err: (err as Error).message, connector_id: r.connector_id, tenant_id: r.tenant_id },
        'gmail-watch: re-arm failed',
      );
      await pool.query(
        `UPDATE gmail_watch_subscriptions SET failure_count = failure_count + 1 WHERE connector_id = $1`,
        [r.connector_id],
      );
    }
  }
  await armNextGmailRearm();
  return { re_armed: reArmed, failed };
}
