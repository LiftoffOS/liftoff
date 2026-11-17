// Tenant-runtime database — pool factory stays local (all-sync, env-var
// config) while withTenantScope + pool-stats helpers delegate to
// @liftoffos/database.

import { Pool, PoolClient } from 'pg';
import {
  withTenantScope as pkgWithTenantScope,
  collectPoolStats,
  // If typecheck says @liftoffos/database has no such export, the package has not
  // been published yet — the guard lives there because it is ONE implementation of
  // a property two services need, and this repo consumes the package from the
  // registry rather than as a workspace. Publish it from platform-backend's `main`
  // and bump this repo's lockfile; the ordering is step 3 of
  // platform-backend/docs/runbooks/TURN_LOCK_HEARTBEAT_ROLLOUT.md.
  //
  // Do NOT resolve it by vendoring a copy here or by deleting the install below.
  // A second copy is the defect INV-PB-018 is about, and deleting the install
  // silently reopens the window where a dropped socket exits the container.
  installBorrowedClientGuard,
  resolvePoolSize,
} from '@liftoffos/database';
import { logger } from './logging';
import { getManagedSecret } from './secret-store';

export type DbTransaction = PoolClient;

export type ServiceType =
  | 'coordinator'
  | 'tenant-api'
  | 'action-ledger'
  | 'usage-ledger'
  | 'reflection-engine'
  | 'tool-gateway'
  | 'connectors'
  | 'instruction-compiler'
  | 'event-subscriber'
  | 'scheduled-execution'
  // Readiness probing only. Its own pool so a saturated default pool cannot
  // make a healthy instance report itself unready — which would pull it out of
  // rotation at exactly the moment load is highest.
  | 'readiness'
  | 'default';

// Per-service connection caps. Sized so that with `--max-instances 10` on
// agent-service the worst-case total stays under Cloud SQL's 400-backend
// ceiling (10 instances × ~60 = ~600 nominal, ~200 typical because each
// instance only opens the pools it actually uses). `scheduled-execution`
// and `tenant-api` are the hot paths during cron bursts — both are
// invoked per scheduled agent firing and each invocation acquires
// connections concurrently for memory lookup + cache + tool dispatch.
const SERVICE_POOL_SIZES: Record<ServiceType, number> = {
  coordinator: 15,
  'tenant-api': 18,
  'action-ledger': 12,
  'usage-ledger': 10,
  'tool-gateway': 8,
  connectors: 8,
  'instruction-compiler': 6,
  'reflection-engine': 5,
  'event-subscriber': 8,
  'scheduled-execution': 20,
  // Two: one for the probe in flight, one so a stuck connection does not mean
  // the next probe has nowhere to go. It must never be a source of load.
  readiness: 2,
  // `default` is the hottest pool: legacy `pool` proxy + every code path
  // that does `pool.query(...)` directly (audit, embedding cache, billing
  // reconciliation, reactive subscriptions, web-fetch admission, etc.).
  // Pool-stats observability shows the default pool is the saturation point
  // under cron-burst load, not scheduled-execution.
  default: 25,
};

const servicePools: Map<ServiceType, Pool> = new Map();

function getPoolSizeForService(service: ServiceType): number {
  return resolvePoolSize(service, { defaults: SERVICE_POOL_SIZES });
}

