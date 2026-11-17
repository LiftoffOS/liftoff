// Database Pool
//
// Singleton pg Pool used by all repository modules. Initialised lazily on
// first call to getPool(). Tests can call _resetPool() to force a new
// instance.
//
// Cloud SQL connection strategy (same as database.ts):
//   - When DB_INSTANCE_CONNECTION_NAME looks like a real Cloud SQL name
//     (project:region:instance), connects via Unix socket at
//     /cloudsql/<connection-name>.
//   - When it contains "localhost" or starts with "127", connects via TCP
//     for local development and integration tests.

import { Pool } from 'pg';
import { loadConfig } from './config.js';

let _pool: Pool | null = null;

function buildConnectionConfig(password: string): ConstructorParameters<typeof Pool>[0] {
  const config = loadConfig();
  const connectionName = config.DB_INSTANCE_CONNECTION_NAME;
  const isLocal =
    connectionName.includes('localhost') ||
    connectionName.startsWith('127.') ||
    connectionName === 'local';

  if (isLocal) {
    return {
      host: 'localhost',
      port: 5432,
      database: config.DB_NAME,
      user: config.DB_USER,
      password,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    };
  }

  return {
    host: `/cloudsql/${connectionName}`,
    database: config.DB_NAME,
    user: config.DB_USER,
    password,
    max: 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  };
}

export function getPool(password = process.env.DB_APP_PASSWORD ?? ''): Pool {
  if (_pool) return _pool;
  _pool = new Pool(buildConnectionConfig(password));
  return _pool;
}

/** Reset the pool — for tests only. */
export async function _resetPool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}
