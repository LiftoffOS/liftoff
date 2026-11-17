import { Pool, type PoolClient } from 'pg';
import { withTenantScope } from '@liftoffos/database';
import { loadConfig } from './config.js';

let pool: Pool | null = null;

export async function getPool(): Promise<Pool> {
  if (pool) return pool;
  const config = loadConfig();
  const dbHost = `/cloudsql/${config.DB_INSTANCE_CONNECTION_NAME}`;
  pool = new Pool({
    host: dbHost,
    database: config.DB_NAME,
    user: config.DB_USER,
    password: await resolvePassword(config.DB_APP_PASSWORD_SECRET),
    max: 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  return pool;
}

// Tenant-only scope: sets app.current_byok_tenant_id only.
// Used for admin-level operations that span all users in a tenant.
export async function withByokTenant<T>(
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const p = await getPool();
  return withTenantScope(p, tenantId, { rlsVariableName: 'app.current_byok_tenant_id' }, fn);
}

// User-level scope: sets both tenant_id and user_id GUCs.
// Use this for any user-facing credential or usage operation where RLS
// must enforce (tenant_id, user_id) isolation (migration 005).
export async function withByokUser<T>(
  tenantId: string,
  userId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const p = await getPool();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    // SET LOCAL does not accept bind parameters ("syntax error at or near $1");
    // set_config(name, value, is_local=true) is the parameterized equivalent.
    await client.query(`SELECT set_config('app.current_byok_tenant_id', $1, true)`, [tenantId]);
    await client.query(`SELECT set_config('app.current_byok_user_id', $1, true)`, [userId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

async function resolvePassword(secretName: string): Promise<string> {
  if (process.env.NODE_ENV === 'test') {
    return process.env.DB_APP_PASSWORD ?? 'test-password';
  }
  const { SecretManagerServiceClient } = await import('@google-cloud/secret-manager');
  const client = new SecretManagerServiceClient();
  const config = loadConfig();
  const [version] = await client.accessSecretVersion({
    name: `projects/${config.GCP_PROJECT_ID}/secrets/${secretName}/versions/latest`,
  });
  const raw = version.payload?.data;
  const payload = raw ? (typeof raw === 'string' ? raw : Buffer.from(raw as Uint8Array).toString('utf-8')) : undefined;
  if (!payload) throw new Error(`Secret ${secretName} empty or missing payload`);
  return payload;
}
