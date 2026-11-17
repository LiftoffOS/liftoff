import type { Pool } from 'pg';

export interface PoolStats {
  total: number;
  idle: number;
  waiting: number;
}

/**
 * Extract pool stats from a named set of pg.Pool instances. Useful for
 * exposing /metrics or admin dashboards that show connection-pool health.
 */
export function collectPoolStats(pools: Iterable<[string, Pool]>): Record<string, PoolStats> {
  const out: Record<string, PoolStats> = {};
  for (const [name, pool] of pools) {
    out[name] = {
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
    };
  }
  return out;
}

/** Pool-size resolver that respects the standard env-var override scheme. */
export interface PoolSizeResolverOptions {
  /** Per-service default pool sizes. */
  defaults: Record<string, number>;
  /**
   * Env-var prefix for per-service overrides. Default `DB_POOL_SIZE_`.
   * A service named `tenant-api` reads `${prefix}TENANT_API`.
   */
  envPrefix?: string;
  /**
   * Env var name for a global override across all services. Default `DB_POOL_SIZE`.
   */
  globalEnvVar?: string;
  /** Fallback service name used when a lookup misses `defaults`. Default `default`. */
  fallbackService?: string;
}

/**
 * Resolve the pool size for `service`, honouring (in order):
 *   1. `DB_POOL_SIZE_<SERVICE>` env var (hyphens → underscores, uppercased)
 *   2. `DB_POOL_SIZE` global env var
 *   3. `defaults[service]`
 *   4. `defaults[fallbackService]`
 */
export function resolvePoolSize(
  service: string,
  options: PoolSizeResolverOptions,
): number {
  const envPrefix = options.envPrefix ?? 'DB_POOL_SIZE_';
  const globalEnvVar = options.globalEnvVar ?? 'DB_POOL_SIZE';
  const fallbackService = options.fallbackService ?? 'default';

  const perServiceEnvKey = `${envPrefix}${service.toUpperCase().replace(/-/g, '_')}`;
  const perServiceEnv = process.env[perServiceEnvKey];
  if (perServiceEnv) return parseInt(perServiceEnv, 10);

  const globalEnv = process.env[globalEnvVar];
  if (globalEnv) return parseInt(globalEnv, 10);

  if (service in options.defaults) return options.defaults[service];
  return options.defaults[fallbackService] ?? 5;
}
