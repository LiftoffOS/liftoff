// One-off cleanup: hard-delete a list of test account IDs (Stripe + Firebase
// + DB) and optionally delete a Stripe coupon.
//
// Why this script bypasses AccountService.cascadeDelete: that method
// enqueues a `tenant.deleted` outbox row AFTER deleting the tenants row,
// which violates the `control_plane_outbox.tenant_id` FK. For these
// throwaway test accounts we don't need the downstream tenant-runtime
// cleanup event, so we drop the outbox enqueue and delete in topological
// order: Stripe customer → Firebase user → SQL DELETE in dependency order.
//
// Takes account IDs as positional CLI args. Optional --delete-coupon=<id>.
//
// Required env: same set as provision-test-account.ts (DB_*, Stripe,
// Firebase project id).

import { initDatabase, closePools, getPool, withAdminScope } from '../infrastructure/database';
import { initFirebase } from '../infrastructure/firebase';
import { log } from '../infrastructure/logging';
import { getStripeSecretKey } from '../infrastructure/secrets';
import { getAuth } from 'firebase-admin/auth';
import Stripe from 'stripe';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env: ${name}`);
  return v;
}

interface AccountInfo {
  accountId: string;
  firebaseUid: string | null;
  stripeCustomerId: string | null;
  tenantIds: string[];
}

async function fetchInfo(accountId: string): Promise<AccountInfo | null> {
  const pool = getPool();
  const acct = await pool.query<{ firebase_uid: string | null; stripe_customer_id: string | null }>(
    `SELECT firebase_uid, stripe_customer_id FROM accounts WHERE id = $1`,
    [accountId],
  );
  if (acct.rows.length === 0) return null;
  const tenants = await pool.query<{ id: string }>(
    `SELECT id FROM tenants WHERE account_id = $1`,
    [accountId],
  );
  return {
    accountId,
    firebaseUid: acct.rows[0].firebase_uid,
    stripeCustomerId: acct.rows[0].stripe_customer_id,
    tenantIds: tenants.rows.map((r) => r.id),
  };
}

async function deleteStripeCustomer(stripe: Stripe, customerId: string): Promise<void> {
  try {
    await stripe.customers.del(customerId);
  } catch (err) {
    const e = err as Stripe.errors.StripeError;
    if (e.code === 'resource_missing') return;
    throw err;
  }
}

async function deleteFirebaseUser(uid: string): Promise<void> {
  try {
    await getAuth().deleteUser(uid);
  } catch (err) {
    const e = err as { code?: string };
    if (e.code === 'auth/user-not-found') return;
    throw err;
  }
}

// Topological delete: child tables → parent tables. Skips the outbox event
// enqueue that cascadeDelete attempts (and which causes the FK violation).
async function deleteFromDb(info: AccountInfo): Promise<void> {
  const pool = getPool();
  // control_plane_outbox FKs to tenants — clear any pending rows for these
  // tenants first so the tenant DELETE doesn't trip the constraint.
  if (info.tenantIds.length > 0) {
    await pool.query(
      `DELETE FROM control_plane_outbox WHERE tenant_id = ANY($1::uuid[])`,
      [info.tenantIds],
    );
  }
  // entity outbox keyed on account also.
  await pool.query(
    `DELETE FROM control_plane_outbox WHERE entity_id = $1`,
    [info.accountId],
  );
  // Per-tenant child rows. subscriptions is keyed on account_id (not tenant_id);
  // everything else is per-tenant.
  if (info.tenantIds.length > 0) {
    await withAdminScope({ caller: 'cleanup-test-accounts', reason: 'cross-tenant delete of test-account entitlements + tenant_members' }, (client) => client.query(`DELETE FROM entitlements WHERE tenant_id = ANY($1::uuid[])`, [info.tenantIds]));
    await withAdminScope({ caller: 'cleanup-test-accounts', reason: 'cross-tenant delete of test-account entitlements + tenant_members' }, (client) => client.query(`DELETE FROM tenant_members WHERE tenant_id = ANY($1::uuid[])`, [info.tenantIds]));
    await pool.query(`DELETE FROM tenants WHERE id = ANY($1::uuid[])`, [info.tenantIds]);
  }
  await pool.query(`DELETE FROM subscriptions WHERE account_id = $1`, [info.accountId]);
  await pool.query(`DELETE FROM billing_controls WHERE account_id = $1`, [info.accountId]);
  await pool.query(`DELETE FROM accounts WHERE id = $1`, [info.accountId]);
}

async function main(): Promise<number> {
  if (!process.env.DB_HOST && !process.env.CLOUD_SQL_CONNECTION_NAME) {
    throw new Error('missing required env: DB_HOST or CLOUD_SQL_CONNECTION_NAME');
  }
  for (const n of ['DB_USER', 'DB_NAME', 'DB_PASSWORD', 'STRIPE_SECRET_KEY', 'FIREBASE_PROJECT_ID']) {
    requireEnv(n);
  }

  const accountIds: string[] = [];
  let couponToDelete: string | null = null;
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--delete-coupon=')) couponToDelete = arg.slice('--delete-coupon='.length);
    else accountIds.push(arg);
  }
  if (accountIds.length === 0) throw new Error('no accountIds given');

  await initDatabase();
  await initFirebase();
  const stripe = new Stripe(await getStripeSecretKey());

  const results: Array<{ accountId: string; ok: boolean; err?: string; steps?: Record<string, string> }> = [];
  for (const accountId of accountIds) {
    const steps: Record<string, string> = {};
    try {
      const info = await fetchInfo(accountId);
      if (!info) {
        steps.lookup = 'not_found';
        results.push({ accountId, ok: true, steps });
        log.info({ accountId }, 'cleanup: account not found, skipping');
        continue;
      }
      if (info.stripeCustomerId) {
        await deleteStripeCustomer(stripe, info.stripeCustomerId);
        steps.stripe = 'deleted';
      }
      if (info.firebaseUid) {
        await deleteFirebaseUser(info.firebaseUid);
        steps.firebase = 'deleted';
      }
      await deleteFromDb(info);
      steps.db = 'deleted';
      results.push({ accountId, ok: true, steps });
      log.info({ accountId, steps }, 'cleanup ok');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ accountId, ok: false, err: msg, steps });
      log.error({ accountId, err: msg, steps }, 'cleanup failed');
    }
  }

  if (couponToDelete) {
    try {
      await stripe.coupons.del(couponToDelete);
      log.info({ couponId: couponToDelete }, 'coupon deleted');
    } catch (err) {
      const e = err as Stripe.errors.StripeError;
      if (e.code === 'resource_missing') {
        log.info({ couponId: couponToDelete }, 'coupon already gone');
      } else {
        log.error({ couponId: couponToDelete, err: e.message }, 'coupon delete failed');
      }
    }
  }

  console.log(JSON.stringify({ results, couponDeleted: couponToDelete }));
  return results.every((r) => r.ok) ? 0 : 1;
}

main()
  .then(async (code) => {
    await closePools();
    process.exit(code);
  })
  .catch(async (err) => {
    log.error({ err: err instanceof Error ? err.message : String(err) }, 'cleanup failed');
    await closePools().catch(() => undefined);
    process.exit(1);
  });