function buildConnectionString(): string {
  const host = process.env.DB_HOST || '10.208.0.3';
  const port = process.env.DB_PORT || '5432';
  const database = process.env.DB_NAME || 'tenant_runtime';
  const user = process.env.DB_USER || 'tenant_app';
  const password = getManagedSecret('DB_PASSWORD') || '';
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(
    password,
  )}@${host}:${port}/${database}`;
}

function createServicePool(service: ServiceType): Pool {
  // Defensive guard: creating a pool with an empty password bakes an empty
  // password into the pg Pool's connection string, after which SASL auth
  // always fails with "client password must be a string". Fail loudly at pool
  // creation time rather than silently hanging every query for 5 minutes of
  // schema-check polling. Bypass this in tests where NODE_ENV=test.
  if (process.env.NODE_ENV !== 'test' && !getManagedSecret('DB_PASSWORD')) {
    throw new Error(
      `createServicePool(${service}) called before DB_PASSWORD was available. ` +
      `The services no longer bind it at exec (a variable present at execve is ` +
      `in /proc/1/environ for the life of the process and no code can remove ` +
      `it), so the only supply path is loadSecretsToEnv() completing before ` +
      `any getPoolForService() call. The Cloud Run JOBS still bind it, because ` +
      `their entrypoints do not hydrate.`,
    );
  }

  const poolSize = getPoolSizeForService(service);
  const connectionString = buildConnectionString();

  logger.info(
    {
      service,
      poolSize,
      host: process.env.DB_HOST || '10.208.0.3',
      port: process.env.DB_PORT || '5432',
      database: process.env.DB_NAME || 'tenant_runtime',
      user: process.env.DB_USER || 'tenant_app',
    },
    'Creating database pool with connection string',
  );

  const newPool = new Pool({
    connectionString,
    max: poolSize,
    // Recycle idle connections after 30s. Originally 0 (never), which meant
    // Cloud SQL/VPC NAT idle-drops left dead TCP sockets in the pool — the
    // next caller would query a black-holed socket and hang until OS TCP
    // keepalive fired (~2h on Linux). It shows up as a slow connection leak in
    // pool_client_held_too_long instrumentation: a sub-millisecond PK lookup
    // hanging for over a minute.
    // 30s is short enough to beat Cloud SQL's 10-min idle timeout and any
    // sensible NAT timeout while still keeping warm connections during bursts.
    idleTimeoutMillis: 30_000,
    // Fail-fast on pool saturation. 30s lets cron-fired requests pile up on
    // a saturated instance until the request itself times out at the gateway,
    // hiding the real symptom (under-provisioned pool / under-scaled service).
    // 5s surfaces saturation in logs immediately and lets the caller retry.
    connectionTimeoutMillis: 5_000,
    // Hard cap on any single query. Defense in depth against future "dead
    // socket → hang forever" patterns: if a query somehow survives past
    // idleTimeoutMillis (e.g. checked-out client with active TCP but server
    // is unresponsive), pg aborts it after 30s instead of holding the
    // connection indefinitely. 30s is well above the p99 of any query we run.
    query_timeout: 30_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 5000,
  });

  newPool.on('error', (err) => {
    logger.error({ service, error: err.message }, 'Unexpected database error');
  });

  // The handler above fires for IDLE clients only. pg-pool removes its own error
  // listener the moment a client is checked out (pg-pool/index.js:344), so from
  // then until release a borrowed client has none — and in Node an 'error' event
  // with no listener is thrown, which on Cloud Run is the container exiting.
  //
  // If every Postgres socket on an instance closes at once (even while Cloud SQL
  // is healthy and nothing is draining), `Connection terminated unexpectedly`
  // lands on a borrowed client and `Container called exit(1)` follows within
  // milliseconds — taking every in-flight request and every cron with it, and
  // possibly leaving a chat-turn lock behind that wedges a conversation. This
  // service is especially exposed: it holds a client for the WHOLE of an agent
  // execution (cloud-tasks-handler keeps the scheduled-execution lockClient
  // checked out to hold its advisory lock), which is the longest borrow there is.
  //
  // Off the pool's own acquire/release/remove events rather than by wrapping
  // connect, because `pool.query()` calls `this.connect(cb)` in callback mode and
  // a wrapper that awaits the result threw on every pool.query() in this service
  // once already — see the BUG-FIX note in the connect wrapper below.
  installBorrowedClientGuard(newPool, { logger, serviceType: service });

  newPool.on('connect', () => {
    logger.debug(
      {
        service,
        total: newPool.totalCount,
        idle: newPool.idleCount,
        waiting: newPool.waitingCount,
      },
      'Database connection acquired',
    );
  });

  newPool.on('remove', () => {
    logger.debug(
      {
        service,
        total: newPool.totalCount,
        idle: newPool.idleCount,
        waiting: newPool.waitingCount,
      },
      'Database connection removed',
    );
  });

  // Connection-leak detector. Wrap pool.connect() so every checkout records
  // the call stack and acquire time; patch the returned client's release() to
  // clear the record. Every 30s, scan for clients still held > LEAK_THRESHOLD_MS
  // and emit a structured warning with the acquire stack — that names the
  // exact call site that's failing to release. Adds ~1 Map insert/delete per
  // connect/release; cost is negligible at our scale.
  // 5 min threshold rather than 60s: cloud-tasks-handler.ts:210 holds the
  // scheduled-execution lockClient for the entire agent execution to keep
  // the per-agent advisory lock (pg releases session-locks on connection
  // return, so the lock dies if the connection is recycled mid-run). Typical
  // agent runs are 30-90s and tail to ~3 min for SDK-engine tool sequences.
  // A 60s threshold fired on every legitimate execution; 300s lets normal
  // work finish quietly while still catching real leaks (which never release
  // and therefore live forever).
  const LEAK_THRESHOLD_MS = Number(process.env.DB_POOL_LEAK_THRESHOLD_MS ?? 300_000);
  type InflightInfo = { acquiredAt: number; stack: string; warned: boolean };
  const inflight = new Map<PoolClient, InflightInfo>();
  // Capture the original BEFORE wrapping, bound to the actual pool so
  // pool.query()'s internal `this.connect(cb)` calls don't lose context.
  const origConnect = newPool.connect.bind(newPool) as {
    (cb: (err: Error | undefined, client: PoolClient, done: (release?: unknown) => void) => void): void;
    (): Promise<PoolClient>;
  };

  function wrap(client: PoolClient, captureAt: number, stack: string): PoolClient {
    inflight.set(client, { acquiredAt: captureAt, stack, warned: false });
    const origRelease = client.release.bind(client);
    (client as unknown as { release: typeof origRelease }).release = function (err?: Error | boolean): void {
      inflight.delete(client);
      return origRelease(err as Error | boolean | undefined);
    };
    return client;
  }

  (newPool as unknown as { connect: (...args: unknown[]) => unknown }).connect = function (
    ...args: unknown[]
  ): Promise<PoolClient> | void {
    // CRITICAL: capture stack BEFORE the await. After `await origConnect()`
    // we're in a fresh microtask context and the original caller's frames
    // are gone — V8 only preserves the synchronous portion of the stack at
    // Error-construction time. Capturing pre-await means the stack still
    // contains the actual caller of pool.connect().
    const captureAt = Date.now();
    const stack = (new Error('pool.connect').stack ?? '')
      .split('\n')
      .slice(2, 12)
      .join('\n');

    // BUG-FIX: node-postgres's Pool.query() internally calls
    // `this.connect((err, client, done) => …)` with a callback. When the
    // pool's connect is invoked with a function as its last arg, pg-pool
    // uses the callback API and returns undefined (not a Promise). The
    // prior wrapper did `await origConnect(...args)` unconditionally,
    // which produced undefined → "non-PoolClient" → threw on every single
    // pool.query() call across the service. Detect the callback-mode call
    // and translate it through our leak detector while preserving pg's
    // callback contract for the inner caller.
    const last = args[args.length - 1];
    if (typeof last === 'function') {
      const userCb = last as (err: Error | undefined, client: PoolClient | undefined, done: (release?: unknown) => void) => void;
      origConnect((err, client, done) => {
        if (err) {
          logger.warn(
            { event: 'pool_connect_failed', service, err: err.message, captureStack: stack },
            'pool.connect (cb) rejected',
          );
          userCb(err, undefined, done);
          return;
        }
        if (!client || typeof client.release !== 'function') {
          logger.error(
            { event: 'pool_connect_unexpected_resolve', service, client: typeof client, captureStack: stack },
            'pool.connect (cb) resolved with non-client',
          );
          userCb(new Error('pool.connect (cb) resolved with non-PoolClient'), undefined, done);
          return;
        }
        wrap(client, captureAt, stack);
        userCb(undefined, client, done);
      });
      return;
    }

    // Promise mode — the only way to reach here is no-arg `pool.connect()`.
    return (async () => {
      let client: PoolClient;
      try {
        client = await (origConnect as () => Promise<PoolClient>)();
      } catch (err) {
        logger.warn(
          { event: 'pool_connect_failed', service, err: (err as Error).message, captureStack: stack },
          'pool.connect rejected',
        );
        throw err;
      }
      if (!client || typeof client.release !== 'function') {
        logger.error(
          { event: 'pool_connect_unexpected_resolve', service, client: typeof client, captureStack: stack },
          'pool.connect resolved with non-client',
        );
        throw new Error(`pool.connect resolved with non-PoolClient: ${typeof client}`);
      }
      return wrap(client, captureAt, stack);
    })();
  };
  setInterval(() => {
    const now = Date.now();
    for (const [, info] of inflight) {
      const ageMs = now - info.acquiredAt;
      if (ageMs > LEAK_THRESHOLD_MS && !info.warned) {
        logger.warn(
          { event: 'pool_client_held_too_long', service, ageMs, acquireStack: info.stack },
          'pool_client_held_too_long',
        );
        info.warned = true; // suppress repeats for this same client
      }
    }
  }, 30_000).unref();

  logger.info({ service, poolSize }, 'Database pool created');
  return newPool;
}

export async function warmPools(): Promise<void> {
  const poolsToWarm: ServiceType[] = ['event-subscriber', 'scheduled-execution', 'default'];
  for (const service of poolsToWarm) {
    try {
      const pool = getPoolForService(service);
      const client = await pool.connect();
      await client.query('SELECT 1');
      client.release();
      logger.info({ service }, 'Pool pre-warmed');
    } catch (error) {
      logger.warn(
        { service, error: (error as Error).message },
        'Pool pre-warm failed (will retry on first query)',
      );
    }
  }
}

/**
 * A pool for a service, created on FIRST USE rather than on this call.
 *
 * Fourteen modules do `const pool = getPoolForService('default')` at the top
 * level, which runs during `require` — long before `main()` reaches
 * `loadSecretsToEnv()`. That was survivable only while DB_PASSWORD was bound at
 * execve by `--set-secrets`, because then it was in the environment before any
 * code ran at all.
 *
 * It is not bound any more (a variable present at execve sits in
 * /proc/1/environ for the life of the process and no code can remove it), so
 * building the pool eagerly means building it with no password: coordinator-service
 * died on boot with "createServicePool(event-subscriber) called before
 * DB_PASSWORD was available", from a `require` chain three modules deep.
 *
 * The returned object is a Proxy that makes the real pool the first time anyone
 * touches it. Every caller keeps `pool.query(...)`, no call site changes, and
 * the module-load hazard stops being something fourteen files have to remember.
 * The password check in `createServicePool` still runs — just at first query,
 * which is after boot, which is when it can actually pass.
 */
export function getPoolForService(service: ServiceType): Pool {
  const existing = servicePools.get(service);
  if (existing) return existing;

  const realise = (): Pool => {
    let made = servicePools.get(service);
    if (!made) {
      made = createServicePool(service);
      servicePools.set(service, made);
    }
    return made;
  };

  // `{}` as the target: the trap never consults it, and a real Pool as the
  // target would defeat the point by constructing one here.
  return new Proxy({} as Pool, {
    get(_t, prop, receiver) {
      const value = Reflect.get(realise() as object, prop, receiver);
      // Methods are bound to the pool, not to the proxy: `pool.query` is
      // routinely passed around detached (`.then(pool.query)`, destructuring in
      // a repository), and an unbound one loses `this`.
      return typeof value === 'function' ? value.bind(realise()) : value;
    },
    set(_t, prop, value) {
      return Reflect.set(realise() as object, prop, value);
    },
    has(_t, prop) {
      return Reflect.has(realise() as object, prop);
    },
    getPrototypeOf() {
      return Reflect.getPrototypeOf(realise() as object);
    },
  });
}

export function getPool(): Pool {
  return getPoolForService('default');
}

// Bounded pools created via createBoundedPool. Tracked so closePools() ends them
// on shutdown alongside the service pools.
const boundedPools = new Set<Pool>();

/** A small dedicated pool with a hard server-side statement_timeout, for
 *  best-effort side reads on the request-completion path that must never hang
 *  or hold a shared connection. The server aborts any query past
 *  statementTimeoutMs; query_timeout is the client-side backstop. The pool is
 *  registered for shutdown via closePools(). */
export function createBoundedPool(opts: { max: number; statementTimeoutMs: number }): Pool {
  const p = new Pool({
    connectionString: buildConnectionString(),
    max: opts.max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: opts.statementTimeoutMs,
    query_timeout: opts.statementTimeoutMs + 100,
    keepAlive: true,
  });
  p.on('error', (err) => logger.error({ error: err.message }, 'Bounded pool error'));
  // Idle clients only, above. This pool exists for best-effort side reads on the
  // request-completion path, so a socket dropping under one of them must cost
  // that read and nothing else — see createServicePool.
  installBorrowedClientGuard(p, { logger, serviceType: 'bounded' });
  boundedPools.add(p);
  return p;
}

// Legacy export for backwards compat — routes through getPool().
export const pool = new Proxy({} as Pool, {
  get(_, prop) {
    return (getPool() as any)[prop];
  },
});

/**
 * Execute a function within a tenant-scoped transaction. Delegates to
 * @liftoffos/database with tenant-runtime's RLS variable name
 * (`app.tenant_id`, not `app.current_tenant_id`).
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
    { rlsVariableName: 'app.tenant_id' },
    fn,
  );
}

// A `getLocalTenantId()` used to live here: `SELECT id FROM tenants LIMIT 1`,
// memoized per process, standing in for "the tenant this runtime serves". A
// runtime serves as many tenants as its database holds rows, so that helper
// answered every caller with one arbitrary tenant and skipped the rest without
// erroring. Ask `infrastructure/tenant-registry` instead: `forEachTenant` to
// cover them all, `isKnownTenant` to test membership.

export async function closePools(): Promise<void> {
  const closePromises: Promise<void>[] = [];
  for (const [service, servicePool] of servicePools) {
    logger.info({ service }, 'Closing database pool');
    closePromises.push(servicePool.end());
  }
  for (const bounded of boundedPools) {
    closePromises.push(bounded.end().catch(() => undefined));
  }
  await Promise.all(closePromises);
  servicePools.clear();
  boundedPools.clear();
}

export function getPoolStats(): Record<string, { total: number; idle: number; waiting: number }> {
  return collectPoolStats(servicePools.entries());
}
