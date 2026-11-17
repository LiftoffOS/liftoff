// One-time migration: copy claude_code_proxy_keys (platform-backend DB) →
// developer_proxy_credentials (developer-proxy DB). Both DBs live on the same Cloud SQL
// instance; run with one Cloud SQL Auth Proxy tunnel.
//
// Prerequisites:
//   cloud-sql-proxy YOUR_GCP_PROJECT{ENV}:us-west1:control-plane-pg-{ENV} \
//     --port=5432
//
// Usage (dev):
//   PB_DB_NAME=liftoff_control_plane \
//   PB_DB_USER=<platform_backend_user> \
//   PB_DB_PASSWORD=<password> \
//   DEVELOPER_PROXY_DB_NAME=developer_proxy \
//   DEVELOPER_PROXY_DB_USER=developer_proxy_app \
//   DEVELOPER_PROXY_DB_PASSWORD=<password> \
//   ts-node --transpile-only scripts/migrate-keys-to-developer-proxy.ts
//
// The script is idempotent: ON CONFLICT (key_hash) DO NOTHING.
// Run on dev first, verify counts, then run on prod.

import { Pool } from 'pg';

const DB_HOST = process.env.DB_HOST ?? '127.0.0.1';
const DB_PORT = parseInt(process.env.DB_PORT ?? '5432', 10);

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

async function main() {
  const pbPool = new Pool({
    host: DB_HOST,
    port: DB_PORT,
    database: requireEnv('PB_DB_NAME'),
    user: requireEnv('PB_DB_USER'),
    password: requireEnv('PB_DB_PASSWORD'),
    max: 2,
  });

  const devProxyPool = new Pool({
    host: DB_HOST,
    port: DB_PORT,
    database: requireEnv('DEVELOPER_PROXY_DB_NAME'),
    user: requireEnv('DEVELOPER_PROXY_DB_USER'),
    password: requireEnv('DEVELOPER_PROXY_DB_PASSWORD'),
    max: 2,
  });

  try {
    await pbPool.query('SELECT 1');
    console.log('Connected to platform-backend DB');
    await devProxyPool.query('SELECT 1');
    console.log('Connected to developer-proxy DB');

    const { rows: sourceRows } = await pbPool.query<{
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
    }>(`
      SELECT
        id, tenant_id, account_id, key_hash, key_prefix, key_hint,
        anthropic_secret_name, name, status,
        last_used_at, created_at, updated_at
      FROM claude_code_proxy_keys
      WHERE deleted_at IS NULL
      ORDER BY created_at ASC
    `);

    console.log(`\nFound ${sourceRows.length} active keys in platform-backend DB`);

    if (sourceRows.length === 0) {
      console.log('Nothing to migrate. Exiting.');
      return;
    }

    let inserted = 0;
    let skipped = 0;

    for (const row of sourceRows) {
      const revoked_at = row.status === 'revoked' ? row.updated_at : null;

      const result = await devProxyPool.query(
        `INSERT INTO developer_proxy_credentials
           (id, tenant_id, user_id, vendor, key_hash, key_prefix, key_hint,
            secret_name, label, status, last_used_at, revoked_at, created_at, updated_at)
         VALUES ($1, $2, $3, 'anthropic', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (key_hash) DO NOTHING`,
        [
          row.id,
          row.tenant_id,
          row.account_id,           // account_id → user_id (TEXT cast is implicit)
          row.key_hash,
          row.key_prefix,
          row.key_hint,
          row.anthropic_secret_name, // secret_name
          row.name,                  // label
          row.status,
          row.last_used_at,
          revoked_at,
          row.created_at,
          row.updated_at,
        ],
      );

      if (result.rowCount === 1) {
        inserted++;
      } else {
        skipped++;
        console.log(`  skip (already exists): ${row.key_prefix}...${row.key_hint}`);
      }
    }

    // Verify
    const { rows: [{ count: destCount }] } = await devProxyPool.query<{ count: string }>(
      `SELECT COUNT(*) FROM developer_proxy_credentials WHERE id = ANY($1)`,
      [sourceRows.map(r => r.id)],
    );

    console.log(`\nMigration complete`);
    console.log(`  Inserted : ${inserted}`);
    console.log(`  Skipped  : ${skipped} (already existed)`);
    console.log(`  Verified : ${destCount}/${sourceRows.length} source keys present in developer-proxy DB`);

    if (parseInt(destCount, 10) !== sourceRows.length) {
      console.error('\nCOUNT MISMATCH — do not proceed with cutover');
      process.exit(1);
    }

    console.log('\nCounts match — safe to flip DEVELOPER_PROXY_SERVICE_ENABLED=new');
  } finally {
    await pbPool.end();
    await devProxyPool.end();
  }
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
