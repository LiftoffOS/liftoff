// Database Configuration
// Per Section 5: Cloud SQL strategy and connection budgeting

import { Pool, PoolClient } from 'pg';
import {
  withTenantScope as pkgWithTenantScope,
  withAdminScope as pkgWithAdminScope,
  collectPoolStats,
  installBorrowedClientGuard,
  resolvePoolSize,
} from '@liftoffos/database';
import { getDbPassword } from './secrets';
import { log } from './logging';

// Per Section 5: Strict per-service pool-size caps
// Control plane services have different connection budgets

export type ServiceType =
  | 'tenant-provisioner'
  | 'entitlements'
  | 'billing'
  | 'rollout'
  | 'operator-dashboard'
  | 'disaster-recovery'
  | 'validator-hooks'
  | 'api'
  | 'cost-attribution-ingester'
  | 'default';

// Per Section 5: Connection budget allocation per service priority
const SERVICE_POOL_SIZES: Record<ServiceType, number> = {
  // High-priority services
  'tenant-provisioner': 10,
  'entitlements': 10,
  'billing': 8,
  'api': 8,
  // Medium-priority services
  'rollout': 6,
  'validator-hooks': 5,
  'operator-dashboard': 5,
  // Lower-priority services
  'disaster-recovery': 4,
  'cost-attribution-ingester': 3,
  // Fallback
  'default': 5,
};

// Service pools cache
const servicePools: Map<ServiceType, Pool> = new Map();

// Connect timeout for the request and per-service pools. This is how long a
// caller waits for a pooled connection before the query fails outright, so it
// bounds two different things: establishing a new connection to Cloud SQL
// (~10s cold through the Auth Proxy), and waiting for a busy pool to free one.
// The second is the common case here, because the background ingesters share
// these pools with the request path and tick concurrently. A caller that waits
// a few seconds and then succeeds is worth more than one that fails fast and
// returns an error, so this is deliberately more forgiving than a latency
// budget would suggest. It is a failure threshold, not a latency target.
const POOL_CONNECTION_TIMEOUT_MS = 8000;

// Database password (fetched once)
let dbPassword: string | null = null;

// Get pool size for a service (supports env override via @liftoffos/database).
function getPoolSizeForService(service: ServiceType): number {
  return resolvePoolSize(service, { defaults: SERVICE_POOL_SIZES });
}

// Default pool (exported for direct access after initialization)
export let pool: Pool;

