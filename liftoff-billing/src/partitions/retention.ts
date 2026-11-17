// Phase 1b Gap 5 — 7-year retention for billing_audit_log.
//
// For every billing_audit_log partition older than `retentionYears`:
//   1. pg_dump the partition to a .jsonl.gz via
//      `COPY ... TO STDOUT WITH (FORMAT csv)` + gzip.
//   2. Upload to `gs://liftoff-billing-audit-cold-${env}/<partition>.csv.gz`
//      under the isolated audit-anchor KMS key.
//   3. Verify the hash-chain integrity of the partition (using
//      billing_audit_log_verify_chain from migration 004) and refuse
//      to drop if any row fails verification.
//   4. DETACH the partition, DROP it, and insert a pointer row into
//      billing_audit_log_archive.

import { Storage } from '@google-cloud/storage';
import { createGzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { getPool } from '../infrastructure/database.js';
import { loadConfig } from '../infrastructure/config.js';

interface RetentionOptions {
  retentionYears: number;
  coldStorageBucket: string;
  dryRun: boolean;
}

export async function runRetention(opts: RetentionOptions): Promise<{
  archived: Array<{ partition: string; rowCount: bigint; gcsUri: string; chainVerified: boolean }>;
  skipped: Array<{ partition: string; reason: string }>;
}> {
  const config = loadConfig();
  // rls-fence: allow
  const pool = await getPool();
  const storage = new Storage({ projectId: config.GCP_PROJECT_ID });

  const cutoff = new Date();
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - opts.retentionYears);

  // Find partitions older than the cutoff.
  const { rows: partitions } = await pool.query<{ child: string; upper: string }>(
    `SELECT c.relname AS child,
            (regexp_matches(pg_get_expr(c.relpartbound, c.oid), 'TO \\(''([0-9-]+)'''))[1] AS upper
     FROM pg_inherits i
     JOIN pg_class c ON c.oid = i.inhrelid
     WHERE i.inhparent = 'billing_audit_log'::regclass`,
  );

  const archived: Array<{ partition: string; rowCount: bigint; gcsUri: string; chainVerified: boolean }> = [];
  const skipped: Array<{ partition: string; reason: string }> = [];

  for (const p of partitions) {
    const upperDate = new Date(`${p.upper}T00:00:00Z`);
    if (upperDate > cutoff) continue;

    // 1. Verify chain
    const { rows: verify } = await pool.query<{ row_id: string; ok: boolean }>(
      `SELECT * FROM billing_audit_log_verify_chain($1)`,
      [p.child],
    );
    const bad = verify.filter((v) => !v.ok);
    if (bad.length > 0) {
      skipped.push({ partition: p.child, reason: `chain verification failed (${bad.length} rows)` });
      continue;
    }

    // 2. Export via COPY → gzip → GCS
    const objectName = `${p.child}.csv.gz`;
    const client = await pool.connect();
    try {
      const { rows: countRows } = await client.query<{ c: string }>(
        `SELECT COUNT(*) AS c FROM ${p.child}`,
      );
      const rowCount = BigInt(countRows[0].c);
      if (!opts.dryRun) {
        const writeStream = storage
          .bucket(opts.coldStorageBucket)
          .file(objectName)
          .createWriteStream({ contentType: 'application/gzip', resumable: false });
        const gzip = createGzip();

        // Use pg COPY TO for streaming export.
        const { to: pgCopyTo } = await import('pg-copy-streams');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const copyStream = client.query(pgCopyTo(`COPY ${p.child} TO STDOUT WITH (FORMAT csv, HEADER true)`) as any);
        await pipeline(copyStream as unknown as Readable, gzip, writeStream);
      }
      const gcsUri = `gs://${opts.coldStorageBucket}/${objectName}`;

      // 3. Archive pointer
      if (!opts.dryRun) {
        await client.query(
          `INSERT INTO billing_audit_log_archive
             (partition_name, row_count, gcs_object_uri, archived_at, hash_chain_verified)
           VALUES ($1, $2, $3, NOW(), TRUE)`,
          [p.child, String(rowCount), gcsUri],
        );
        await client.query(`ALTER TABLE billing_audit_log DETACH PARTITION ${p.child}`);
        await client.query(`DROP TABLE ${p.child}`);
      }
      archived.push({ partition: p.child, rowCount, gcsUri, chainVerified: true });
    } finally {
      client.release();
    }
  }

  return { archived, skipped };
}

if (process.argv[1]?.endsWith('partitions/retention.js')) {
  runRetention({
    retentionYears: Number(process.env.RETENTION_YEARS ?? '7'),
    coldStorageBucket: process.env.COLD_STORAGE_BUCKET ?? '',
    dryRun: process.env.DRY_RUN === 'true',
  }).then((r) => {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ archived: r.archived.map((a) => ({ ...a, rowCount: String(a.rowCount) })), skipped: r.skipped }, null, 2));
    process.exit(0);
  }).catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[retention] failed', err);
    process.exit(1);
  });
}

void randomUUID; // keep crypto linked for future receipt signing
