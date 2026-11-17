// One-time script: clean up orphaned Stripe signup customers for tenants who completed
// Stripe Checkout before the customer-deduplication fix was deployed.
//
// For affected accounts: accounts.stripe_customer_id points to the orphaned signup customer,
// while billing_controls.stripe_customer_id points to the active checkout customer.
// This script:
//   1. Updates accounts.stripe_customer_id to match billing_controls.stripe_customer_id
//   2. Deletes the orphaned signup customer from Stripe
//
// After this runs, AccountService profile-sync calls (name/email updates) will correctly
// update the active billing customer rather than the orphaned one.
//
// Run after backfill-tenant-subscriptions.ts completes. Always run dev first, verify, then prod.
//
// Usage:
//   DATABASE_URL=<db-url> \
//   STRIPE_API_KEY=<stripe-key> \
//   npx ts-node src/scripts/cleanup-orphaned-stripe-customers.ts

import { Pool } from 'pg';
import Stripe from 'stripe';

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const stripe = new Stripe(process.env.STRIPE_API_KEY ?? '', {
    apiVersion: '2024-06-20' as Stripe.LatestApiVersion,
  });

  const { rows } = await pool.query<{
    account_id: string;
    signup_customer_id: string;
    billing_customer_id: string;
  }>(`
    SELECT a.id AS account_id,
           a.stripe_customer_id AS signup_customer_id,
           bc.stripe_customer_id AS billing_customer_id
    FROM accounts a
    JOIN billing_controls bc ON bc.account_id = a.id
    WHERE a.stripe_customer_id IS NOT NULL
      AND bc.stripe_customer_id IS NOT NULL
      AND a.stripe_customer_id != bc.stripe_customer_id
  `);

  console.log(`Found ${rows.length} accounts with orphaned signup customers`);

  let cleaned = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      // Safety check: fetch subscriptions and invoices in parallel
      const [subscriptions, invoices] = await Promise.all([
        stripe.subscriptions.list({ customer: row.signup_customer_id, limit: 1 }),
        stripe.invoices.list({ customer: row.signup_customer_id, limit: 1 }),
      ]);

      if (subscriptions.data.length > 0) {
        console.error(`[SKIP] account ${row.account_id}: signup customer ${row.signup_customer_id} has subscriptions — manual review required`);
        skipped++;
        continue;
      }

      // Invoices are informational only — we proceed even if present
      if (invoices.data.length > 0) {
        console.warn(`[WARN] account ${row.account_id}: signup customer has ${invoices.data.length}+ invoice(s) — proceeding with deletion`);
      }

      // Update accounts.stripe_customer_id to point to the active billing customer
      await pool.query(
        `UPDATE accounts SET stripe_customer_id = $1 WHERE id = $2`,
        [row.billing_customer_id, row.account_id],
      );

      // Delete the orphaned signup customer from Stripe
      await stripe.customers.del(row.signup_customer_id);

      console.log(`[OK] account ${row.account_id}: deleted ${row.signup_customer_id}, accounts now points to ${row.billing_customer_id}`);
      cleaned++;
    } catch (err) {
      console.error(`[FAIL] account ${row.account_id}:`, (err as Error).message);
      failed++;
    }

    await new Promise(r => setTimeout(r, 200)); // 5 req/s
  }

  console.log(`\nDone: ${cleaned} cleaned, ${skipped} skipped (manual review needed), ${failed} failed`);

  // Final verification
  const { rows: remaining } = await pool.query<{ count: string }>(`
    SELECT COUNT(*) AS count
    FROM accounts a
    JOIN billing_controls bc ON bc.account_id = a.id
    WHERE a.stripe_customer_id IS NOT NULL
      AND bc.stripe_customer_id IS NOT NULL
      AND a.stripe_customer_id != bc.stripe_customer_id
  `);
  console.log(`Remaining mismatched accounts: ${remaining[0]?.count ?? 0}`);

  await pool.end();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
