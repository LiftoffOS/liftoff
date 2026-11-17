// Polling sync state store.
// Reads/writes the connector_sync_state table to track per-connector
// incremental polling cursors.

import { getPool } from '../db/pool.js';

export interface SyncState {
  lastSyncAt: Date;
  nextSyncAt?: Date;
  lastPageToken?: string;
  /** Durable cross-cycle resume token (Ashby syncToken, Instantly cursor tail,
   *  etc.) for connectors with no server `since` + no newest-first sort. Unlike
   *  lastPageToken (within-cycle only), this persists so the poller resumes
   *  FORWARD instead of re-scanning from the oldest record every cycle (which
   *  would truncate at MAX_PAGES and silently drop new records at scale). */
  lastSyncCursor?: string;
}

export interface DueConnector {
  connectorId: string;
  tenantId: string;
  connectorType: string;
}

export async function getSyncState(connectorId: string, entityType: string): Promise<SyncState | null> {
  const pool = await getPool();
  const result = await pool.query<{ last_sync_at: Date; next_sync_at: Date | null; last_page_token: string | null; last_sync_cursor: string | null }>(
    `SELECT last_sync_at, next_sync_at, last_page_token, last_sync_cursor
     FROM connector_sync_state
     WHERE connector_id = $1 AND entity_type = $2`,
    [connectorId, entityType],
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    lastSyncAt: row.last_sync_at,
    nextSyncAt: row.next_sync_at ?? undefined,
    lastPageToken: row.last_page_token ?? undefined,
    lastSyncCursor: row.last_sync_cursor ?? undefined,
  };
}

// Base scheduler cycle; the default gap between polls when an entity sets no
// longer interval. Keep in sync with scheduler.ts POLL_INTERVAL_MS.
const DEFAULT_POLL_INTERVAL_MS = 60_000;

export async function upsertSyncState(
  connectorId: string,
  entityType: string,
  lastSyncAt: Date,
  lastPageToken?: string,
  intervalMs: number = DEFAULT_POLL_INTERVAL_MS,
  lastSyncCursor?: string,
): Promise<void> {
  const pool = await getPool();
  const nextSyncAt = new Date(lastSyncAt.getTime() + intervalMs);
  await pool.query(
    `INSERT INTO connector_sync_state
       (connector_id, entity_type, last_sync_at, next_sync_at, last_page_token, last_sync_cursor)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (connector_id, entity_type) DO UPDATE
       SET last_sync_at     = EXCLUDED.last_sync_at,
           next_sync_at      = EXCLUDED.next_sync_at,
           last_page_token   = EXCLUDED.last_page_token,
           last_sync_cursor  = EXCLUDED.last_sync_cursor`,
    [connectorId, entityType, lastSyncAt, nextSyncAt, lastPageToken ?? null, lastSyncCursor ?? null],
  );
}

/** Record a credential-shaped poll failure and return the new consecutive
 *  count, so the caller can decide whether the run is long enough to act on.
 *
 *  Returns the post-increment value from the UPDATE itself rather than reading
 *  it back: two entity types failing in the same cycle would otherwise race and
 *  both observe the pre-increment count. */
export async function recordPollAuthFailure(
  connectorId: string,
  errorMessage: string,
): Promise<number> {
  const pool = await getPool();
  const result = await pool.query<{ consecutive_poll_auth_failures: number }>(
    `UPDATE connectors
        SET consecutive_poll_auth_failures = consecutive_poll_auth_failures + 1,
            last_poll_error = $2,
            last_poll_error_at = now()
      WHERE id = $1
      RETURNING consecutive_poll_auth_failures`,
    [connectorId, errorMessage.slice(0, 500)],
  );
  return result.rows[0]?.consecutive_poll_auth_failures ?? 0;
}

/** Record a non-credential failure for triage without touching the counter —
 *  a 500 or a timeout says nothing about the credential and must not march a
 *  connector toward `error`. */
export async function recordPollError(connectorId: string, errorMessage: string): Promise<void> {
  const pool = await getPool();
  await pool.query(
    `UPDATE connectors
        SET last_poll_error = $2, last_poll_error_at = now()
      WHERE id = $1`,
    [connectorId, errorMessage.slice(0, 500)],
  );
}

/** Clear the failure run after a poll succeeds.
 *
 *  Guarded on a non-zero counter so the overwhelming majority of cycles — the
 *  healthy ones — issue no write at all. */
export async function clearPollFailures(connectorId: string): Promise<void> {
  const pool = await getPool();
  await pool.query(
    `UPDATE connectors
        SET consecutive_poll_auth_failures = 0, last_poll_error = NULL, last_poll_error_at = NULL
      WHERE id = $1 AND consecutive_poll_auth_failures <> 0`,
    [connectorId],
  );
}

export async function getDueConnectors(pollableTypes: string[]): Promise<DueConnector[]> {
  if (pollableTypes.length === 0) return [];
  const pool = await getPool();
  const result = await pool.query<DueConnector>(
    `SELECT c.id        AS "connectorId",
            c.tenant_id AS "tenantId",
            c.type      AS "connectorType"
     FROM connectors c
     WHERE c.status = 'active'
       AND c.type = ANY($1::text[])`,
    [pollableTypes],
  );
  return result.rows;
}
