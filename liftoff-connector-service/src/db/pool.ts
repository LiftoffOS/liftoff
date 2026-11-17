// Connector-service Postgres pool — backed by @liftoffos/database's
// pool-factory against the connector-pg Cloud SQL instance.
//
// Tenant-scoped helpers use `app.tenant_id` (NOT platform-backend's
// `app.current_tenant_id`) to match migrations 001/002 in this repo.

import { Pool, type PoolClient, type PoolConfig } from 'pg';
import {
  DatabasePoolFactory,
  withTenantScope as libWithTenantScope,
  withAdminScope as libWithAdminScope,
  type AdminScopeContext,
} from '@liftoffos/database';
import { logger } from '../infra/logging.js';

export const RLS_VARIABLE_NAME = 'app.tenant_id';

const SERVICE_CONNECTOR = 'connector';
const SERVICE_CONNECTOR_ADMIN = 'connector_admin';

function parseInstanceConnectionName(env: string | undefined): string | undefined {
  // Cloud SQL connector: socket path `/cloudsql/<project>:<region>:<instance>`.
  return env ? `/cloudsql/${env}` : undefined;
}

function buildBaseConfig(): PoolConfig {
  // Accept both DB_INSTANCE_CONNECTION_NAME (this service's original env name)
  // and CLOUD_SQL_CONNECTION_NAME (the platform-wide convention used by
  // cloudbuild.yaml and every other service). Without both, prod deploys
  // via cloudbuild.yaml fall through to 127.0.0.1:5432 and every DB query
  // fails with ECONNREFUSED — Warm + ListTools happen to dodge the DB on
  // empty inputs, so the outage only surfaces on GetMcpServerConfig /
  // GetCredentials, which makes diagnosis hard.
  const instanceConnectionName = parseInstanceConnectionName(
    process.env.DB_INSTANCE_CONNECTION_NAME ?? process.env.CLOUD_SQL_CONNECTION_NAME,
  );
  const cfg: PoolConfig = {
    database: process.env.DB_NAME ?? 'connector',
    host: instanceConnectionName ?? process.env.DB_HOST ?? '127.0.0.1',
    port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 5432,
    user: process.env.DB_USER ?? 'connector_user',
    password: process.env.DB_PASSWORD ?? '',
  };
  return cfg;
}

async function buildConnectionConfig(serviceType: string): Promise<PoolConfig> {
  const base = buildBaseConfig();
  if (serviceType === SERVICE_CONNECTOR_ADMIN) {
    return {
      ...base,
      user: process.env.DB_ADMIN_USER ?? 'connector_admin',
      password: process.env.DB_ADMIN_PASSWORD ?? base.password,
    };
  }
  return base;
}

const factory = new DatabasePoolFactory({
  servicePoolSizes: {
    [SERVICE_CONNECTOR]: parseInt(process.env.DB_POOL_SIZE_CONNECTOR ?? '10', 10),
    [SERVICE_CONNECTOR_ADMIN]: parseInt(process.env.DB_POOL_SIZE_CONNECTOR_ADMIN ?? '2', 10),
  },
  buildConnectionConfig,
  logger: {
    debug: (ctx, msg) => logger.debug(ctx, msg),
    info: (ctx, msg) => logger.info(ctx, msg),
    warn: (ctx, msg) => logger.warn(ctx, msg),
    error: (ctx, msg) => logger.error(ctx, msg),
  },
});

export async function getPool(): Promise<Pool> {
  return factory.getPool(SERVICE_CONNECTOR);
}

export async function getAdminPool(): Promise<Pool> {
  return factory.getPool(SERVICE_CONNECTOR_ADMIN);
}

export async function withTenantScope<T>(
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const pool = await getPool();
  return libWithTenantScope(pool, tenantId, { rlsVariableName: RLS_VARIABLE_NAME }, fn);
}

export async function withAdminScope<T>(
  ctx: AdminScopeContext,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const pool = await getAdminPool();
  return libWithAdminScope(pool, ctx, { rlsVariableName: RLS_VARIABLE_NAME }, fn);
}

export async function closeAllPools(): Promise<void> {
  await factory.closeAll();
}
