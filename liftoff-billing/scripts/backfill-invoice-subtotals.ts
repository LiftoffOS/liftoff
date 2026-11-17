#!/usr/bin/env node
// Backfill subtotal_cents + discount_cents on existing invoices rows from
// Stripe. Migration 021 added these columns with default 0; rows ingested
// before the matching code change (which now passes Stripe's `subtotal` and
// summed `total_discount_amounts[].amount` into upsert_invoice_record) need a
// one-shot re-fetch so the /invoices filter can distinguish real
// $20-→-$0-via-promo billing events from phantom $0/$0/$0 stubs.
//
// Idempotent: re-running over rows that already have non-default values is a
// no-op except where Stripe has since updated the invoice (e.g. status went
// open → paid). Safe to re-run.
//
// Run locally via cloud-sql-proxy:
//   STRIPE_API_KEY=$(gcloud secrets versions access latest \
//     --secret=stripe-api-key-prod --project=YOUR_CONTROL_PROJECT) \
//   PGPASSWORD=$(gcloud secrets versions access latest \
//     --secret=billing-pg-password --project=YOUR_CONTROL_PROJECT) \
//   PGUSER=billing PGDATABASE=billing PGHOST=127.0.0.1 PGPORT=5433 \
//   npx tsx scripts/backfill-invoice-subtotals.ts

import Stripe from 'stripe';
import { Pool } from 'pg';

async function main(): Promise<void> {
  const apiKey = process.env.STRIPE_API_KEY;
  if (!apiKey) throw new Error('STRIPE_API_KEY env var is required');
  const stripe = new Stripe(apiKey, { apiVersion: '2024-06-20' as Stripe.LatestApiVersion });

  const pool = new Pool({
    host: process.env.PGHOST ?? '127.0.0.1',
    port: parseInt(process.env.PGPORT ?? '5432', 10),
    user: process.env.PGUSER ?? 'billing',
    database: process.env.PGDATABASE ?? 'billing',
    password: process.env.PGPASSWORD,
  });

  try {
    // Two backfill targets per row:
    //   * subtotal_cents / discount_cents — added by migration 021 with
    //     default 0. Pre-migration rows lack the data; the upsert was just
    //     extended to capture it for new events.
    //   * type — pre-fix rows landed with type='unknown' because
    //     classifyInvoice only handled billing_reason='subscription_cycle'.
    //     subscription_create + subscription_update were silently dropped to
    //     'unknown' and hidden from /invoices entirely.
    //
    // Select rows that are missing EITHER signal so a single pass cleans up
    // both. Capped at 1000 per run as a fan-out guardrail.
    const { rows } = await pool.query<{
      id: string;
      stripe_invoice_id: string;
      type: string;
      subtotal_cents: string;
      discount_cents: string;
    }>(
      `SELECT id, stripe_invoice_id, type::text, subtotal_cents::text, discount_cents::text
         FROM invoices
        WHERE (subtotal_cents = 0 AND discount_cents = 0)
           OR type = 'unknown'
        ORDER BY issued_at DESC
        LIMIT 1000`,
    );

    console.log(`Found ${rows.length} candidate rows to backfill.`);
    let updated = 0;
    let skipped = 0;
    let failed = 0;

    for (const row of rows) {
      try {
        const inv = await stripe.invoices.retrieve(row.stripe_invoice_id);
        const subtotalCents = inv.subtotal ?? 0;
        const discountCents = (inv.total_discount_amounts ?? []).reduce(
          (sum, d) => sum + (d.amount ?? 0),
          0,
        );
        // Re-classify type. Mirror classifyInvoice() in
        // src/consumers/stripe-event-processor.ts: metadata.type wins, then
        // billing_reason buckets all three subscription_* reasons into
        // subscription_cycle.
        const metaType = inv.metadata?.type;
        let newType: string;
        if (metaType === 'prepaid_reload' || metaType === 'threshold' || metaType === 'recovery') {
          newType = metaType;
        } else if (
          inv.billing_reason === 'subscription_cycle' ||
          inv.billing_reason === 'subscription_create' ||
          inv.billing_reason === 'subscription_update'
        ) {
          newType = 'subscription_cycle';
        } else {
          newType = 'unknown';
        }

        // Skip if nothing would change (idempotent re-run).
        if (
          BigInt(row.subtotal_cents) === BigInt(subtotalCents) &&
          BigInt(row.discount_cents) === BigInt(discountCents) &&
          row.type === newType
        ) {
          skipped++;
          continue;
        }

        await pool.query(
          `UPDATE invoices
              SET subtotal_cents = $2, discount_cents = $3, type = $4::invoice_type
            WHERE id = $1`,
          [row.id, subtotalCents, discountCents, newType],
        );
        updated++;
        console.log(
          `Updated ${row.stripe_invoice_id}: type=${row.type}→${newType} ` +
          `subtotal=${row.subtotal_cents}→${subtotalCents} discount=${row.discount_cents}→${discountCents}`,
        );
      } catch (err) {
        failed++;
        console.error(`Failed ${row.stripe_invoice_id}: ${(err as Error).message}`);
      }
    }

    console.log(`\nDone. updated=${updated} skipped=${skipped} failed=${failed}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
