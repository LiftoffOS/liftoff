/**
 * tools/migration/setup-logical-replication.ts
 *
 * Phase 1.5h: Set up PostgreSQL logical replication from PB's
 * `claude_code_proxy_keys` to byok's `byok_credentials` for net-new rows.
 *
 * IMPORTANT LIMITATIONS — READ BEFORE RUNNING
 * ────────────────────────────────────────────
 * 1. Schema mismatch: the two tables have different column names.
 *    Only `id`, `key_hash`, and `status` map directly.
 *    Columns like `account_id` → `user_id`, `name` → `label`, and
 *    `anthropic_secret_name` (no equivalent in byok) require either:
 *      (a) A source-side view + publication on the view (PG 15+), or
 *      (b) A source-side AFTER INSERT trigger that writes to an outbox
 *          table with byok-compatible columns, which byok subscribes to.
 *
 * 2. RECOMMENDED ALTERNATIVE: Pub/Sub-based sync
 *    Rather than logical replication (which fights the schema mismatch),
 *    we recommend:
 *      - PB publishes a `credential.created` event to a shared Pub/Sub topic
 *        when a new claude_code_proxy_key is inserted.
 *      - byok-proxy subscribes and writes byok_credentials on receipt.
 *    This avoids WAL-level coupling and handles the secret re-naming step
 *    naturally in the consumer. See liftoff-developer-proxy src/outbox/ for the
 *    existing Pub/Sub infrastructure.
 *
 * Usage:
 *   npx tsx tools/migration/setup-logical-replication.ts
 *
 * Required env vars:
 *   SOURCE_DB_URL          – PB DB connection string (superuser or replication role)
 *   TARGET_DB_URL          – byok DB connection string (superuser)
 *   REPLICATION_USER       – username on PB DB with REPLICATION privilege
 *   REPLICATION_PASSWORD   – password for the replication user
 *   SOURCE_DB_HOST         – hostname/IP of PB DB reachable from byok DB host
 *   SOURCE_DB_PORT         – port of PB DB (default: 5432)
 *   SOURCE_DB_NAME         – PB database name (default: liftoff_control)
 */

import { Pool } from 'pg';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function assertEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function getEnvOrDefault(name: string, defaultValue: string): string {
  return process.env[name] ?? defaultValue;
}

// ---------------------------------------------------------------------------
// Banner
// ---------------------------------------------------------------------------

function printWarningBanner(): void {
  const line = '!'.repeat(72);
  console.log(`\n${line}`);
  console.log('!!! WARNING: LOGICAL REPLICATION REQUIREMENTS !!!');
  console.log(line);
  console.log('');
  console.log('Before running this script, ensure ALL of the following are true:');
  console.log('');
  console.log('  1. wal_level = logical  on the SOURCE database (PB / liftoff_control).');
  console.log('     Check with: SHOW wal_level;');
  console.log('     Changing wal_level requires a database restart on Cloud SQL.');
  console.log('');
  console.log('  2. The replication user must exist on source with REPLICATION privilege:');
  console.log('     CREATE ROLE replication_user WITH REPLICATION LOGIN PASSWORD \'...\';');
  console.log('     GRANT SELECT ON claude_code_proxy_keys TO replication_user;');
  console.log('');
  console.log('  3. pg_hba.conf on source must allow the target host to connect');
  console.log('     for replication (Cloud SQL: use Authorized Networks or Cloud SQL Proxy).');
  console.log('');
  console.log('  4. SCHEMA MISMATCH WARNING:');
  console.log('     claude_code_proxy_keys and byok_credentials have incompatible schemas.');
  console.log('     This script creates a SOURCE-SIDE VIEW with byok-compatible column names');
  console.log('     and publishes that view (requires PostgreSQL 15+ on source).');
  console.log('     If source is PG < 15, logical replication of views is NOT supported.');
  console.log('     Consider the Pub/Sub-based sync approach instead (see comments in file).');
  console.log('');
  console.log(line);
  console.log('');
}

// ---------------------------------------------------------------------------
// Source setup
// ---------------------------------------------------------------------------

