// Push subscription repository.
//
// withAdminScope throughout, matching notifications/repository.ts:
// push_subscriptions is account-scoped and carries no RLS, and the send path
// runs from a digest tick or a callback with no tenant in context.
//
// A device is addressed by its Firebase Installation ID (`fid`), and only that.
// The legacy `fcm_token` column and the dual send path that carried it through
// the migration were removed once the last device had re-registered.

import { withAdminScope } from '../infrastructure/database';
import type { PushSubscriptionRow } from './types';

interface RawRow {
  id: string;
  accountId: string;
  fid: string;
  origin: string;
  userAgent: string | null;
  createdAt: Date;
  lastSeenAt: Date;
  revokedAt: Date | null;
}

const COLUMNS = `id, account_id AS "accountId", fid,
                 origin, user_agent AS "userAgent", created_at AS "createdAt",
                 last_seen_at AS "lastSeenAt", revoked_at AS "revokedAt"`;

/**
 * Register a device by its Firebase Installation ID, or re-register one that
 * already exists.
 *
 * account_id is REASSIGNED on conflict rather than left alone. That is the
 * shared-browser case: FCM hands the same installation to whoever is signed in,
 * so an unchanged account_id would keep delivering the new occupant's
 * notifications to the previous one.
 *
 * revoked_at is cleared, because arriving here means the browser holds a live
 * subscription again regardless of why it was retired before.
 *
 * The conflict target repeats `WHERE fid IS NOT NULL`: push_subscriptions_fid_key
 * is a PARTIAL unique index, and Postgres only infers a partial index when the
 * statement restates its predicate. It stays partial until the column is made
 * NOT NULL.
 */
export async function upsertSubscriptionByFid(input: {
  accountId: string;
  fid: string;
  origin: string;
  userAgent: string | null;
}): Promise<PushSubscriptionRow> {
  return withAdminScope(
    { caller: 'push.repository.upsertSubscriptionByFid', reason: 'register a browser for push' },
    async (c) => {
      const r = await c.query<RawRow>(
        `INSERT INTO push_subscriptions (account_id, fid, origin, user_agent)
              VALUES ($1, $2, $3, $4)
         ON CONFLICT (fid) WHERE fid IS NOT NULL DO UPDATE
                SET account_id   = EXCLUDED.account_id,
                    origin       = EXCLUDED.origin,
                    user_agent   = EXCLUDED.user_agent,
                    last_seen_at = NOW(),
                    revoked_at   = NULL
          RETURNING ${COLUMNS}`,
        [input.accountId, input.fid, input.origin, input.userAgent],
      );
      return r.rows[0];
    },
  );
}

/**
 * Live devices for one account on one origin.
 *
 * Filtering by origin is not an optimisation. Environments can share a
 * Firebase project, so without it a dev send could reach a device that
 * registered against production.
 */
export async function listLiveDevices(
  accountId: string,
  origin: string,
): Promise<PushSubscriptionRow[]> {
  return withAdminScope(
    { caller: 'push.repository.listLiveDevices', reason: 'resolve push targets for an account' },
    async (c) => {
      const r = await c.query<RawRow>(
        `SELECT ${COLUMNS}
           FROM push_subscriptions
          WHERE account_id = $1 AND origin = $2 AND revoked_at IS NULL`,
        [accountId, origin],
      );
      return r.rows;
    },
  );
}

/**
 * Retire rows by primary key.
 *
 * Keyed by id rather than by identifier string because a row can now be
 * addressed two ways: the send path partitions rows into an FID batch and a
 * legacy-token batch, and after FCM answers it has a row in hand, not a
 * knowledge of which column it was targeted through. No-op on an empty list so
 * callers do not have to guard.
 */
export async function revokeSubscriptions(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  return withAdminScope(
    { caller: 'push.repository.revokeSubscriptions', reason: 'retire dead or unsubscribed push devices' },
    async (c) => {
      const r = await c.query(
        `UPDATE push_subscriptions
            SET revoked_at = NOW()
          WHERE id = ANY($1::uuid[]) AND revoked_at IS NULL`,
        [ids],
      );
      return r.rowCount ?? 0;
    },
  );
}

/**
 * Retire one device, but only if it belongs to the calling account. Stops an
 * unsubscribe call from retiring somebody else's device by guessing an FID.
 */
export async function revokeDeviceForAccount(
  accountId: string,
  fid: string,
): Promise<number> {
  return withAdminScope(
    { caller: 'push.repository.revokeDeviceForAccount', reason: 'user unsubscribed a browser' },
    async (c) => {
      const r = await c.query(
        `UPDATE push_subscriptions
            SET revoked_at = NOW()
          WHERE account_id = $1 AND fid = $2 AND revoked_at IS NULL`,
        [accountId, fid],
      );
      return r.rowCount ?? 0;
    },
  );
}
