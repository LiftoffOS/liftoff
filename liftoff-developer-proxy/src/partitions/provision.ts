// Monthly partition provisioning for developer_proxy_usage_log.
//
// Every partition on this table was written by hand into a migration and
// nothing created the next one; the hand-written list ends 2028-01-01. This
// keeps `monthsAhead` months in front of today, so the runway never runs down.
//
// Run from the `developer-proxy-partitions-${env}` Cloud Run Job on a daily
// schedule. Daily rather than monthly on purpose: a monthly job that fails
// silently leaves no second chance before the boundary arrives.

import type { Pool, PoolClient } from 'pg';
import { getPool } from '../infrastructure/database.js';

const PARENT_TABLE = 'developer_proxy_usage_log';
const DEFAULT_MONTHS_AHEAD = 18;

export interface ProvisionResult {
  created: string[];
  existing: string[];
  /** Months of coverage in front of today, counted from the live table. */
  runwayMonths: number;
}

// Below this, the job exits non-zero so the Cloud Run job-failure alert fires.
// The point is to be told while there is still time to act: a partition table
// that runs dry loses rows silently, and by then the only signal left is the
// partition-overflow alert, which fires after the loss has started.
export const MIN_RUNWAY_MONTHS = 6;

export function firstOfMonthUTC(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

export function addMonths(d: Date, n: number): Date {
  const out = new Date(d.getTime());
  out.setUTCMonth(out.getUTCMonth() + n);
  return out;
}

export function formatYmd01(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

// Matches the naming migration 014 used for the 2027 months. The 2026 children
// are still called byok_usage_log_y2026_*, because migration 009 renamed the
// parent and the indexes but not the partitions. Nothing here needs to parse
// those — existence is checked against the declared bounds, not the name.
export function partitionNameFor(d: Date): string {
  return `${PARENT_TABLE}_y${d.getUTCFullYear()}_m${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// The doubled backslash is deliberate: the template literal must emit `\(` so
// Postgres sees an escaped literal paren. A single one is consumed by JS, and
// the bare `(` that reaches Postgres opens a capture group, so substring()
// returns the wrong match. eslint's no-useless-escape catches it.
//
// Existence is decided by the range a partition declares, not by what it is
// called. Two naming schemes already coexist on this table, so a name-based
// check would miss the 2026 partitions entirely and try to create overlapping
// ones — which Postgres rejects, failing the whole run.
// Returns the covering partition's real name, or null. The name matters in the
// result: the 2026 months are still called byok_usage_log_y2026_*, so reporting
// the canonical name for them would name a table that does not exist and send
// the next person looking for it.
async function coveringPartition(client: PoolClient, from: string): Promise<string | null> {
  const res = await client.query<{ child: string }>(
    `SELECT c.relname AS child
       FROM pg_class p
       JOIN pg_inherits i ON i.inhparent = p.oid
       JOIN pg_class c ON c.oid = i.inhrelid
      WHERE p.relname = $1
        AND pg_get_expr(c.relpartbound, c.oid) <> 'DEFAULT'
        AND (substring(pg_get_expr(c.relpartbound, c.oid) from 'FROM \\(''([0-9-]+)'))::date = $2::date
      LIMIT 1`,
    [PARENT_TABLE, from],
  );
  return res.rows[0]?.child ?? null;
}

export async function provisionPartitions(
  monthsAhead: number = DEFAULT_MONTHS_AHEAD,
  pool?: Pool,
  now: Date = new Date(),
): Promise<ProvisionResult> {
  // rls-fence: allow
  const p = pool ?? (await getPool());
  const client = await p.connect();
  const created: string[] = [];
  const existing: string[] = [];

  try {
    const start = firstOfMonthUTC(now);
    for (let i = 0; i < monthsAhead; i++) {
      const target = addMonths(start, i);
      const from = formatYmd01(target);
      const to = formatYmd01(addMonths(target, 1));
      const name = partitionNameFor(target);

      const covering = await coveringPartition(client, from);
      if (covering) {
        existing.push(covering);
        continue;
      }

      // IF NOT EXISTS guards a concurrent run; the bounds check above is what
      // decides whether the month needs covering at all.
      await client.query(
        `CREATE TABLE IF NOT EXISTS ${name} PARTITION OF ${PARENT_TABLE}
           FOR VALUES FROM ('${from}') TO ('${to}')`,
      );
      created.push(name);
    }
  } finally {
    client.release();
  }

  const runwayMonths = await countRunwayMonths(p, now);
  return { created, existing, runwayMonths };
}

// Counts consecutive months covered starting from the current one. Consecutive
// on purpose: a gap makes every month past it unreachable in practice, so the
// honest number is where the unbroken run ends, not the furthest bound.
export async function countRunwayMonths(pool: Pool, now: Date): Promise<number> {
  const client = await pool.connect();
  try {
    let months = 0;
    for (let i = 0; i < 120; i++) {
      const target = addMonths(firstOfMonthUTC(now), i);
      if (!(await coveringPartition(client, formatYmd01(target)))) break;
      months += 1;
    }
    return months;
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  const monthsAhead = Number(process.env.MONTHS_AHEAD ?? DEFAULT_MONTHS_AHEAD);
  if (!Number.isFinite(monthsAhead) || monthsAhead < 1) {
    throw new Error(`MONTHS_AHEAD must be a positive integer, got ${monthsAhead}`);
  }
  const result = await provisionPartitions(monthsAhead);
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(result, null, 2));

  if (result.runwayMonths < MIN_RUNWAY_MONTHS) {
    throw new Error(
      `only ${result.runwayMonths} month(s) of partition runway remain (minimum ${MIN_RUNWAY_MONTHS}). ` +
        'Provisioning ran but did not extend coverage far enough — check for a gap in the ' +
        'partition sequence, or a failure creating the months after the last covered one.',
    );
  }
}

if (process.argv[1]?.endsWith('partitions/provision.js')) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[partitions] failed', err);
    process.exit(1);
  });
}
