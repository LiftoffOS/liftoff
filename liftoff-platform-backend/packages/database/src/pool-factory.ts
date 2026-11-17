// Generic Postgres pool factory for Liftoff platform services.
//
// Each service passes a `ServiceType` taxonomy + connection-string builder
// and gets back per-service pools with the standard Liftoff connection
// hygiene (keepAlive, idle eviction off for long-lived Cloud Run instances,
// generous connection timeout to survive Cloud SQL proxy warm-up).
//
// Two auth patterns the factory supports via the buildConnectionConfig
// callback:
//   - Unix socket (platform-backend): returns { host: '/cloudsql/<name>', ... }
//     and fetches the password from Secret Manager on first use
//   - Direct IP (tenant-runtime): returns { host: env DB_HOST, password: env
//     DB_PASSWORD, ... }
//
// The factory itself is stateless — it stores pools in a Map keyed by
// serviceType, so multiple services in the same process can each have
// isolated pools without leaking connections across them.

import { Pool, type PoolConfig } from 'pg';
import { installBorrowedClientGuard } from './borrowed-client-guard.js';
import { resolvePoolSize, type PoolSizeResolverOptions } from './pool-stats.js';

export type Logger = {
  debug?: (ctx: Record<string, unknown>, msg: string) => void;
  info: (ctx: Record<string, unknown>, msg: string) => void;
  warn: (ctx: Record<string, unknown>, msg: string) => void;
  error: (ctx: Record<string, unknown>, msg: string) => void;
};

export interface PoolFactoryOptions {
  /** Per-service default pool sizes. Keys form the ServiceType taxonomy. */
  servicePoolSizes: Record<string, number>;
  /**
   * Builds the pg Pool config for a given service. Called the first time
   * each service's pool is requested. Async so it can fetch a password
   * from Secret Manager.
   */
  buildConnectionConfig: (serviceType: string) => Promise<PoolConfig>;
  /** Pool-size resolver overrides. Default uses DB_POOL_SIZE_* env vars. */
  poolSizeResolver?: Partial<PoolSizeResolverOptions>;
  /** Logger for pool lifecycle and connection events. */
  logger?: Logger;
  /**
   * Override the pg Pool constructor — used by tests to inject a stub
   * without standing up a real DB.
   */
  poolCtor?: new (config: PoolConfig) => Pool;
}

/** Defaults applied on top of buildConnectionConfig. Tuned for Cloud Run. */
const CLOUD_RUN_DEFAULTS: Partial<PoolConfig> = {
  // Long-lived Cloud Run instances benefit from never evicting idle
  // connections — otherwise the next request pays the TCP/TLS handshake.
  idleTimeoutMillis: 0,
  // Cloud SQL proxy handshake can take a few seconds on a cold socket.
  connectionTimeoutMillis: 30_000,
  // TCP keepalive prevents intermediate network components from marking
  // idle connections as stale.
  keepAlive: true,
  keepAliveInitialDelayMillis: 5_000,
};

export class DatabasePoolFactory {
  private readonly pools = new Map<string, Pool>();
  private readonly options: PoolFactoryOptions;
  private readonly PoolCtor: new (config: PoolConfig) => Pool;

  constructor(options: PoolFactoryOptions) {
    this.options = options;
    this.PoolCtor = options.poolCtor ?? Pool;
  }

  /**
   * Return (and cache) the pool for a service. Async because the first
   * call builds the connection config (which may fetch a secret).
   */
  async getPool(serviceType: string): Promise<Pool> {
    const existing = this.pools.get(serviceType);
    if (existing) return existing;

    const connCfg = await this.options.buildConnectionConfig(serviceType);
    const poolSize = resolvePoolSize(serviceType, {
      defaults: this.options.servicePoolSizes,
      ...this.options.poolSizeResolver,
    });

    const pool = new this.PoolCtor({
      ...CLOUD_RUN_DEFAULTS,
      ...connCfg,
      max: poolSize,
    });

    pool.on('error', (err) => {
      this.options.logger?.error(
        { serviceType, error: err.message },
        'Unexpected database pool error',
      );
    });
    pool.on('connect', () => {
      this.options.logger?.debug?.(
        {
          serviceType,
          total: pool.totalCount,
          idle: pool.idleCount,
          waiting: pool.waitingCount,
        },
        'Database connection acquired',
      );
    });
    pool.on('remove', () => {
      this.options.logger?.debug?.(
        {
          serviceType,
          total: pool.totalCount,
          idle: pool.idleCount,
          waiting: pool.waitingCount,
        },
        'Database connection removed',
      );
    });

    // Every handler above fires for IDLE clients only. pg-pool removes its own
    // error listener the moment a client is checked out, so a borrowed client
    // that errors is an unhandled 'error' event and Node exits the process.
    // Installed at construction, because a pool this factory hands out is
    // borrowed at ~21 sites in platform-backend alone and every one of them was
    // a process-kill site until this existed. See borrowed-client-guard.ts.
    installBorrowedClientGuard(pool, {
      ...(this.options.logger ? { logger: this.options.logger } : {}),
      serviceType,
    });

    this.pools.set(serviceType, pool);
    this.options.logger?.info(
      { serviceType, poolSize },
      'Database pool created',
    );
    return pool;
  }

  /** All currently-open pools as (name, pool) pairs. Useful for pool stats. */
  entries(): Array<[string, Pool]> {
    return Array.from(this.pools.entries());
  }

  /**
   * Pre-warm pools by acquiring and releasing one connection each. Call
   * during startup before the HTTP server accepts traffic so the first
   * request doesn't pay the cold-socket handshake.
   */
  async warmPools(services: string[]): Promise<void> {
    for (const svc of services) {
      try {
        const pool = await this.getPool(svc);
        const client = await pool.connect();
        await client.query('SELECT 1');
        client.release();
        this.options.logger?.info({ serviceType: svc }, 'Pool pre-warmed');
      } catch (err) {
        this.options.logger?.warn(
          { serviceType: svc, error: (err as Error).message },
          'Pool pre-warm failed (will retry on first query)',
        );
      }
    }
  }

  /** Cleanly close all open pools. Call on graceful shutdown. */
  async closeAll(): Promise<void> {
    const promises: Array<Promise<void>> = [];
    for (const [serviceType, pool] of this.pools) {
      this.options.logger?.info({ serviceType }, 'Closing database pool');
      promises.push(pool.end());
    }
    await Promise.all(promises);
    this.pools.clear();
  }
}
