// Control-Plane Outbox Worker
//
// Polls control_plane_outbox for pending rows and delivers them to the
// platform-backend via HTTP POST. Provides the reliable, retrying delivery
// that the old fire-and-forget postToControlPlane() lacked.
//
// The local audit_logs write and the outbox enqueue happen atomically in the
// same DB transaction inside insertAuditLog(). This worker picks up the row
// and delivers it, retrying up to MAX_RETRIES times before marking it failed.
// A failed row is kept (not deleted) so it can be re-queued or investigated.

import { pool } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import { getManagedSecret } from '../infrastructure/secret-store';

const POLL_INTERVAL_MS = 5_000;
const MAX_RETRIES = 10;
const BATCH_SIZE = 50;
const FETCH_TIMEOUT_MS = 10_000;

interface OutboxRow {
  id: string;
  endpoint: string;
  payload: unknown;
}

/**
 * Start the outbox worker. Safe to call multiple times — subsequent calls are
 * no-ops if CONTROL_PLANE_API_URL or TENANT_RUNTIME_SERVICE_TOKEN are missing.
 *
 * The worker should be started during agent-service startup, after secrets have
 * been loaded into process.env (i.e. after loadSecretsToEnv() completes).
 */
export function startOutboxWorker(): void {
  const controlPlaneUrl = process.env.CONTROL_PLANE_API_URL;
  const serviceToken = getManagedSecret('TENANT_RUNTIME_SERVICE_TOKEN');

  if (!controlPlaneUrl || !serviceToken) {
    log.warn(
      'OutboxWorker: CONTROL_PLANE_API_URL or TENANT_RUNTIME_SERVICE_TOKEN not set — outbox delivery disabled'
    );
    return;
  }

  log.info({ pollIntervalMs: POLL_INTERVAL_MS, maxRetries: MAX_RETRIES }, 'OutboxWorker: started');

  setInterval(() => {
    processOutboxBatch(controlPlaneUrl, serviceToken).catch((err) => {
      log.error({ err }, 'OutboxWorker: batch processing error');
    });
  }, POLL_INTERVAL_MS);
}

async function processOutboxBatch(controlPlaneUrl: string, serviceToken: string): Promise<void> {
  const { rows } = await pool.query<OutboxRow>(
    `SELECT id, endpoint, payload
     FROM control_plane_outbox
     WHERE status = 'pending' AND retry_count < $1
     ORDER BY created_at ASC
     LIMIT $2`,
    [MAX_RETRIES, BATCH_SIZE]
  );

  if (rows.length === 0) return;

  log.debug({ count: rows.length }, 'OutboxWorker: processing batch');

  // Deliver sequentially to avoid thundering-herd on the control plane when
  // there is a backlog after an outage.
  for (const row of rows) {
    await deliverOutboxEntry(row, controlPlaneUrl, serviceToken);
  }
}

async function deliverOutboxEntry(
  row: OutboxRow,
  controlPlaneUrl: string,
  serviceToken: string,
): Promise<void> {
  try {
    const res = await fetch(`${controlPlaneUrl}${row.endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Service-Auth': serviceToken,
      },
      body: JSON.stringify(row.payload),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (res.ok) {
      await pool.query(
        `UPDATE control_plane_outbox SET status = 'delivered' WHERE id = $1`,
        [row.id]
      );
      log.debug({ outboxId: row.id, endpoint: row.endpoint }, 'OutboxWorker: delivered');
      return;
    }

    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
  } catch (err) {
    // Increment retry_count. If this push crosses MAX_RETRIES, mark failed.
    const result = await pool.query(
      `UPDATE control_plane_outbox
       SET retry_count      = retry_count + 1,
           last_attempted_at = now(),
           status           = CASE
             WHEN retry_count + 1 >= $2 THEN 'failed'
             ELSE 'pending'
           END
       WHERE id = $1
       RETURNING status, retry_count`,
      [row.id, MAX_RETRIES]
    );

    const updated = result.rows[0];
    if (updated?.status === 'failed') {
      log.error(
        { err, outboxId: row.id, endpoint: row.endpoint, retryCount: updated.retry_count },
        'OutboxWorker: delivery permanently failed after max retries'
      );
    } else {
      log.warn(
        { err: (err as Error).message, outboxId: row.id, endpoint: row.endpoint, retryCount: updated?.retry_count },
        'OutboxWorker: delivery failed, will retry'
      );
    }
  }
}
