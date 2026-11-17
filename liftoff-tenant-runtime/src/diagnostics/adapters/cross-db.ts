// Cross-service read-only DB access for the diagnostics harness.
//
// The harness CODE lives in tenant-runtime (the largest surface) but evaluates
// runs from THREE runtimes. tenant-runtime's own pools (getPoolForService) only
// reach the tenant-runtime DB; the workforce-service and platform-backend
// adapters need read-only access to THOSE services' stores.
//
// Per the plan's SA/IAM section, the harness SA is granted "read-only access to
// all three service DBs". We model that here with dedicated read-only pools
// built from connection strings supplied via env (Secret Manager-injected):
//   - DIAGNOSTICS_WORKFORCE_DB_URL   → workforce-service DB (read replica/role)
//   - DIAGNOSTICS_INSIGHTS_DB_URL    → platform-backend DB  (read replica/role)
//
// If a URL is unset the corresponding adapter is unavailable (the driver logs a
// coverage gap rather than crashing) — this keeps P1 (tenant-runtime only)
// runnable before P2 cross-DB access is wired.

import { Pool } from 'pg';
import { logger as log } from '../../infrastructure/logging';

export type CrossService = 'workforce' | 'insights';

const ENV_VAR: Record<CrossService, string> = {
  workforce: 'DIAGNOSTICS_WORKFORCE_DB_URL',
  insights: 'DIAGNOSTICS_INSIGHTS_DB_URL',
};

const pools = new Map<CrossService, Pool>();

/** Returns a lazily-created read-only pool for a cross-service DB, or null when
 *  its connection string is not configured (adapter unavailable). */
export function getCrossServicePool(service: CrossService): Pool | null {
  if (pools.has(service)) return pools.get(service)!;
  const url = process.env[ENV_VAR[service]];
  if (!url) {
    log.warn({ message: 'diagnostics: cross-service DB URL not configured', service, envVar: ENV_VAR[service] });
    return null;
  }
  // Small pool — passive eval is low-volume (four agent types, not a firehose).
  const pool = new Pool({ connectionString: url, max: 4, idleTimeoutMillis: 30_000 });
  pool.on('error', (err) => log.warn({ message: 'diagnostics cross-service pool error', service, err: err.message }));
  pools.set(service, pool);
  return pool;
}

export async function closeCrossServicePools(): Promise<void> {
  for (const [, pool] of pools) await pool.end().catch(() => undefined);
  pools.clear();
}
