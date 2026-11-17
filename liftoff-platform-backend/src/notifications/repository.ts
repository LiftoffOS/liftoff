// Notification repository — read/write the notifications + dedupe tables.
//
// Uses withAdminScope so digest aggregation and queue maintenance can read/write
// across tenants without RLS getting in the way. The /api/notifications/me
// endpoint scopes by account_id in its own query (router-level).

import { withAdminScope } from '../infrastructure/database';
import type { NotificationRow, NotificationType, NotificationCadence } from './types';

interface RawRow {
  id: string;
  accountId: string;
  tenantId: string | null;
  type: NotificationType;
  payload: Record<string, unknown>;
  cadence: NotificationCadence;
  createdAt: Date;
  deliveredAt: Date | null;
  deliveryError: string | null;
}

export async function insertNotification(input: {
  accountId: string;
  tenantId: string | null;
  type: NotificationType;
  payload: Record<string, unknown>;
  cadence: Exclude<NotificationCadence, 'none'>;
}): Promise<NotificationRow> {
  return withAdminScope(
    { caller: 'notifications.repository.insertNotification', reason: 'enqueue notification' },
    async (c) => {
      const r = await c.query<RawRow>(
        `INSERT INTO notifications (account_id, tenant_id, type, payload, cadence)
         VALUES ($1, $2, $3, $4::jsonb, $5)
         RETURNING id, account_id AS "accountId", tenant_id AS "tenantId",
                   type, payload, cadence, created_at AS "createdAt",
                   delivered_at AS "deliveredAt", delivery_error AS "deliveryError"`,
        [input.accountId, input.tenantId, input.type, JSON.stringify(input.payload), input.cadence],
      );
      return r.rows[0];
    },
  );
}

export async function fetchPendingForAccount(
  accountId: string,
  cadence: 'daily' | 'weekly',
): Promise<NotificationRow[]> {
  return withAdminScope(
    { caller: 'notifications.repository.fetchPendingForAccount', reason: 'digest aggregation' },
    async (c) => {
      const r = await c.query<RawRow>(
        `SELECT id, account_id AS "accountId", tenant_id AS "tenantId",
                type, payload, cadence, created_at AS "createdAt",
                delivered_at AS "deliveredAt", delivery_error AS "deliveryError"
           FROM notifications
          WHERE account_id = $1 AND cadence = $2 AND delivered_at IS NULL
          ORDER BY created_at`,
        [accountId, cadence],
      );
      return r.rows;
    },
  );
}

export async function markDelivered(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await withAdminScope(
    { caller: 'notifications.repository.markDelivered', reason: 'digest sent' },
    (c) => c.query(`UPDATE notifications SET delivered_at = NOW() WHERE id = ANY($1::uuid[])`, [ids]),
  );
}

export async function markFailed(id: string, error: string): Promise<void> {
  await withAdminScope(
    { caller: 'notifications.repository.markFailed', reason: 'realtime send failed' },
    (c) => c.query(`UPDATE notifications SET delivery_error = $2 WHERE id = $1`, [id, error]),
  );
}

// Returns true if this account has not yet been sent a perf recap for the given week.
export async function tryReservePerfRecap(accountId: string, weekStart: Date): Promise<boolean> {
  return withAdminScope(
    { caller: 'notifications.repository.tryReservePerfRecap', reason: 'dedupe Tuesday recap' },
    async (c) => {
      const r = await c.query(
        `INSERT INTO notification_perf_recaps_sent (account_id, week_start)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING
         RETURNING account_id`,
        [accountId, weekStart],
      );
      return (r.rowCount ?? 0) > 0;
    },
  );
}
