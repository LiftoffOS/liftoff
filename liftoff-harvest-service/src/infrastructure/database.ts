import { Pool, PoolConfig } from 'pg';
import { log } from './logging';

let poolInstance: Pool | null = null;

/**
 * Build a Pool config from env. Cloud Run + Cloud SQL Auth Proxy uses a
 * Unix socket mounted at `/cloudsql/<connection-name>`. When DB_SOCKET_PATH
 * is set we hand it to pg as `host` (pg detects the leading `/` and uses
 * Unix-domain sockets); otherwise we fall back to TCP via DB_HOST/DB_PORT.
 */
function buildPoolConfig(): PoolConfig {
  const database = process.env.DB_NAME ?? 'harvest';
  const user = process.env.DB_USER ?? 'harvest_app';
  const password = process.env.DB_PASSWORD ?? '';

  const socketPath = process.env.DB_SOCKET_PATH;
  if (socketPath) {
    return {
      host: socketPath,
      database,
      user,
      password,
    };
  }

  return {
    host: process.env.DB_HOST ?? 'localhost',
    port: parseInt(process.env.DB_PORT ?? '5432', 10),
    database,
    user,
    password,
  };
}

export function getPool(): Pool {
  if (poolInstance) return poolInstance;
  const config = buildPoolConfig();
  const pool = new Pool(config);
  pool.on('error', (err) => {
    log.error({ error: err.message }, 'pg pool error');
  });
  poolInstance = pool;
  return pool;
}

export async function closePool(): Promise<void> {
  if (poolInstance) {
    await poolInstance.end();
    poolInstance = null;
  }
}
