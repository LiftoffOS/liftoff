// Daily chain-of-custody anchor for developer_proxy_usage_log.
//
// Hashes the partition covering the anchor date and uploads a 3-line manifest —
// partition name, row count, SHA-256 — to
//   gs://audit-anchors-${env}/developer-proxy/${yyyy-mm-dd}.hash
// The bucket enforces a multi-year object lock, so each date is written once and
// the record cannot be revised after the fact.
//
// Wired as a Cloud Run Job + Cloud Scheduler in terraform
// (modules/audit-anchor/ + modules/developer-proxy/audit-anchor-job.tf).

import { Storage } from '@google-cloud/storage';
import { createHash } from 'node:crypto';
import { getPool } from '../infrastructure/database.js';
import { loadConfig } from '../infrastructure/config.js';

const PARENT_TABLE = 'developer_proxy_usage_log';

export interface AnchorResult {
  partitionName: string;
  rowCount: bigint;
  sha256: string;
  gcsUri: string;
}

// Selects the partition whose declared range covers `at`.
//
// Not the newest partition by name: partitions are pre-created months ahead, so
// that would pick an empty future month and anchor a hash over nothing while
// reporting success. Matching on bounds is also naming-independent, which this
// table needs more than most — migration 009 renamed the parent but not the
// children, so it carries both `byok_usage_log_y2026_*` and
// `developer_proxy_usage_log_y2027_*` names.
//
// The DEFAULT partition is excluded: it covers no range, so it can never be the
// partition for a date.
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
  const config = loadConfig();
  // rls-fence: allow
  const pool = await getPool();

  const partitionRes = await pool.query<{ child: string }>(PARTITION_FOR_DATE_SQL, [at.toISOString()]);
  const partitionName = partitionRes.rows[0]?.child;
  if (!partitionName) {
    // A missing-partition problem, not a missing-anchor one: with no partition
    // covering this date, every usage insert is being rejected as well.
    throw new Error(
      `no ${PARENT_TABLE} partition covers ${at.toISOString()} — the partition runway has run out`,
    );
  }

  const count = await pool.query<{ c: string }>(`SELECT COUNT(*) AS c FROM "${partitionName}"`);
  const rowCount = BigInt(count.rows[0].c);

  // Ordered by id so the digest is deterministic across runs and replicas.
  const rows = await pool.query<{ concat: string | null }>(
    `SELECT string_agg(CAST(t AS TEXT), ',' ORDER BY t.id) AS concat FROM "${partitionName}" AS t`,
  );
  const sha256 = createHash('sha256').update(rows.rows[0].concat ?? '').digest('hex');

  const manifest = [partitionName, String(rowCount), sha256].join('\n') + '\n';
  const bucketName = `audit-anchors-${config.ENVIRONMENT}`;
  const objectName = `developer-proxy/${at.toISOString().slice(0, 10)}.hash`;
  const gcsUri = `gs://${bucketName}/${objectName}`;

  const storage = new Storage({ projectId: config.GCP_PROJECT_ID });
  const file = storage.bucket(bucketName).file(objectName);

  // One anchor per day, written once. The object lock means a second run cannot
  // replace the first — it fails on storage.objects.delete rather than doing
  // nothing — so an existing anchor is treated as final and retries stay safe.
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