// Initialize default pool with Secret Manager password
export async function initDatabase(): Promise<void> {
  dbPassword = await getDbPassword();
  const poolSize = getPoolSizeForService('default');

  pool = new Pool({
    host: process.env.DB_HOST || '/cloudsql/' + process.env.CLOUD_SQL_CONNECTION_NAME,
    port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 5432,
    database: process.env.DB_NAME || 'liftoff_control_plane',
    user: process.env.DB_USER,
    password: dbPassword,
    max: poolSize,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: POOL_CONNECTION_TIMEOUT_MS,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,
  });

  // Per Section 5: Short transactions on hot paths
  pool.on('error', (err) => {
    log.error({ error: err }, 'Unexpected database error');
  });

  // The handler above fires for IDLE clients only. pg-pool removes its own error
  // listener the moment a client is checked out, so from then until release a
  // borrowed client has none — and in Node an 'error' event with no listener is
  // thrown. If every socket on an instance closes at once, `Connection
  // terminated unexpectedly` lands on a borrowed client and the container
  // exits, taking every in-flight request and every cron on the instance with
  // it. There are ~18 direct
  // `pool.connect()` sites in src/ plus two in @liftoffos/database's tenant
  // scope; each was a process-kill site. This closes the window for all of them
  // at once, off the pool's own acquire/release/remove events rather than by
  // wrapping connect — see borrowed-client-guard.ts for why that distinction is
  // load-bearing.
  installBorrowedClientGuard(pool, { logger: log, serviceType: 'default' });

  // WS-12.3 — same connect-wrapper as createServicePool: surface pool-
  // saturation and unexpected-resolve failures as structured errors.
  const origConnect = pool.connect.bind(pool) as (...args: unknown[]) => Promise<PoolClient>;
  (pool as unknown as { connect: typeof origConnect }).connect = async function (...args: unknown[]): Promise<PoolClient> {
    const stack = (new Error('pool.connect').stack ?? '').split('\n').slice(2, 12).join('\n');
    let client: PoolClient;
    try {
      client = await origConnect(...args);
    } catch (err) {
      log.warn(
        { event: 'pool_connect_failed', service: 'default', err: (err as Error).message, captureStack: stack },
        'pool.connect rejected',
      );
      throw err;
    }
    if (!client || typeof client.release !== 'function') {
      // pg Pool.connect resolves with undefined under conditions the wrapper
      // shouldn't police (legacy callback form, bind/this confusion, internal
      // calls from pool.query()). Log a structured warn and pass through —
      // the downstream awaiter still gets the value the unwrapped Pool would
      // have returned. The pool_connect_unexpected_resolve telemetry event
      // is still emitted; throwing here would abort startup.
      log.warn(
        { event: 'pool_connect_unexpected_resolve', service: 'default', client: typeof client, captureStack: stack },
        'pool.connect resolved with non-client (passthrough)',
      );
      return client as unknown as PoolClient;
    }
    return client;
  };

  // Verify connection
  await pool.query('SELECT 1');
  log.info({ poolSize }, 'Database pool initialized');

  // Warm the admin pool now, while the DB is confirmed reachable (the SELECT 1
  // above just succeeded) and no background workers are contending yet. The
  // admin pool (used by every withAdminScope caller, including the control-
  // plane / internal-agent / knowledge outbox workers) is otherwise built
  // lazily on first use — which in practice is the first outbox-worker tick
  // ~30s into a fresh Cloud Run instance, while Cloud SQL connectivity is still
  // warming up. Several workers then race a cold pool build/connect at once and
  // log "<name>-outbox-worker tick failed: timeout exceeded when trying to
  // connect" for the first ~90s of every revision. Warming here (bounded retry)
  // builds and caches the pool before any tick fires. Best-effort: a persistent
  // warm failure is left to the lazy path and must never crash boot, since the
  // request path uses the default pool verified above.
  await warmAdminPoolBestEffort();
}

// Create a pool for a specific service
async function createServicePool(service: ServiceType): Promise<Pool> {
  if (!dbPassword) {
    dbPassword = await getDbPassword();
  }

  const poolSize = getPoolSizeForService(service);

  const newPool = new Pool({
    host: process.env.DB_HOST || '/cloudsql/' + process.env.CLOUD_SQL_CONNECTION_NAME,
    port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 5432,
    database: process.env.DB_NAME || 'liftoff_control_plane',
    user: process.env.DB_USER,
    password: dbPassword,
    max: poolSize,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: POOL_CONNECTION_TIMEOUT_MS,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,
  });

  newPool.on('error', (err) => {
    log.error({ error: err, service }, 'Unexpected database error');
  });

  // Idle clients only, above. A borrowed one has no listener at all until it is
  // released, and an unhandled 'error' event exits the process — see
  // initDatabase and borrowed-client-guard.ts.
  installBorrowedClientGuard(newPool, { logger: log, serviceType: service });

  // WS-12.3 (mirrors WS-6.3 in tenant-runtime): wrap `connect` so saturation /
  // unexpected-resolve failures surface as structured errors instead of the
  // opaque `Cannot read properties of undefined (reading 'release')`
  // TypeError.
  const origConnect = newPool.connect.bind(newPool) as (...args: unknown[]) => Promise<PoolClient>;
  (newPool as unknown as { connect: typeof origConnect }).connect = async function (...args: unknown[]): Promise<PoolClient> {
    const captureAt = Date.now();
    const stack = (new Error('pool.connect').stack ?? '')
      .split('\n')
      .slice(2, 12)
      .join('\n');
    let client: PoolClient;
    try {
      client = await origConnect(...args);
    } catch (err) {
      log.warn(
        { event: 'pool_connect_failed', service, err: (err as Error).message, captureStack: stack },
        'pool.connect rejected',
      );
      throw err;
    }
    if (!client || typeof client.release !== 'function') {
      // pg's pool.connect can return undefined in several legitimate
      // non-promise-form patterns: the documented callback form
      // (`pool.connect(cb)`), older typings that hand the client to a
      // continuation, and at least one library internal path that delivers
      // the client via internal queueing.
      //
      // Throwing here can abort startup when a worker-init caller hits this
      // branch. The
      // instrumentation is supposed to be DIAGNOSTIC (catch leaks /
      // saturation) — it should never refuse to return a client and
      // never abort startup. Log the unusual resolve and pass through
      // whatever pg gave us; downstream code's own error handling
      // remains in charge.
      log.warn(
        { event: 'pool_connect_unexpected_resolve', service, client: typeof client, captureStack: stack, argsLen: args.length, firstArgType: args.length > 0 ? typeof args[0] : 'none' },
        'pool.connect resolved with non-client; passing through',
      );
      return client as unknown as PoolClient;
    }
    void captureAt; // reserved for future leak-tracking
    return client;
  };

  log.info({ service, poolSize }, 'Service database pool created');
  return newPool;
}

