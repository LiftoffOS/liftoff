#!/usr/bin/env node
/**
 * manage-partitions.ts — monthly partition rotation for governance-pg.
 *
 * What it does:
 *   - Ensures the current month + `futureMonths` monthly partitions exist
 *     on `actions` and `usage_events` (both RANGE-partitioned on
 *     created_at per migration 001).
 *   - Drops any managed partition older than `retainMonths` (DETACH first,
 *     then DROP).
 *   - Idempotent. Safe to run repeatedly.
 *
 * Usage (CLI — matches Cloud Run Job entrypoint):
 *   node dist/scripts/partitions/manage-partitions.js \
 *     [--future-months 3] [--retain-months 18] [--dry-run]
 *
 * Environment variables (same shape as scripts/reconcile so the Cloud Run
 * Job env can be reused):
 *   DB_HOST                 - Cloud SQL unix socket path or private IP
 *   DB_PORT                 - default 5432
 *   DB_NAME                 - default governance_engine
 *   DB_USER                 - default governance_admin (BYPASSRLS; needed
 *                             because partition DDL is not tenant-scoped)
 *   DB_PASSWORD             - literal, or Secret Manager resource path
 *                             (projects/…/secrets/.../versions/latest)
 *   DB_INSTANCE_CONNECTION_NAME - Cloud SQL socket prefix; when set the
 *                             script uses /cloudsql/<name> as the DB host.
 *
 * Exit codes:
 *   0 — plan applied (or dry-run succeeded)
 *   1 — one or more DDL statements failed
 *   2 — configuration / connectivity error
 */

import { Pool } from 'pg';
import {
  PARTITIONED_TABLES,
  PartitionedTable,
  buildPartitionPlan,
  partitionName,
} from '../../partitions/partition-manager.js';

interface Options {
  futureMonths: number;
  retainMonths: number;
  dryRun: boolean;
  dbHost: string;
  dbPort: number;
  dbName: string;
  dbUser: string;
  dbPassword: string;
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else {
      out[key] = 'true';
    }
  }
  return out;
}

async function resolvePassword(raw: string): Promise<string> {
  if (!raw.startsWith('projects/')) return raw;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');
  const client = new SecretManagerServiceClient();
  const [version] = await client.accessSecretVersion({ name: raw });
  return version.payload.data.toString('utf8');
}

async function buildOptions(): Promise<Options> {
  const cli = parseArgs(process.argv.slice(2));
  const pwRaw = process.env.DB_PASSWORD;
  if (!pwRaw) {
    throw new Error('manage-partitions: DB_PASSWORD is required');
  }

  // Cloud SQL sidecar socket support — same convention as reconcile.
  const instanceConn = process.env.DB_INSTANCE_CONNECTION_NAME;
  const host = instanceConn
    ? `/cloudsql/${instanceConn}`
    : process.env.DB_HOST ?? '127.0.0.1';

  return {
    futureMonths: Number(cli['future-months'] ?? process.env.FUTURE_MONTHS ?? 3),
    retainMonths: Number(cli['retain-months'] ?? process.env.RETAIN_MONTHS ?? 18),
    dryRun: cli['dry-run'] === 'true' || process.env.DRY_RUN === 'true',
    dbHost: host,
    dbPort: Number(process.env.DB_PORT ?? 5432),
    dbName: process.env.DB_NAME ?? 'governance_engine',
    dbUser: process.env.DB_USER ?? 'governance_admin',
    dbPassword: await resolvePassword(pwRaw),
  };
}

// Enumerate partitions attached to each managed parent table via
// pg_inherits + pg_class. Returns the set of child table names per
// parent so buildPartitionPlan() can decide what already exists.
async function loadExistingPartitions(
  pool: Pool,
): Promise<Record<PartitionedTable, Set<string>>> {
  const out: Record<string, Set<string>> = {};
  for (const parent of PARTITIONED_TABLES) {
    const res = await pool.query(
      `SELECT c.relname AS child
         FROM pg_inherits i
         JOIN pg_class p ON p.oid = i.inhparent
         JOIN pg_class c ON c.oid = i.inhrelid
        WHERE p.relname = $1`,
      [parent],
    );
    out[parent] = new Set(res.rows.map((r: { child: string }) => r.child));
  }
  return out as Record<PartitionedTable, Set<string>>;
}

async function main(): Promise<void> {
  const opts = await buildOptions();

  const pool = new Pool({
    host: opts.dbHost,
    port: opts.dbPort,
    database: opts.dbName,
    user: opts.dbUser,
    password: opts.dbPassword,
    max: 2,
  });

  let created = 0;
  let dropped = 0;
  let skipped = 0;
  let failed = 0;

  try {
    const existing = await loadExistingPartitions(pool);
    const plan = buildPartitionPlan({
      now: new Date(),
      futureMonths: opts.futureMonths,
      retainMonths: opts.retainMonths,
      existing,
    });

    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        event: 'manage_partitions_plan',
        dryRun: opts.dryRun,
        futureMonths: opts.futureMonths,
        retainMonths: opts.retainMonths,
        toCreate: plan.toCreate.map(p => partitionName(p.table, p.month)),
        toDrop: plan.toDrop.map(p => partitionName(p.table, p.month)),
        skippedExisting: plan.skippedExisting.length,
      }),
    );

    if (opts.dryRun) {
      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify({
          event: 'manage_partitions_done',
          dryRun: true,
          created: 0,
          dropped: 0,
          skipped: plan.skippedExisting.length,
        }),
      );
      return;
    }

    for (const step of plan.toCreate) {
      try {
        await pool.query(step.ddl);
        created++;
        // eslint-disable-next-line no-console
        console.log(
          JSON.stringify({
            event: 'manage_partitions_created',
            partition: partitionName(step.table, step.month),
          }),
        );
      } catch (err) {
        failed++;
        // eslint-disable-next-line no-console
        console.error(
          JSON.stringify({
            event: 'manage_partitions_create_failed',
            partition: partitionName(step.table, step.month),
            error: (err as Error).message,
          }),
        );
      }
    }

    skipped = plan.skippedExisting.length;

    for (const step of plan.toDrop) {
      const name = partitionName(step.table, step.month);
      try {
        // Detach first so in-flight queries don't hit a dropped partition.
        await pool.query(step.detachDDL);
        await pool.query(step.dropDDL);
        dropped++;
        // eslint-disable-next-line no-console
        console.log(
          JSON.stringify({ event: 'manage_partitions_dropped', partition: name }),
        );
      } catch (err) {
        failed++;
        // eslint-disable-next-line no-console
        console.error(
          JSON.stringify({
            event: 'manage_partitions_drop_failed',
            partition: name,
            error: (err as Error).message,
          }),
        );
      }
    }

    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        event: 'manage_partitions_done',
        dryRun: false,
        created,
        dropped,
        skipped,
        failed,
      }),
    );

    if (failed > 0) process.exit(1);
  } finally {
    await pool.end();
  }
}

main().catch(err => {
  // eslint-disable-next-line no-console
  console.error(
    JSON.stringify({
      event: 'manage_partitions_fatal',
      error: (err as Error).message,
    }),
  );
  process.exit(2);
});
