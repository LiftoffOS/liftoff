// Governance-engine database — slim pool + tenant-scope helpers.
// Derived from tenant-runtime/src/infrastructure/database.ts. Trimmed of
// the service-type pool map (governance-engine is a single service).

import { Pool, PoolClient } from 'pg';
import {
  withTenantScope as pkgWithTenantScope,
  collectPoolStats,
  resolvePoolSize,
} from '@liftoffos/database';
import { logger } from './logging';

export type ServiceType = 'governance-engine' | 'default';

const DEFAULT_POOL_SIZES: Record<ServiceType, number> = {
  'governance-engine': 15,
  default: 10,
};

const servicePools: Map<ServiceType, Pool> = new Map();

function getPoolSizeForService(service: ServiceType): number {
  return resolvePoolSize(service, { defaults: DEFAULT_POOL_SIZES });
}

/** Resolve the DB host.
 *  Cloud Run mounts the Cloud SQL Unix socket at /cloudsql/<connection_name>.
 *  Pass host as a socket directory path so pg connects without TCP. */
function resolveDbHost(): string {
  if (process.env.DB_HOST) return process.env.DB_HOST;
  const connName = process.env.CLOUD_SQL_CONNECTION_NAME || process.env.DB_INSTANCE_CONNECTION_NAME;
  if (connName) return `/cloudsql/${connName}`;
  return '127.0.0.1';
}

function createServicePool(service: ServiceType): Pool {
  if (process.env.NODE_ENV !== 'test' && !process.env.DB_PASSWORD) {
    throw new Error(
      `createServicePool(${service}) called before DB_PASSWORD was set. ` +
        `Ensure secrets are loaded before any getPool()/pool call.`,
    );
  }

  const host = resolveDbHost();
  const poolSize = getPoolSizeForService(service);

  logger.info(
    {
      service,
      poolSize,
      host,
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
    },
    'Creating database pool',
  );

  const newPool = new Pool({
    host,
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME || 'governance_engine',
    user: process.env.DB_USER || 'governance_app',
    password: process.env.DB_PASSWORD || '',
    max: poolSize,
    idleTimeoutMillis: 0,
    connectionTimeoutMillis: 30_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 5000,
  });

  newPool.on('error', (err) => {
    logger.error({ service, error: err.message }, 'Unexpected database error');
  });

  return newPool;
}

export function getPoolForService(service: ServiceType): Pool {
  let servicePool = servicePools.get(service);
  if (!servicePool) {
    servicePool = createServicePool(service);
    servicePools.set(service, servicePool);
  }
  return servicePool;
}

export function getPool(): Pool {
  return getPoolForService('default');
}

// Legacy `pool` export used throughout the ported modules.
export const pool = new Proxy({} as Pool, {
  get(_, prop) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (getPool() as any)[prop];
  },
});

/**
 * Execute a function within a tenant-scoped transaction. Uses the
 * `app.current_tenant_id` RLS variable name (per Phase 3 plan §3c and
 * platform-backend migration 095 convention — matches everywhere except
 * the older tenant-runtime inline governance path which still uses the
 * legacy `app.tenant_id` name until that caller is fully migrated).
 */
export function withTenantScope<T>(
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>,
  service: ServiceType = 'default',
): Promise<T> {
  const p = getPoolForService(service);
  return pkgWithTenantScope(
    p,
    tenantId,
    { rlsVariableName: 'app.current_tenant_id' },
    fn,
  );
}

export async function closePools(): Promise<void> {
  const closePromises: Promise<void>[] = [];
  for (const [service, servicePool] of servicePools) {
    logger.info({ service }, 'Closing database pool');
    closePromises.push(servicePool.end());
  }
  await Promise.all(closePromises);
  servicePools.clear();
}

export function getPoolStats(): Record<
  string,
  { total: number; idle: number; waiting: number }
> {
  return collectPoolStats(servicePools.entries());
}