// Get pool for a specific service (lazy initialization)
export async function getPoolForService(service: ServiceType): Promise<Pool> {
  let servicePool = servicePools.get(service);
  if (!servicePool) {
    servicePool = await createServicePool(service);
    servicePools.set(service, servicePool);
  }
  return servicePool;
}

// Get the default pool instance (throws if not initialized)
export function getPool(): Pool {
  if (!pool) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return pool;
}

// Cleanup all pools (for graceful shutdown)
export async function closePools(): Promise<void> {
  const closePromises: Promise<void>[] = [];

  for (const [service, servicePool] of servicePools) {
    log.info({ service }, 'Closing database pool');
    closePromises.push(servicePool.end());
  }

  if (pool) {
    log.info('Closing default database pool');
    closePromises.push(pool.end());
  }

  if (adminPool) {
    log.info('Closing admin database pool');
    closePromises.push(adminPool.end());
    adminPool = null;
  }

  await Promise.all(closePromises);
  servicePools.clear();
}

// ──────────────────────────────────────────────────────────────────────────
// Tenant-scoped and admin-scoped query execution
// Phase 1: RLS enforcement via SET LOCAL app.current_tenant_id
// ──────────────────────────────────────────────────────────────────────────

/**
 * Execute a function within a tenant-scoped transaction.
 * Delegates to @liftoffos/database's withTenantScope with the control-plane
 * RLS variable name.
 */
export function withTenantScope<T>(
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return pkgWithTenantScope(
    getPool(),
    tenantId,
    { rlsVariableName: 'app.current_tenant_id' },
    fn,
  );
}

// Admin pool — separate connection pool using the `liftoff_admin` DB role (BYPASSRLS).
// The role is created in migration 090_enable_rls.sql.
// Falls back to DB_USER when DB_ADMIN_USER is not configured (dev/test environments).

// Connect timeout for the background admin pool. Held separately from
// POOL_CONNECTION_TIMEOUT_MS even though the two currently agree: this pool is
// warmed at boot and serves background workers only, so it can absorb a slow
// Cloud SQL cold-connect that the request path might prefer to fail on. The
// numbers are free to diverge.
const ADMIN_POOL_CONNECTION_TIMEOUT_MS = 8000;

let adminPool: Pool | null = null;

// Single in-flight build promise — when N concurrent first callers race on
// `ensureAdminPool`, they all await this promise, so we build + probe exactly
// one pool. On failure the promise is nulled so the next call retries from
// scratch (rather than serving the broken/no-pool state forever).
let adminPoolBuildPromise: Promise<Pool> | null = null;

// Cached BYPASSRLS probe result so we only run the SELECT once per process.
let adminPoolProbed = false;

