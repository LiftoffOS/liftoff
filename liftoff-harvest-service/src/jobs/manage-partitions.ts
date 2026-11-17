/**
 * Manages monthly partitions for harvest_cost_events.
 *
 * Behavior on each run:
 *   1. Ensure partitions exist for: this month + 3 months ahead.
 *   2. Drop monthly partitions older than RETENTION_DAYS (default 90).
 *
 * Run via: `npm run partitions`
 * Schedule: first day of each month (Cloud Scheduler → HTTP job, or pg_cron).
 *
 * Idempotent: every CREATE uses IF NOT EXISTS, every DROP uses IF EXISTS,
 * so re-running the script in the same window is safe.
 */
import 'dotenv/config';
import { Pool } from 'pg';
import { getPool, closePool } from '../infrastructure/database';
import { log } from '../infrastructure/logging';

const RETENTION_DAYS = parseInt(process.env.HARVEST_PARTITION_RETENTION_DAYS ?? '90', 10);
const MONTHS_AHEAD = 3;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function getMonthPartitionName(year: number, month: number): string {
  return `harvest_cost_events_y${year}m${pad2(month)}`;
}

export async function ensurePartition(pool: Pool, year: number, month: number): Promise<void> {
  const name = getMonthPartitionName(year, month);
  const from = `${year}-${pad2(month)}-01`;
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const to = `${nextYear}-${pad2(nextMonth)}-01`;

  // Identifier is constructed from numeric inputs, so it's safe to
  // interpolate directly. (pg parameter binding only works on values,
  // not identifiers.)
  const sql = `
    CREATE TABLE IF NOT EXISTS ${name}
      PARTITION OF harvest_cost_events
      FOR VALUES FROM ('${from}') TO ('${to}')
  `;
  await pool.query(sql);
  log.info({ partition: name, from, to }, 'ensured monthly partition');
}

export async function dropOldPartitions(pool: Pool, retentionDays: number): Promise<void> {
  // Find every partition table whose upper bound is older than the
  // retention cutoff. We use the pg_inherits / pg_partitioned_table
  // catalog so we don't have to parse the table name.
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  const { rows } = await pool.query<{ child: string; bound: string }>(`
    SELECT child::regclass::text AS child,
           pg_get_expr(c.relpartbound, c.oid) AS bound
      FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
     WHERE i.inhparent = 'harvest_cost_events'::regclass
  `);

  for (const row of rows) {
    // Skip the DEFAULT partition entirely.
    if (/DEFAULT/i.test(row.bound)) continue;
    // Bound text looks like: FOR VALUES FROM ('2025-01-01') TO ('2025-02-01')
    const match = /TO \('([^']+)'\)/.exec(row.bound);
    if (!match) continue;
    const upperBound = new Date(match[1]);
    if (upperBound < cutoff) {
      log.info({ partition: row.child, upperBound: match[1] }, 'dropping aged partition');
      await pool.query(`DROP TABLE IF EXISTS ${row.child}`);
    }
  }
}

export async function managePartitions(pool: Pool): Promise<void> {
  const now = new Date();
  const startYear = now.getUTCFullYear();
  const startMonth = now.getUTCMonth() + 1; // 1-12

  for (let i = 0; i <= MONTHS_AHEAD; i++) {
    let m = startMonth + i;
    let y = startYear;
    while (m > 12) {
      m -= 12;
      y += 1;
    }
    await ensurePartition(pool, y, m);
  }

  await dropOldPartitions(pool, RETENTION_DAYS);
}

async function main(): Promise<void> {
  const pool = getPool();
  try {
    await managePartitions(pool);
    log.info('partition management complete');
  } finally {
    await closePool();
  }
}

// Only run main() when executed directly (not when imported by tests).
if (require.main === module) {
  main().catch((err) => {
    log.error({ error: (err as Error).message }, 'partition management failed');
    process.exit(1);
  });
}
