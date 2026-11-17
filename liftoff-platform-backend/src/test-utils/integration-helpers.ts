// Integration Test Helpers
// Provides tenant-scoped and admin-scoped query execution against real Postgres

import { Pool, PoolClient } from 'pg';

const TEST_DB_CONFIG = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5433', 10),
  database: process.env.DB_NAME || 'liftoff_control_test',
  user: process.env.DB_USER || 'liftoff_test',
  password: process.env.DB_PASSWORD || 'test_password',
};

let testPool: Pool | null = null;

/** Get or create the shared test pool */
export function getTestPool(): Pool {
  if (!testPool) {
    testPool = new Pool({
      ...TEST_DB_CONFIG,
      max: 5,
      idleTimeoutMillis: 10000,
    });
  }
  return testPool;
}

/** Close the shared test pool */
export async function closeTestPool(): Promise<void> {
  if (testPool) {
    await testPool.end();
    testPool = null;
  }
}

/**
 * Execute a function with tenant scope set via `SET LOCAL app.current_tenant_id`.
 * Runs inside a transaction — SET LOCAL is automatically cleared on COMMIT/ROLLBACK.
 */
export async function asTenant<T>(
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const pool = getTestPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL app.current_tenant_id = $1', [tenantId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    await client.query('RESET app.current_tenant_id').catch(() => {});
    client.release();
  }
}

/**
 * Execute a function as admin (no tenant scope / BYPASSRLS equivalent).
 * Uses a direct connection without setting app.current_tenant_id.
 * In integration tests, the test user has superuser-like access,
 * so no RLS policies apply unless a tenant scope is set.
 */
export async function asAdmin<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const pool = getTestPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Explicitly reset to ensure no leaked tenant context
    await client.query('RESET app.current_tenant_id');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Truncate all tenant-scoped tables for test isolation.
 * Call in beforeEach() to ensure a clean slate.
 */
export async function cleanTenantData(): Promise<void> {
  const pool = getTestPool();
  // CASCADE handles FK constraints
  await pool.query(`
    DO $$ DECLARE
      r RECORD;
    BEGIN
      FOR r IN (
        SELECT tablename FROM pg_tables
        WHERE schemaname = 'public'
          AND tablename NOT IN ('schema_migrations', 'accounts', 'plans', 'subscriptions', 'staff_roles', 'feature_flags')
      ) LOOP
        EXECUTE 'TRUNCATE TABLE ' || quote_ident(r.tablename) || ' CASCADE';
      END LOOP;
    END $$;
  `);
}

/**
 * Create a test tenant directly in the DB (bypasses application layer).
 * Returns the tenant ID.
 */
export async function createTestTenant(
  client: PoolClient,
  overrides: { id?: string; accountId?: string; name?: string; tier?: string; status?: string } = {},
): Promise<string> {
  const id = overrides.id || crypto.randomUUID();
  const accountId = overrides.accountId || crypto.randomUUID();
  const name = overrides.name || 'Test Tenant';
  const tier = overrides.tier || 'standard';
  const status = overrides.status || 'active';

  await client.query(
    `INSERT INTO tenants (id, account_id, name, tier, status, migration_status)
     VALUES ($1, $2, $3, $4, $5, 'completed')
     ON CONFLICT (id) DO NOTHING`,
    [id, accountId, name, tier, status],
  );

  return id;
}
