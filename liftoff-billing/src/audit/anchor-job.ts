// Phase 0y — daily chain-of-custody anchor publish.
//
// Hashes the billing_audit_log partition covering the anchor date, computes a
// SHA256 of its content + row count + partition name, and uploads a
// 3-line manifest to
//   gs://audit-anchors-${env}/billing/${yyyy-mm-dd}.hash
// with object-lock retention (7 years) enforced at the bucket level.
//
// Wired as a Cloud Run Job + Cloud Scheduler via terraform
// (modules/audit-anchor/ + modules/billing/).

import { Storage } from '@google-cloud/storage';
import { createHash } from 'node:crypto';
import { getPool } from '../infrastructure/database.js';
import { loadConfig } from '../infrastructure/config.js';

export interface AnchorResult {
  partitionName: string;
  rowCount: bigint;
  sha256: string;
  gcsUri: string;
}

// Selects the partition whose range covers `at`.
//
// Partitions are pre-created months ahead, so picking the newest one by name
// selects an empty future month rather than the one being written to — an
// anchor over that hashes nothing and still reports success. Matching on the
// declared bounds is also naming-independent, which matters because partitions
// here are named y2026_m08 while partman would name the same month p20260801.
//
// The DEFAULT partition is excluded: it covers no range, so it can never be the
// partition for a given date.
export const PARTITION_FOR_DATE_SQL = `
  SELECT c.relname AS child
    FROM pg_class p
    JOIN pg_inherits i ON i.inhparent = p.oid
    JOIN pg_class c ON c.oid = i.inhrelid
   WHERE p.relname = 'billing_audit_log'
     AND pg_get_expr(c.relpartbound, c.oid) <> 'DEFAULT'
     AND (substring(pg_get_expr(c.relpartbound, c.oid) from 'FROM \\(''([0-9-]+)'))::timestamptz <= $1
     AND (substring(pg_get_expr(c.relpartbound, c.oid) from 'TO \\(''([0-9-]+)'))::timestamptz > $1
   LIMIT 1`;

export async function publishAnchor(at: Date = new Date()): Promise<AnchorResult> {
  const config = loadConfig();
  // rls-fence: allow
  const pool = await getPool();

  const partitionRes = await pool.query<{ child: string }>(PARTITION_FOR_DATE_SQL, [at.toISOString()]);
  const partitionName = partitionRes.rows[0]?.child;
  if (!partitionName) {
    // Not a missing-anchor problem but a missing-partition one: no partition
    // covers this date, so writes to the audit log are being rejected too.
    throw new Error(
      `no billing_audit_log partition covers ${at.toISOString()} — the partition runway has run out`,
    );
  }

  // Count + hash the partition's rows.
  const count = await pool.query<{ c: string }>(
    `SELECT COUNT(*) AS c FROM ${partitionName}`,
  );
  const rowCount = BigInt(count.rows[0].c);

  // Stream-hash all rows — for small partitions this is a single
  // query; for large partitions the stream pattern matters (kept
  // simple here).
  const rows = await pool.query<{ concat: string | null }>(
    `SELECT string_agg((CAST(t AS TEXT)), ',' ORDER BY (t.id)) AS concat
     FROM ${partitionName} AS t`,
  );
  const hash = createHash('sha256');
  hash.update(rows.rows[0].concat ?? '');
  const sha256 = hash.digest('hex');

  const manifest = [partitionName, String(rowCount), sha256].join('\n') + '\n';
  const today = at.toISOString().slice(0, 10);
  const bucketName = `audit-anchors-${config.ENVIRONMENT}`;
  const objectName = `billing/${today}.hash`;

  const storage = new Storage({ projectId: config.GCP_PROJECT_ID });
  const file = storage.bucket(bucketName).file(objectName);
  const gcsUri = `gs://${bucketName}/${objectName}`;

  // One anchor per day, written once. The bucket enforces a multi-year object
  // lock, so a second run on the same date cannot replace the first and fails
  // with 403 on storage.objects.delete rather than doing nothing. Treating an
  // existing anchor as final makes retries safe and keeps the record immutable,
  // which is the property the anchor exists to provide.
  const [alreadyAnchored] = await file.exists();
  if (alreadyAnchored) {
    // eslint-disable-next-line no-console
    console.log(`[audit-anchor] ${gcsUri} already exists; leaving it untouched`);
    return { partitionName, rowCount, sha256, gcsUri };
  }

  await file.save(manifest, { contentType: 'text/plain' });

  // eslint-disable-next-line no-console
  console.log(`[audit-anchor] published ${gcsUri} for ${partitionName}`);
  return { partitionName, rowCount, sha256, gcsUri };
}

if (process.argv[1]?.endsWith('audit/anchor-job.js')) {
  publishAnchor().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[audit-anchor] failed', err);
    process.exit(1);
  });
}
