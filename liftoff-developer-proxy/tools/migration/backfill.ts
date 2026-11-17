/**
 * tools/migration/backfill.ts
 *
 * Phase 1.5h: Credential backfill from platform-backend → byok-proxy.
 *
 * Reads all non-deleted rows from `claude_code_proxy_keys` (PB DB),
 * re-writes the Anthropic API key into a new Secret Manager path under the
 * byok naming convention, and inserts the record into `byok_credentials`.
 *
 * Usage:
 *   npx tsx tools/migration/backfill.ts [--dry-run]
 *
 * Required env vars:
 *   SOURCE_DB_URL       – connection string for PB (liftoff_control)
 *   TARGET_DB_URL       – connection string for byok-proxy DB
 *   SOURCE_PROJECT      – GCP project containing the source secrets
 *   TARGET_PROJECT      – GCP project for byok (may equal SOURCE_PROJECT in dev)
 */

import { Pool, type PoolClient } from 'pg';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DRY_RUN = process.argv.includes('--dry-run');
const BATCH_SIZE = 50;

const SOURCE_DB_URL = process.env.SOURCE_DB_URL;
const TARGET_DB_URL = process.env.TARGET_DB_URL;
const SOURCE_PROJECT = process.env.SOURCE_PROJECT;
const TARGET_PROJECT = process.env.TARGET_PROJECT;

