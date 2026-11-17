#!/usr/bin/env node
// One-off backfill: re-attribute existing `invoices` rows to the tenant of the
// SUBSCRIPTION that generated them.
//
// Historically, invoice events were attributed via the Stripe customer's
// most-recently-updated subscription. Because the Stripe customer is reused
// across delete+re-signup lives (each life gets a fresh tenant_id), rows landed
// under the wrong/sentinel tenant and became invisible to the real tenant's
// RLS-scoped /invoices query. This script drives from each subscription (whose
// tenant_id is stable for the account's life) → lists its Stripe invoices →
// corrects the DB row's tenant_id.
//
// MUST run as `billing_migrate` (table owner) — there is no FORCE ROW LEVEL
// SECURITY on `invoices`, so the owner bypasses RLS and can read sentinel-tenant
// rows and UPDATE them. (billing_app cannot — RLS would hide the bad rows.)
//
// Safe by default: DRY_RUN defaults to 'true' (report only). Set DRY_RUN=false
// to apply. Idempotent: a second run reports 0 diffs.
//
// Run locally via cloud-sql-proxy (dev shown; swap project/secret for prod):
//   STRIPE_API_KEY=$(gcloud secrets versions access latest \
//     --secret=stripe-secret-key --project=YOUR_CONTROL_PROJECT_STAGING) \
//   PGPASSWORD=$(gcloud secrets versions access latest \
//     --secret=billing-pg-migrate-password --project=YOUR_CONTROL_PROJECT_STAGING) \
//   PGUSER=billing_migrate PGDATABASE=billing PGHOST=127.0.0.1 PGPORT=5433 \
//   DRY_RUN=true \
//   npx tsx scripts/backfill-invoice-tenant-attribution.ts

import Stripe from 'stripe';
import { Pool } from 'pg';

async function main(): Promise<void> {
  const apiKey = process.env.STRIPE_API_KEY;
  if (!apiKey) throw new Error('STRIPE_API_KEY env var is required');
  const stripe = new Stripe(apiKey, { apiVersion: '2024-06-20' as Stripe.LatestApiVersion });

  const dryRun = (process.env.DRY_RUN ?? 'true').toLowerCase() !== 'false';
  console.log(dryRun ? '== DRY RUN (no writes) ==' : '== APPLY MODE (writing) ==');

  const pool = new Pool({
    host: process.env.PGHOST ?? '127.0.0.1',
    port: parseInt(process.env.PGPORT ?? '5432', 10),
    user: process.env.PGUSER ?? 'billing_migrate',
    database: process.env.PGDATABASE ?? 'billing',
    password: process.env.PGPASSWORD,
  });

  let scanned = 0;     // Stripe invoices examined
  let correct = 0;     // DB row already under the right tenant
  let diffs = 0;       // DB row under the wrong tenant
  let updated = 0;     // rows re-attributed (apply mode)
  let missing = 0;     // Stripe invoice with no DB row (NOT recovered here)
  let failed = 0;

  try {
    const { rows: subs } = await pool.query<{ stripe_subscription_id: string; tenant_id: string }>(
      `SELECT stripe_subscription_id, tenant_id FROM subscriptions`,
    );
    console.log(`Scanning invoices across ${subs.length} subscriptions…`);

    for (const sub of subs) {
      try {
        // Auto-paginates across all invoices for this subscription.
        for await (const inv of stripe.invoices.list({ subscription: sub.stripe_subscription_id, limit: 100 })) {
          scanned++;
          const { rows } = await pool.query<{ tenant_id: string }>(
            `SELECT tenant_id FROM invoices WHERE stripe_invoice_id = $1`,
            [inv.id],
          );
          if (rows.length === 0) {
            missing++;
            console.warn(`MISSING (no DB row, not recovered here): ${inv.id} sub=${sub.stripe_subscription_id}`);
            continue;
          }
          const current = rows[0].tenant_id;
          if (current === sub.tenant_id) {
            correct++;
            continue;
          }
          diffs++;
          console.log(`DIFF ${inv.id}: ${current} → ${sub.tenant_id} (sub=${sub.stripe_subscription_id})`);
          if (!dryRun) {
            await pool.query(
              `UPDATE invoices SET tenant_id = $2 WHERE stripe_invoice_id = $1`,
              [inv.id, sub.tenant_id],
            );
            updated++;
          }
        }
      } catch (err) {
        failed++;
        console.error(`Failed subscription ${sub.stripe_subscription_id}: ${(err as Error).message}`);
      }
    }

    console.log(
      `\nDone. scanned=${scanned} correct=${correct} diffs=${diffs} ` +
      `updated=${updated} missing=${missing} failed=${failed}` +
      (dryRun ? '  (DRY RUN — re-run with DRY_RUN=false to apply)' : ''),
    );
    if (missing > 0) {
      console.warn(
        `\n${missing} Stripe invoice(s) have no DB row at all (never ingested). ` +
        `Re-attribution cannot recover these; re-ingest separately if they must appear.`,
      );
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
