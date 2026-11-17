// Daily chain-of-custody anchor for workforce_audit_log.
//
// Hashes the partition covering the anchor date and uploads a 3-line manifest —
// partition name, row count, SHA-256 — to
//   gs://audit-anchors-${env}/workforce/${yyyy-mm-dd}.hash
// The bucket enforces a multi-year object lock, so each date is written once and
// the record cannot be revised afterwards.

import { Storage } from '@google-cloud/storage';
import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import { buildPoolConfig, resolvePassword } from '../infrastructure/database.js';

const PARENT_TABLE = 'workforce_audit_log';

export interface AnchorResult {
  partitionName: string;
  rowCount: bigint;
  sha256: string;
  gcsUri: string;
}

// Selects the partition whose declared range covers `at`.
//
// Not the newest by name: partitions are pre-created months ahead, so that
// picks an empty future month and anchors a hash over nothing while reporting
// success. Bounds are also naming-independent, which this table needs — partman
// manages it and names new partitions workforce_audit_log_p20260801 while the
// hand-written ones are workforce_audit_log_2026_04.
//
// The DEFAULT partition is excluded: it covers no range, so it is never the
// partition for a date, and rows landing there are an overflow symptom rather
// than the month's record.
export const PARTITION_FOR_DATE_SQL = `
  SELECT c.relname AS child
    FROM pg_class p
    JOIN pg_inherits i ON i.inhparent = p.oid
    JOIN pg_class c ON c.oid = i.inhrelid
   WHERE p.relname = '${PARENT_TABLE}'
     AND pg_get_expr(c.relpartbound, c.oid) <> 'DEFAULT'
     AND (substring(pg_get_expr(c.relpartbound, c.oid) from 'FROM \\(''([0-9-]+)'))::timestamptz <= $1
     AND (substring(pg_get_expr(c.relpartbound, c.oid) from 'TO \\(''([0-9-]+)'))::timestamptz > $1
   LIMIT 1`;

export async function publishAnchor(at: Date = new Date()): Promise<AnchorResult> {
  // Reads the two variables it needs directly rather than through loadConfig().
  // The service config requires PLATFORM_BACKEND_URL and other fields a
  // partition hash has no use for, and requiring them here couples a
  // maintenance job to the whole service contract — the job failed validation
  // on exactly that before this.
  const environment = process.env.ENVIRONMENT ?? 'dev';
  const projectId = process.env.GCP_PROJECT_ID;
  if (!projectId) throw new Error('GCP_PROJECT_ID is not set');

  // Builds its own pool rather than calling initPool(). initPool() goes through
  // loadConfig(), which requires PLATFORM_BACKEND_URL — a variable Cloud Build
  // sets when it deploys the service and Terraform does not set on this job, so
  // a terraform-managed job can never satisfy it. The job needs a database
  // connection, not the service's config contract.
  const connectionName = process.env.DB_INSTANCE_CONNECTION_NAME;
  if (!connectionName) throw new Error('DB_INSTANCE_CONNECTION_NAME is not set');
  const password = await resolvePassword(process.env.DB_APP_PASSWORD_SECRET ?? '');

  // rls-fence: allow
  const pool = new Pool(
    buildPoolConfig(
      connectionName,
      process.env.DB_NAME ?? 'workforce',
      process.env.DB_USER ?? 'workforce_migrate',
      password,
    ),
  );

  const partitionRes = await pool.query<{ child: string }>(PARTITION_FOR_DATE_SQL, [at.toISOString()]);
  const partitionName = partitionRes.rows[0]?.child;
  if (!partitionName) {
    // A missing-partition problem, not a missing-anchor one: with no partition
    // covering this date, audit writes are being rejected as well.
    throw new Error(
      `no ${PARENT_TABLE} partition covers ${at.toISOString()} — the partition runway has run out`,
    );
  }

  const count = await pool.query<{ c: string }>(`SELECT COUNT(*) AS c FROM "${partitionName}"`);
  const rowCount = BigInt(count.rows[0].c);

  // Ordered by id so the digest is deterministic across runs.
  const rows = await pool.query<{ concat: string | null }>(
    `SELECT string_agg(CAST(t AS TEXT), ',' ORDER BY t.id) AS concat FROM "${partitionName}" AS t`,
  );
  const sha256 = createHash('sha256').update(rows.rows[0].concat ?? '').digest('hex');

  const manifest = [partitionName, String(rowCount), sha256].join('\n') + '\n';
  const bucketName = `audit-anchors-${environment}`;
  const objectName = `workforce/${at.toISOString().slice(0, 10)}.hash`;
  const gcsUri = `gs://${bucketName}/${objectName}`;

  const storage = new Storage({ projectId });
  const file = storage.bucket(bucketName).file(objectName);

  // One anchor per date, written once. Under the object lock a second run
  // cannot replace the first, so an existing anchor is final and retries are
  // safe.
  const [alreadyAnchored] = await file.exists();
  if (alreadyAnchored) {
    // eslint-disable-next-line no-console
    console.log(`[audit-anchor] ${gcsUri} already exists; leaving it untouched`);
    await pool.end();
    return { partitionName, rowCount, sha256, gcsUri };
  }

  await file.save(manifest, { contentType: 'text/plain' });
  // eslint-disable-next-line no-console
  console.log(`[audit-anchor] published ${gcsUri} for ${partitionName}`);
  await pool.end();
  return { partitionName, rowCount, sha256, gcsUri };
}

if (process.argv[1]?.endsWith('audit/anchor-job.js')) {
  publishAnchor().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[audit-anchor] failed', err);
    process.exit(1);
  });
}
