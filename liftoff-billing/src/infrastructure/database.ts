// Postgres connection pool for liftoff-billing. Every tenant-scoped
// query runs through `@liftoffos/database.withTenantContext` which
// binds `app.current_tenant_id` for RLS enforcement (plan 0h).

import { Pool, type PoolClient } from 'pg';
import { withTenantScope } from '@liftoffos/database';
import type { TenantScopedClient } from '@liftoffos/database';
import { loadConfig } from './config.js';

let pool: Pool | null = null;
let outboxPool: Pool | null = null;

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
    keepAlive: true,
    keepAliveInitialDelayMillis: 5_000,
  });
  return pool;
}

// Separate pool dedicated to the OutboxPublisher worker so it never competes
// with request handlers for connections. `Connection terminated due to connection
// timeout` errors observed 2026-05-14T00:03 and 2026-05-15T04:40 traced to the
// shared pool plus missing TCP keepalive on the Cloud SQL Unix socket.
export async function getOutboxPool(): Promise<Pool> {
  if (outboxPool) return outboxPool;
  const config = loadConfig();
  const dbHost = `/cloudsql/${config.DB_INSTANCE_CONNECTION_NAME}`;
  outboxPool = new Pool({
    host: dbHost,
    database: config.DB_NAME,
    user: config.DB_USER,
    password: await resolvePassword(config.DB_APP_PASSWORD_SECRET),
    max: 2,
    idleTimeoutMillis: 60_000,
    connectionTimeoutMillis: 5_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 5_000,
  });
  return outboxPool;
}

export async function withBillingTenant<T>(
  tenantId: string,
  fn: (client: TenantScopedClient) => Promise<T>,
): Promise<T> {
  const p = await getPool();
  return withTenantScope(p, tenantId, { rlsVariableName: 'app.current_tenant_id' }, fn);
}

/**
 * The other door: work that spans every tenant, with the reason on the record.
 *
 * Some reads genuinely cannot be tenant-scoped — a sweep over all pending
 * credits, or a lookup keyed by an invoice whose tenant is what we are trying to
 * discover. Those used to be written as a raw `pool.query`, which is the same
 * shape as simply forgetting to scope, and the difference lived in a comment.
 * This makes the intent a call rather than a comment: greppable, countable, and
 * impossible to drift out of step with the code beneath it.
 *
 * It also makes the lane deterministic. `app.current_tenant_id` can never return
 * to NULL once set — Postgres leaves it as '' — so on a pooled connection that
 * previously served a tenant, a policy written against NULL silently stops
 * matching and `''::uuid` raises. Setting '' explicitly means the behaviour no
 * longer depends on that connection's history. Migration 027 teaches the
 * referral_credits policies to read '' as unbound.
 *
 * `reason` is not decoration: it is attached to any failure, so a stack trace
 * says which cross-tenant path broke and why it was allowed to be one.
 */
export async function withCrossTenant<T>(
  reason: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const p = await getPool();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_tenant_id', '', true)");
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* the original error matters more */ }
    if (err instanceof Error) err.message = `cross-tenant (${reason}): ${err.message}`;
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Claims the brand for a client the caller has already scoped.
 *
 * withBillingTenant mints the brand; this asserts it. The distinction matters,
 * so there should be very few of these and each should sit directly beneath the
 * statement that established the scope.
 *
 * It exists because the outbox consumer comes from @liftoffos/outbox, which
 * knows nothing about tenants: it hands back a plain client and the scope is set
 * by hand immediately before dispatch. A bare `as TenantScopedClient` would do
 * the same job invisibly. A named call is greppable, so `git grep asTenantScoped`
 * answers "where do we take scope on trust?" in one line — which is the question
 * the ten `rls-fence: allow` comments used to answer badly.
 */
export function asTenantScoped(client: PoolClient): TenantScopedClient {
  return client as TenantScopedClient;
}

export async function closePool(): Promise<void> {
  if (pool)       { await pool.end();       pool = null; }
  if (outboxPool) { await outboxPool.end(); outboxPool = null; }
}

// Secret Manager lookup — returns the secret latest version's payload.
// Dynamically imported to keep the module tree-shakable in tests.
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
  if (!payload) {
    throw new Error(`Secret ${secretName} empty or missing payload`);
  }
  return payload;
}