function assertEnv(name: string, value: string | undefined): string {
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

// ---------------------------------------------------------------------------
// Source row type (claude_code_proxy_keys)
// ---------------------------------------------------------------------------

interface PbProxyKey {
  id: string;
  tenant_id: string;
  account_id: string;
  key_hash: string;
  key_prefix: string;
  key_hint: string;
  anthropic_secret_name: string;
  name: string;
  status: string;
  last_used_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

// ---------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------

interface Counters {
  processed: number;
  skipped: number;
  failed: number;
}

// ---------------------------------------------------------------------------
// Secret Manager helpers
// ---------------------------------------------------------------------------

async function readSourceSecret(
  smClient: SecretManagerServiceClient,
  sourceProject: string,
  secretId: string,
): Promise<string> {
  const name = `projects/${sourceProject}/secrets/${secretId}/versions/latest`;
  const [version] = await smClient.accessSecretVersion({ name });
  const raw = version.payload?.data;
  if (!raw) throw new Error(`Secret ${name} has empty payload`);
  const payloadStr = typeof raw === 'string' ? raw : Buffer.from(raw as Uint8Array).toString('utf-8');

  // Old PB format: JSON { "anthropicApiKey": "sk-ant-...", "storedAt": "..." }
  // Try JSON parse; fall back to raw string if it doesn't parse.
  try {
    const parsed = JSON.parse(payloadStr) as { anthropicApiKey?: string };
    if (parsed.anthropicApiKey) return parsed.anthropicApiKey;
  } catch {
    // not JSON — treat as raw key
  }
  return payloadStr.trim();
}

async function writeTargetSecret(
  smClient: SecretManagerServiceClient,
  targetProject: string,
  secretPath: string,   // e.g. byok/{tenant_id}/{user_id}/anthropic/1
  apiKey: string,
  dryRun: boolean,
): Promise<void> {
  if (dryRun) {
    console.log(`  [dry-run] Would create secret: projects/${targetProject}/secrets/${secretPath}`);
    return;
  }

  // Secret ID cannot contain slashes — encode the path as dashes for the
  // Secret Manager resource ID, but store the logical path in the label.
  // Convention: replace '/' with '--' for the resource ID.
  const secretId = secretPath.replace(/\//g, '--');
  const parent = `projects/${targetProject}`;

  // Create the secret resource (idempotent — ignore ALREADY_EXISTS).
  try {
    await smClient.createSecret({
      parent,
      secretId,
      secret: {
        replication: { automatic: {} },
        labels: { 'byok-path': secretPath.replace(/\//g, '_') },
      },
    });
  } catch (err: unknown) {
    const grpcErr = err as { code?: number };
    if (grpcErr.code !== 6 /* ALREADY_EXISTS */) throw err;
    // Secret already exists — add a new version below.
  }

  // Add the secret version (raw API key string).
  await smClient.addSecretVersion({
    parent: `${parent}/secrets/${secretId}`,
    payload: {
      data: Buffer.from(apiKey, 'utf-8'),
    },
  });
}

// ---------------------------------------------------------------------------
// Target DB helpers (byok_credentials)
// ---------------------------------------------------------------------------

async function upsertByokCredential(
  targetClient: PoolClient,
  row: PbProxyKey,
  secretName: string,
  dryRun: boolean,
): Promise<'inserted' | 'skipped'> {
  const revokedAt = row.status === 'revoked' ? row.updated_at : null;

  if (dryRun) {
    console.log(
      `  [dry-run] Would insert byok_credentials: id=${row.id} tenant=${row.tenant_id} user=${row.account_id} status=${row.status}`,
    );
    return 'inserted';
  }

  // NOTE: account_id is treated directly as user_id per Phase 1.5h spec.
  // In production, if account_id != user_id, join with accounts table first.
  const result = await targetClient.query(
    `INSERT INTO byok_credentials
       (id, tenant_id, user_id, vendor, key_hash, key_prefix, key_hint, secret_name, label, status, last_used_at, created_at, updated_at, revoked_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (id)       DO NOTHING
     RETURNING id`,
    [
      row.id,
      row.tenant_id,
      row.account_id,        // account_id → user_id (1:1 mapping assumed for backfill)
      'anthropic',
      row.key_hash,
      row.key_prefix,
      row.key_hint,
      secretName,
      row.name,
      row.status,
      row.last_used_at,
      row.created_at,
      row.updated_at,
      revokedAt,
    ],
  );

  // If ON CONFLICT suppressed the insert, rowCount = 0.
  if ((result.rowCount ?? 0) === 0) return 'skipped';

  // Also check key_hash uniqueness — a separate row with the same hash
  // (different id) would have been caught by the ON CONFLICT on id; if it
  // still conflicts on key_hash the query would have thrown. We rely on the
  // DB constraint for that guard.
  return 'inserted';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`=== BYOK Credential Backfill ===`);
  if (DRY_RUN) console.log('*** DRY-RUN MODE — no writes will occur ***\n');

  const sourceDbUrl = assertEnv('SOURCE_DB_URL', SOURCE_DB_URL);
  const targetDbUrl = assertEnv('TARGET_DB_URL', TARGET_DB_URL);
  const sourceProject = assertEnv('SOURCE_PROJECT', SOURCE_PROJECT);
  const targetProject = assertEnv('TARGET_PROJECT', TARGET_PROJECT);

  const sourcePool = new Pool({ connectionString: sourceDbUrl });
  const targetPool = new Pool({ connectionString: targetDbUrl });
  const smClient = new SecretManagerServiceClient();

  const counters: Counters = { processed: 0, skipped: 0, failed: 0 };

  try {
    // Fetch all non-deleted PB credentials.
    const { rows: allRows } = await sourcePool.query<PbProxyKey>(`
      SELECT id, tenant_id, account_id, key_hash, key_prefix, key_hint,
             anthropic_secret_name, name, status, last_used_at, created_at, updated_at
      FROM claude_code_proxy_keys
      WHERE deleted_at IS NULL
      ORDER BY created_at ASC
    `);

    console.log(`Found ${allRows.length} credential(s) to migrate.\n`);

    // Process in batches of BATCH_SIZE.
    for (let batchStart = 0; batchStart < allRows.length; batchStart += BATCH_SIZE) {
      const batch = allRows.slice(batchStart, batchStart + BATCH_SIZE);
      const batchNum = Math.floor(batchStart / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(allRows.length / BATCH_SIZE);
      console.log(`--- Batch ${batchNum}/${totalBatches} (rows ${batchStart + 1}–${batchStart + batch.length}) ---`);

      const batchCounters = { processed: 0, skipped: 0, failed: 0 };

      for (const row of batch) {
        const secretName = `byok/${row.tenant_id}/${row.account_id}/anthropic/1`;

        try {
          // Step 1: Read Anthropic key from PB Secret Manager.
          const anthropicApiKey = await readSourceSecret(smClient, sourceProject, row.anthropic_secret_name);

          // Step 2: Write to target Secret Manager under new path.
          await writeTargetSecret(smClient, targetProject, secretName, anthropicApiKey, DRY_RUN);

          // Step 3: Insert into byok_credentials.
          const targetClient = await targetPool.connect();
          let outcome: 'inserted' | 'skipped';
          try {
            await targetClient.query('BEGIN');
            outcome = await upsertByokCredential(targetClient, row, secretName, DRY_RUN);
            await targetClient.query('COMMIT');
          } catch (err) {
            await targetClient.query('ROLLBACK').catch(() => undefined);
            throw err;
          } finally {
            targetClient.release();
          }

          if (outcome === 'skipped') {
            batchCounters.skipped++;
            console.log(`  SKIP  id=${row.id} (already exists)`);
          } else {
            batchCounters.processed++;
            console.log(`  OK    id=${row.id} status=${row.status} secret=${secretName}`);
          }
        } catch (err) {
          batchCounters.failed++;
          console.error(`  FAIL  id=${row.id}: ${(err as Error).message}`);
        }
      }

      counters.processed += batchCounters.processed;
      counters.skipped += batchCounters.skipped;
      counters.failed += batchCounters.failed;

      console.log(
        `  Batch result: ${batchCounters.processed} inserted, ` +
        `${batchCounters.skipped} skipped, ${batchCounters.failed} failed\n`,
      );
    }
  } finally {
    await sourcePool.end();
    await targetPool.end();
  }

  // Summary
  console.log('=== Summary ===');
  console.log(`  Inserted : ${counters.processed}`);
  console.log(`  Skipped  : ${counters.skipped}`);
  console.log(`  Failed   : ${counters.failed}`);

  if (counters.failed > 0) {
    console.error(`\n${counters.failed} credential(s) failed to migrate. See errors above.`);
    process.exit(1);
  } else {
    console.log('\nBackfill complete.');
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