/**
 * Probe the admin pool role to verify it has BYPASSRLS. If the role does not
 * have BYPASSRLS in a FORCE-RLS environment, fail fast at startup — running
 * admin-scoped queries under an RLS-enforced role silently returns empty
 * result sets and is impossible to diagnose at request time.
 *
 * Enforcement is OPT-IN via:
 *   - process.env.LIFTOFF_REQUIRE_ADMIN_BYPASSRLS === 'true'.
 *
 * We deliberately do NOT auto-trigger enforcement on NODE_ENV === 'production'
 * because Cloud Run sets NODE_ENV=production for EVERY environment (dev,
 * staging, prod alike). Until `ALTER TABLE ... FORCE ROW LEVEL SECURITY`
 * is rolled out, the BYPASSRLS bit doesn't change query behavior (owners
 * bypass RLS unless FORCE is set), so requiring BYPASSRLS in dev would
 * break startup without securing anything.
 *
 * Operator playbook (per docs/rls-todo.md):
 *   1. Create + grant password to `liftoff_admin` role (BYPASSRLS).
 *   2. Set DB_ADMIN_USER=liftoff_admin in the env.
 *   3. Run `ALTER TABLE ... FORCE ROW LEVEL SECURITY` for each in-scope table.
 *   4. Set `LIFTOFF_REQUIRE_ADMIN_BYPASSRLS=true` so this probe enforces.
 *
 * Truthy value parsing is intentionally strict (`=== 'true'`) to match the
 * repo's existing convention (see e.g. src/internal-agents/router.ts,
 * src/accounts/router.ts). Operators must set the value literally to the
 * string `'true'`. See `.env.example`.
 *
 * In all environments, the probe logs the BYPASSRLS state — when not
 * enforcing, a missing BYPASSRLS logs a warning so operators can see the
 * gap. Throwing happens only when explicitly required.
 *
 * Failure semantics (BLK-2): on throw, the cached flag is NOT set, so the
 * next call re-runs the probe and re-throws. This avoids the prior bug where
 * a `finally`-clause flagged the probe as completed even on throw, causing
 * subsequent callers to receive a cached "success" return while pointing at
 * a broken pool.
 *
 * Exported for tests.
 */
export async function probeAdminPoolBypassRls(p: Pool): Promise<void> {
  if (adminPoolProbed) return;
  const requireBypass = process.env.LIFTOFF_REQUIRE_ADMIN_BYPASSRLS === 'true';
  const result = await p.query<{ rolbypassrls: boolean; current_user: string }>(
    `SELECT rolbypassrls, current_user FROM pg_roles WHERE rolname = current_user`,
  );
  if (result.rows.length === 0) {
    // current_user not found in pg_roles — unexpected. Treat as missing
    // BYPASSRLS for safety.
    const msg = 'admin pool startup probe: current_user not found in pg_roles';
    if (requireBypass) {
      log.error({ event: 'admin_pool_probe_failed' }, msg);
      throw new Error(msg);
    }
    log.warn({ event: 'admin_pool_probe_warning' }, msg);
  } else {
    const { rolbypassrls, current_user } = result.rows[0];
    if (!rolbypassrls) {
      const msg = `CRITICAL: admin pool role '${current_user}' does not have BYPASSRLS. withAdminScope queries will be silently filtered by RLS. Set DB_ADMIN_USER to a role with BYPASSRLS (e.g., 'liftoff_admin' from migration 090) or unset LIFTOFF_REQUIRE_ADMIN_BYPASSRLS in non-production.`;
      if (requireBypass) {
        log.error({ event: 'admin_pool_probe_failed', current_user }, msg);
        throw new Error(msg);
      }
      log.warn({ event: 'admin_pool_probe_warning', current_user }, msg);
    } else {
      log.info(
        { event: 'admin_pool_probe_ok', current_user },
        'admin pool BYPASSRLS probe passed',
      );
    }
  }
  // Cache the success ONLY after we've reached this point without throwing.
  // BLK-2: a `finally` clause would (incorrectly) flag failures as probed.
  adminPoolProbed = true;
}

// Exported only for tests — resets cached admin-pool state so a test can
// re-run the probe and rebuild the pool. Throws if called outside a test
// environment so production code cannot accidentally nuke the cached pool
// (which would force a rebuild and re-probe under load).
export function _resetAdminPoolStateForTests(): void {
  if (process.env.NODE_ENV !== 'test' && process.env.JEST_WORKER_ID === undefined) {
    throw new Error('_resetAdminPoolStateForTests called outside test environment');
  }
  adminPool = null;
  adminPoolProbed = false;
  adminPoolBuildPromise = null;
}

