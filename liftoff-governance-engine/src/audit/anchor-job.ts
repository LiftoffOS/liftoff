// Daily chain-of-custody anchor for the action ledger.
//
// Hashes the `actions` partition covering the anchor date and uploads a 3-line
// manifest — partition name, row count, SHA-256 — to
//   gs://audit-anchors-${env}/governance/${yyyy-mm-dd}.hash
// The bucket enforces a multi-year object lock, so each date is written once.
//
// `actions` rather than `audit_logs`: the action ledger is the partitioned
// record of what agents actually did, and it is the one the anchor can cover a
// whole partition of. audit_logs is a plain table with no partitions to hash.

import { Storage } from '@google-cloud/storage';
import { createHash } from 'node:crypto';
import { getPool } from '../infrastructure/database';

const PARENT_TABLE = 'actions';

export interface AnchorResult {
  partitionName: string;
  rowCount: bigint;
  sha256: string;
  gcsUri: string;
}

// Selects the partition whose declared range covers `at`.
//
// Not the newest by name: migration 001 pre-creates 18 months, so the
// lexicographically-largest partition is an empty future month and an anchor
// over it hashes nothing while reporting success. Matching on bounds is also
// naming-independent, so adopting partman later cannot silently change which
// partition is anchored.
//
// The DEFAULT partition, if one is ever added, is excluded: it covers no range,
// so it is never the partition for a date.
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
  const environment = process.env.ENVIRONMENT ?? 'dev';
  const projectId = process.env.GCP_PROJECT_ID;
  if (!projectId) throw new Error('GCP_PROJECT_ID is not set');

  // rls-fence: allow
  const pool = getPool();

  const partitionRes = await pool.query<{ child: string }>(PARTITION_FOR_DATE_SQL, [at.toISOString()]);
  const partitionName = partitionRes.rows[0]?.child;
  if (!partitionName) {
    // A missing-partition problem, not a missing-anchor one: with no partition
    // covering this date, inserts into the action ledger are failing too.
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
  const objectName = `governance/${at.toISOString().slice(0, 10)}.hash`;
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
