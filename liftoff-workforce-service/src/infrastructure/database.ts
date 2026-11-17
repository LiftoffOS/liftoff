// Postgres connection pool for liftoff-workforce-service.
//
// The pool is initialised lazily on first call to getPool(). The password is
// fetched from Secret Manager at startup and cached — it never changes at
// runtime. All repository modules call getPool() synchronously after the
// server bootstrap has resolved the pool via initPool().
//
// Cloud SQL connection strategy:
//   - When DB_INSTANCE_CONNECTION_NAME looks like a real Cloud SQL name
//     (project:region:instance), the pool connects via the Unix socket at
//     /cloudsql/<connection-name>.
//   - When it contains "localhost" or starts with "127", the pool connects
//     via TCP so local development and integration tests work without the
//     Cloud SQL proxy.

import { Pool } from 'pg';
import { loadConfig } from './config.js';

let pool: Pool | null = null;

// ── Secret Manager password resolution ─────────────────────────────────

export async function resolvePassword(secretName: string): Promise<string> {
  if (process.env.NODE_ENV === 'test') {
    return process.env.DB_APP_PASSWORD ?? 'test-password';
  }
  // Allow direct injection for local dev without Secret Manager.
  if (process.env.DB_APP_PASSWORD) return process.env.DB_APP_PASSWORD;

  const { SecretManagerServiceClient } = await import('@google-cloud/secret-manager');
  const client = new SecretManagerServiceClient();
  // Reads the project id straight from the environment rather than through
  // loadConfig(). loadConfig validates the whole service contract — including
  // PLATFORM_BACKEND_URL, which Cloud Build sets on the service and Terraform
  // does not set on the maintenance jobs — so resolving a password should not
  // depend on it. Same value either way: loadConfig reads process.env too.
  const projectId = process.env.GCP_PROJECT_ID;
  if (!projectId) throw new Error('GCP_PROJECT_ID is not set');
  const [version] = await client.accessSecretVersion({
    name: `projects/${projectId}/secrets/${secretName}/versions/latest`,
  });
  const raw = version.payload?.data;
  const payload = raw
    ? typeof raw === 'string'
      ? raw
      : Buffer.from(raw as Uint8Array).toString('utf-8')
    : null;
  if (!payload) {
    throw new Error(`Secret ${secretName} empty or missing payload`);
  }
  return payload;
}

// ── Pool init ───────────────────────────────────────────────────────────

function isLocalConnection(connectionName: string): boolean {
  return (
    connectionName.includes('localhost') ||
    connectionName.startsWith('127.') ||
    connectionName === 'local'
  );
}

/**
 * Resolve the connection config. For Cloud SQL (unix socket), set `host` to
 * the socket directory. For local dev, use a standard TCP connection string.
 */
export function buildPoolConfig(
  connectionName: string,
  dbName: string,
  user: string,
  password: string,
): ConstructorParameters<typeof Pool>[0] {
  if (isLocalConnection(connectionName)) {
    return {
      host: 'localhost',
      port: 5432,
      database: dbName,
      user,
      password,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    };
  }

  // Cloud SQL Auth Proxy unix socket.
  return {
    host: `/cloudsql/${connectionName}`,
    database: dbName,
    user,
    password,
    max: 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  };
}

/**
 * Initialise the singleton pool. Must be called once at server startup,
 * before any request handlers can run. Subsequent calls are no-ops.
 */
export async function initPool(): Promise<Pool> {
  if (pool) return pool;

  const config = loadConfig();
  const password = await resolvePassword(config.DB_APP_PASSWORD_SECRET);

  pool = new Pool(
    buildPoolConfig(
      config.DB_INSTANCE_CONNECTION_NAME,
      config.DB_NAME,
      config.DB_USER,
      password,
    ),
  );

  // Verify connectivity immediately so startup fails fast on misconfiguration.
  const client = await pool.connect();
  client.release();

  return pool;
}

/**
 * Return the singleton pool. Throws if initPool() has not yet been called.
 */
export function getPool(): Pool {
  if (!pool) {
    throw new Error(
      'Database pool not initialised — call initPool() during server startup',
    );
  }
  return pool;
}

/**
 * Drain the pool and clear the singleton. Called by the SIGTERM drain
 * sequence in server.ts.
 */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