async function setupSource(sourceDbUrl: string): Promise<void> {
  const pool = new Pool({ connectionString: sourceDbUrl });
  try {
    console.log('[source] Checking PostgreSQL version...');
    const versionResult = await pool.query<{ server_version: string }>(
      `SHOW server_version;`,
    );
    console.log(`[source] PostgreSQL version: ${versionResult.rows[0].server_version}`);

    console.log('[source] Checking wal_level...');
    const walResult = await pool.query<{ wal_level: string }>(
      `SHOW wal_level;`,
    );
    const walLevel = walResult.rows[0].wal_level;
    console.log(`[source] wal_level = ${walLevel}`);
    if (walLevel !== 'logical') {
      console.error(
        '[source] ERROR: wal_level is not "logical". ' +
        'Set wal_level=logical in Cloud SQL flags and restart the instance.',
      );
      // Do not exit — print remaining instructions so the operator knows what to do next.
    }

    // Create a source-side view with byok-compatible column names.
    // This allows a PG 15+ publication to expose only the columns byok needs.
    // Note: anthropic_secret_name is excluded — byok uses a different secret path
    //       and this cannot be replicated directly. Net-new rows will need the
    //       backfill script or Pub/Sub consumer to handle secret re-naming.
    console.log('[source] Creating compatibility view byok_credentials_view...');
    await pool.query(`
      CREATE OR REPLACE VIEW byok_credentials_view AS
      SELECT
        id,
        tenant_id,
        account_id                                   AS user_id,
        'anthropic'::text                            AS vendor,
        key_hash,
        key_prefix,
        key_hint,
        -- secret_name cannot be auto-derived here; placeholder only.
        -- Subscribers must call backfill.ts for the actual secret migration.
        'PLACEHOLDER_RUN_BACKFILL'::text             AS secret_name,
        name                                         AS label,
        status,
        last_used_at,
        created_at,
        updated_at,
        CASE WHEN status = 'revoked' THEN updated_at ELSE NULL END AS revoked_at
      FROM claude_code_proxy_keys
      WHERE deleted_at IS NULL
    `);
    console.log('[source] View created.');

    // Create the publication on the view (PG 15+ required).
    console.log('[source] Creating publication byok_creds_pub...');
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_publication WHERE pubname = 'byok_creds_pub'
        ) THEN
          CREATE PUBLICATION byok_creds_pub FOR TABLE claude_code_proxy_keys;
        ELSE
          RAISE NOTICE 'Publication byok_creds_pub already exists — skipping.';
        END IF;
      END
      $$;
    `);
    console.log('[source] Publication byok_creds_pub ready.');
  } finally {
    await pool.end();
  }
}

// ---------------------------------------------------------------------------
// Target setup
// ---------------------------------------------------------------------------

async function setupTarget(
  targetDbUrl: string,
  replicationUser: string,
  replicationPassword: string,
  sourceHost: string,
  sourcePort: string,
  sourceDbName: string,
): Promise<void> {
  const pool = new Pool({ connectionString: targetDbUrl });
  try {
    const connInfo =
      `host=${sourceHost} port=${sourcePort} dbname=${sourceDbName} ` +
      `user=${replicationUser} password=${replicationPassword}`;

    console.log('[target] Creating subscription byok_creds_sub...');

    // We use DO $$ to make the CREATE SUBSCRIPTION idempotent.
    // Note: CREATE SUBSCRIPTION cannot run inside a transaction in PG.
    // We call pool.query directly (autocommit).
    const subExists = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM pg_subscription WHERE subname = 'byok_creds_sub'`,
    );
    if (Number(subExists.rows[0].count) > 0) {
      console.log('[target] Subscription byok_creds_sub already exists — skipping.');
    } else {
      // CREATE SUBSCRIPTION must run outside a transaction block.
      await pool.query(`
        CREATE SUBSCRIPTION byok_creds_sub
          CONNECTION '${connInfo}'
          PUBLICATION byok_creds_pub
          WITH (
            copy_data    = false,
            create_slot  = true,
            enabled      = true
          )
      `);
      console.log('[target] Subscription byok_creds_sub created.');
    }

    console.log('\n[target] Subscription info:');
    const info = await pool.query(
      `SELECT subname, subenabled, subpublications FROM pg_subscription WHERE subname = 'byok_creds_sub'`,
    );
    console.log(info.rows);
  } finally {
    await pool.end();
  }
}

// ---------------------------------------------------------------------------
// Post-setup instructions
// ---------------------------------------------------------------------------

function printNextSteps(): void {
  console.log(`
=== Next Steps ===

1. Monitor replication lag on source:
   SELECT slot_name, active, write_lag, flush_lag, replay_lag
   FROM pg_replication_slots
   WHERE slot_name = 'byok_creds_sub';

2. Monitor subscription status on target:
   SELECT * FROM pg_stat_subscription;

3. IMPORTANT: secret_name in replicated rows will be 'PLACEHOLDER_RUN_BACKFILL'.
   Run tools/migration/backfill.ts AFTER subscription is active to backfill
   the correct secret paths and update any placeholder rows.

4. For net-new credentials created after cutover, implement a Pub/Sub consumer
   in byok-proxy that:
     - Receives 'credential.created' from PB's outbox topic
     - Reads the secret from PB Secret Manager
     - Writes it to byok Secret Manager under byok/{tenant}/{user}/anthropic/{ver}
     - Upserts byok_credentials

   This is more reliable than logical replication for a schema-mismatch scenario.

=== RECOMMENDED: Pub/Sub approach over logical replication ===

For net-new rows, logical replication fights the schema mismatch and requires
wal_level=logical (a Cloud SQL restart). The Pub/Sub approach is:
  - Schema-agnostic (each service owns its own write)
  - Retry-safe (Pub/Sub provides at-least-once delivery)
  - Already wired: byok-proxy has outbox/ infrastructure for Pub/Sub
  See src/outbox/ in liftoff-developer-proxy for the publisher/consumer patterns.
`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  printWarningBanner();

  const sourceDbUrl = assertEnv('SOURCE_DB_URL');
  const targetDbUrl = assertEnv('TARGET_DB_URL');
  const replicationUser = assertEnv('REPLICATION_USER');
  const replicationPassword = assertEnv('REPLICATION_PASSWORD');
  const sourceHost = assertEnv('SOURCE_DB_HOST');
  const sourcePort = getEnvOrDefault('SOURCE_DB_PORT', '5432');
  const sourceDbName = getEnvOrDefault('SOURCE_DB_NAME', 'liftoff_control');

  console.log('=== Setting up logical replication ===\n');

  await setupSource(sourceDbUrl);
  console.log('');
  await setupTarget(targetDbUrl, replicationUser, replicationPassword, sourceHost, sourcePort, sourceDbName);

  printNextSteps();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
