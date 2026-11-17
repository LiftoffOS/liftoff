// One-time script: provision Stripe subscriptions for all active tenants that don't have one.
//
// Run after both liftoff-billing and liftoff-platform-backend are deployed with the
// billing-init-gaps changes. The Phase 2 migration (stripe_metered_at column) must be
// live before running this — the /init webhook path triggers the historical OU backfill.
//
// Usage:
//   DATABASE_URL=<db-url> \
//   BILLING_SERVICE_URL=<billing-url> \
//   BILLING_SERVICE_TOKEN=<token> \
//   npx ts-node src/scripts/backfill-tenant-subscriptions.ts

import { Pool } from 'pg';
import { BillingAdminClient } from '../billing/billing-admin-client';

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  const { rows } = await pool.query<{ tenant_id: string; stripe_customer_id: string }>(`
    SELECT t.id AS tenant_id, a.stripe_customer_id
    FROM tenants t
    JOIN accounts a ON a.id = t.account_id
    LEFT JOIN billing_controls bc ON bc.account_id = a.id
    WHERE t.status = 'active'
      AND (bc.stripe_customer_id IS NULL OR bc.account_id IS NULL)
      AND a.stripe_customer_id IS NOT NULL
  `);

  console.log(`Found ${rows.length} active tenants without billing subscriptions`);

  const client = new BillingAdminClient(
    process.env.BILLING_SERVICE_URL ?? '',
    process.env.BILLING_SERVICE_TOKEN ?? '',
  );

  let succeeded = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      await client.provisionSubscription(row.tenant_id, row.stripe_customer_id);
      console.log(`[OK] ${row.tenant_id}`);
      succeeded++;
    } catch (err) {
      console.error(`[FAIL] ${row.tenant_id}:`, (err as Error).message);
      failed++;
    }
    await new Promise(r => setTimeout(r, 100)); // 10 req/s — well under Stripe rate limit
  }

  console.log(`\nDone: ${succeeded} provisioned, ${failed} failed`);

  // Check for accounts with remaining unmetered OUs (truncated by 500-event cap).
  // RLS/FORCE: billing_spend_events is RLS-enabled and this cross-tenant scan has
  // no tenant context. This standalone one-time script manages its own pg Pool
  // from DATABASE_URL, so it must be run with a BYPASSRLS role (e.g. liftoff_admin)
  // in DATABASE_URL once FORCE ROW LEVEL SECURITY is enabled.
  // RLS_RAW_POOL_OK: standalone one-time script, own pg Pool from DATABASE_URL,
  // documented above to be run as a BYPASSRLS role. Not part of the service.
  const { rows: truncated } = await pool.query<{ account_id: string; unmetered_count: string }>(`
    SELECT account_id, COUNT(*) AS unmetered_count
    FROM billing_spend_events
    WHERE stripe_metered_at IS NULL
    GROUP BY account_id
    HAVING COUNT(*) > 0
  `);

  if (truncated.length > 0) {
    console.error(`\nWARNING: ${truncated.length} account(s) still have unmetered spend events (backfill capped at 500):`);
    for (const r of truncated) {
      console.error(`  account ${r.account_id}: ${r.unmetered_count} events`);
    }
    console.error('Run a follow-up backfill for these accounts without the LIMIT cap.');
  } else {
    console.log('\nAll spend events are metered.');
  }

  await pool.end();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