async function buildAndProbeAdminPool(): Promise<Pool> {
  const password = await getDbPassword();
  const newPool = new Pool({
    host: process.env.DB_HOST || '/cloudsql/' + process.env.CLOUD_SQL_CONNECTION_NAME,
    port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 5432,
    database: process.env.DB_NAME || 'liftoff_control_plane',
    user: process.env.DB_ADMIN_USER || process.env.DB_USER,
    password,
    max: 3, // Tight budget — admin operations are rare
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: ADMIN_POOL_CONNECTION_TIMEOUT_MS,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,
  });
  newPool.on('error', (err) => {
    log.error({ error: err }, 'Unexpected admin pool database error');
  });

  // Idle clients only, above. This pool is borrowed by every withAdminScope
  // caller — the outbox workers among them — so a socket dropping under one of
  // those would take the whole instance down exactly as it would on the request
  // path. See borrowed-client-guard.ts.
  installBorrowedClientGuard(newPool, { logger: log, serviceType: 'admin' });
  try {
    await probeAdminPoolBypassRls(newPool);
  } catch (err) {
    // Best-effort cleanup of the half-built pool.
    try {
      await newPool.end();
    } catch (endErr) {
      log.warn(
        { error: (endErr as Error).message },
        'admin pool: failed to end pool after probe failure — continuing',
      );
    }
    throw err;
  }
  return newPool;
}

async function ensureAdminPool(): Promise<Pool> {
  if (adminPool) return adminPool;
  // Promise-memo (BLK-2): if multiple first-callers race here, they all await
  // the same in-flight build. On success, the resolved pool is cached. On
  // failure, the promise is nulled so the next call rebuilds from scratch.
  if (!adminPoolBuildPromise) {
    adminPoolBuildPromise = buildAndProbeAdminPool()
      .then((p) => {
        adminPool = p;
        return p;
      })
      .catch((err) => {
        adminPoolBuildPromise = null;
        throw err;
      });
  }
  return adminPoolBuildPromise;
}

/**
 * Build + probe the admin pool at startup with a bounded retry, so the outbox
 * workers (and every other withAdminScope caller) start against a warm, cached
 * pool instead of racing a cold build on their first tick. Best-effort: on
 * persistent failure it logs and returns false, leaving the lazy build path to
 * try again on first use — it never throws, so a slow Cloud SQL warm-up cannot
 * crash boot.
 *
 * `ensure` and `sleep` are injectable for testing.
 */
export async function warmAdminPoolBestEffort(
  opts: {
    attempts?: number;
    ensure?: () => Promise<unknown>;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<boolean> {
  const attempts = opts.attempts ?? 5;
  const ensure = opts.ensure ?? ensureAdminPool;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await ensure();
      log.info({ attempt }, 'Admin pool warmed at startup');
      return true;
    } catch (err) {
      const backoffMs = Math.min(4000, 500 * 2 ** (attempt - 1));
      log.warn(
        { attempt, attempts, err: (err as Error).message, backoffMs },
        'Admin pool warm attempt failed',
      );
      if (attempt < attempts) await sleep(backoffMs);
    }
  }
  log.warn('Admin pool could not be warmed at startup — deferring to lazy build on first use');
  return false;
}

/**
 * Execute a function with admin scope (bypasses RLS).
 * Delegates to @liftoffos/database's withAdminScope with audit logging.
 *
 * RESTRICTED: Only allowed from src/admin/, src/billing/, src/tenants/service.ts.
 * An ESLint rule should enforce this import restriction.
 */
export async function withAdminScope<T>(
  callerContext: { caller: string; actor?: string; reason?: string },
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const p = await ensureAdminPool();
  return pkgWithAdminScope(
    p,
    callerContext,
    {
      rlsVariableName: 'app.current_tenant_id',
      onInvoke: (ctx) => {
        log.info(
          {
            event: 'admin_scope_invocation',
            caller: ctx.caller,
            actor: ctx.actor,
            reason: ctx.reason,
          },
          'Admin scope database access',
        );
      },
    },
    fn,
  );
}

// Get pool statistics (for monitoring)
export function getPoolStats(): Record<string, { total: number; idle: number; waiting: number }> {
  const entries: Array<[string, Pool]> = Array.from(servicePools.entries());
  if (pool) entries.push(['default', pool]);
  if (adminPool) entries.push(['admin', adminPool]);
  return collectPoolStats(entries);
}

