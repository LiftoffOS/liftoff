/**
 * tools/migration/backfill.ts
 *
 * Backfills workforce_plans rows from the platform-backend DB (source) into
 * the workforce-service DB (target).
 *
 * Env vars:
 *   PG_SOURCE_URL   – full postgres connection URL to platform-backend DB
 *   PG_TARGET_URL   – full postgres connection URL to workforce-service DB
 *   BATCH_SIZE      – rows per batch (default 100)
 *   DRY_RUN         – if "true", log what would be inserted but don't write
 *
 * Usage:
 *   npx tsx tools/migration/backfill.ts
 */

import pg from 'pg';

const { Client } = pg;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PG_SOURCE_URL = process.env['PG_SOURCE_URL'];
const PG_TARGET_URL = process.env['PG_TARGET_URL'];
const BATCH_SIZE = parseInt(process.env['BATCH_SIZE'] ?? '100', 10);
const DRY_RUN = process.env['DRY_RUN'] === 'true';

if (!PG_SOURCE_URL) {
  console.error('ERROR: PG_SOURCE_URL is required');
  process.exit(1);
}
if (!PG_TARGET_URL) {
  console.error('ERROR: PG_TARGET_URL is required');
  process.exit(1);
}

// Columns to migrate — order matters for INSERT
const COLUMNS = [
  'id',
  'tenant_id',
  'account_id',
  'title',
  'status',
  'agents',
  'org_chart',
  'thread_id',
  'approved_by',
  'approved_at',
  'rejected_reason',
  'revision',
  'last_provisioned_specs',
  'removed_spec_ids',
  'instructions_md',
  'created_at',
  'updated_at',
  'deleted_at',
] as const;

type Column = (typeof COLUMNS)[number];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildInsertSQL(row: Record<string, unknown>): { sql: string; values: unknown[] } {
  // deleted_at may not exist in source — default to NULL
  const values: unknown[] = COLUMNS.map((col) => (col in row ? row[col] : null));
  const placeholders = COLUMNS.map((_, i) => `$${i + 1}`).join(', ');
  const cols = COLUMNS.join(', ');

  const sql = `
    INSERT INTO workforce_plans (${cols})
    VALUES (${placeholders})
    ON CONFLICT (id) DO NOTHING
  `;

  return { sql, values };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const source = new Client({ connectionString: PG_SOURCE_URL });
  const target = new Client({ connectionString: PG_TARGET_URL });

  console.log(`[backfill] DRY_RUN=${DRY_RUN}  BATCH_SIZE=${BATCH_SIZE}`);
  console.log('[backfill] Connecting to source and target databases…');

  await source.connect();
  await target.connect();

  try {
    // Determine source schema — check whether deleted_at exists
    const schemaRes = await source.query<{ column_name: string }>(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'workforce_plans'
        AND column_name = 'deleted_at'
    `);
    const sourceHasDeletedAt = schemaRes.rows.length > 0;
    console.log(`[backfill] Source has deleted_at column: ${sourceHasDeletedAt}`);

    // Total count
    const countRes = await source.query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM workforce_plans',
    );
    const total = parseInt(countRes.rows[0]!.count, 10);
    console.log(`[backfill] Total rows in source: ${total}`);

    if (total === 0) {
      console.log('[backfill] Nothing to migrate. Exiting.');
      return;
    }

    // Cursor-paginate through source
    let cursor = ''; // empty string sorts before all UUIDs
    let fetched = 0;
    let inserted = 0;
    let skipped = 0;

    // Build the SELECT column list — use NULL for deleted_at if absent in source
    const selectCols = COLUMNS.map((col) => {
      if (col === 'deleted_at' && !sourceHasDeletedAt) {
        return 'NULL::timestamptz AS deleted_at';
      }
      return col;
    }).join(', ');

    while (fetched < total) {
      const batchRes = await source.query<Record<Column, unknown>>(
        `SELECT ${selectCols}
         FROM workforce_plans
         WHERE id > $1
         ORDER BY id
         LIMIT $2`,
        [cursor, BATCH_SIZE],
      );

      if (batchRes.rows.length === 0) {
        break;
      }

      fetched += batchRes.rows.length;
      cursor = String(batchRes.rows[batchRes.rows.length - 1]!['id']);

      if (DRY_RUN) {
        console.log(
          `[backfill] DRY_RUN [${fetched}/${total}] would insert ${batchRes.rows.length} rows ` +
            `(first id: ${String(batchRes.rows[0]!['id'])})`,
        );
        inserted += batchRes.rows.length;
        continue;
      }

      // Insert each row individually so we can count conflicts
      let batchInserted = 0;
      let batchSkipped = 0;

      for (const row of batchRes.rows) {
        const { sql, values } = buildInsertSQL(row as Record<string, unknown>);
        const result = await target.query(sql, values);
        if (result.rowCount && result.rowCount > 0) {
          batchInserted++;
        } else {
          batchSkipped++;
        }
      }

      inserted += batchInserted;
      skipped += batchSkipped;

      console.log(
        `[backfill] [${fetched}/${total}] batch done — inserted: ${batchInserted}, skipped (conflict): ${batchSkipped}`,
      );
    }

    console.log('');
    console.log('[backfill] ===== Migration complete =====');
    console.log(`[backfill]   Total rows fetched : ${fetched}`);
    console.log(`[backfill]   Rows inserted      : ${inserted}`);
    console.log(`[backfill]   Rows skipped       : ${skipped}`);
    if (DRY_RUN) {
      console.log('[backfill]   (DRY_RUN — no writes performed)');
    }
  } finally {
    await source.end();
    await target.end();
  }
}

main().then(() => process.exit(0)).catch((err: unknown) => {
  console.error('[backfill] FATAL:', err);
  process.exit(1);
});
