#!/usr/bin/env npx ts-node
/**
 * Backfill script: Populate content_tsv for existing memories rows
 *
 * Migration 115 adds content_tsv + trigger for new rows, but existing rows
 * have NULL content_tsv. This script backfills them in batches of 1000 to
 * avoid long-running transactions and table lock contention.
 *
 * Skips pii/sensitive rows (trigger also skips them).
 *
 * Usage:
 *   npx ts-node scripts/backfill-memories-tsv.ts
 *
 * Environment variables required:
 *   - DATABASE_URL: Connection string for Tenant Runtime database
 */

import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

async function backfill(): Promise<void> {
  console.log('Starting memories content_tsv backfill...');

  let totalUpdated = 0;
  let batchNum = 0;

  while (true) {
    batchNum++;

    const result = await pool.query(`
      UPDATE memories
      SET content_tsv = to_tsvector('simple', COALESCE(content, ''))
      WHERE id IN (
        SELECT id FROM memories
        WHERE content_tsv IS NULL
          AND content_classification NOT IN ('pii', 'sensitive')
        LIMIT 1000
      )
    `);

    const updated = result.rowCount ?? 0;
    totalUpdated += updated;

    if (updated === 0) {
      console.log(`Batch ${batchNum}: 0 rows updated — backfill complete.`);
      break;
    }

    console.log(`Batch ${batchNum}: updated ${updated} rows (total: ${totalUpdated})`);
  }

  console.log(`\nBackfill finished. Total rows updated: ${totalUpdated}`);
}

async function main(): Promise<void> {
  try {
    await backfill();
  } catch (error) {
    console.error('Backfill failed:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
