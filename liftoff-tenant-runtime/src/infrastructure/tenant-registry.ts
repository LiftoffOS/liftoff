// Which tenants this runtime serves.
//
// This repo was written one-tenant-per-deployment, and a great deal of its
// periodic machinery still asked "which tenant am I?" — a question that has no
// answer once a deployment serves more than one. The old helper answered it
// with `SELECT id FROM tenants LIMIT 1`, memoized for the process lifetime: an
// arbitrary row, silently standing in for every other tenant in the database.
// A sweep written that way does not fail for the tenants it skips. It reports
// success, having looked at one of them.
//
// There are only two legitimate questions, and both are asked here:
//
//   * `forEachTenant` / `listTenantIds` — "which tenants do I serve?", for any
//     sweep, reconciler or scheduled tick that must cover all of them.
//   * `isKnownTenant`   — "do I serve this one?", the isolation boundary for a
//     message arriving off a topic that fans out across tenants.
//
// Neither answer is memoized. A runtime gains tenants while it is running, and
// a cached list leaves the newest one out of every sweep until the next deploy,
// which is the same silent-skip failure in a slower form.
//
// `tenants` carries no RLS policy (it is the table the policies are keyed
// against), so both reads run on the plain pool.

import { getPool } from './database';
import { logger } from './logging';

/** Every tenant in this runtime's database, oldest first.
 *
 *  Ordered so a fan-out visits tenants in a stable sequence across ticks: an
 *  unordered sweep that dies half way through covers a different subset each
 *  time, which makes a partial failure look intermittent rather than positional. */
export async function listTenantIds(): Promise<string[]> {
  const result = await getPool().query<{ id: string }>(
    'SELECT id FROM tenants ORDER BY created_at, id',
  );
  return result.rows.map((r) => r.id);
}

/** Whether this runtime serves `tenantId`.
 *
 *  The membership question, for events off a cross-tenant topic. Compare
 *  against this rather than against any single "own" id: on a runtime serving
 *  more than one tenant, an equality check against one of them drops the
 *  traffic of all the others, and drops it silently because the message is
 *  acked as handled. */
export async function isKnownTenant(tenantId: string): Promise<boolean> {
  const result = await getPool().query(
    'SELECT 1 FROM tenants WHERE id = $1 LIMIT 1',
    [tenantId],
  );
  return (result.rowCount ?? 0) > 0;
}

/** What a fan-out did, per tenant. Returned rather than logged alone so a
 *  scheduled route can answer with it and an operator can see coverage. */
export interface TenantFanoutResult<T> {
  tenants: number;
  ok: number;
  failed: number;
  results: Array<{ tenantId: string; value?: T; error?: string }>;
}

/**
 * Run `fn` once per tenant, sequentially, isolating failures.
 *
 * Two properties that a single-tenant sweep never needed:
 *
 *   * One tenant's failure does not end the sweep. With one tenant a throw was
 *     the whole answer; with many it silently truncates coverage at whichever
 *     tenant happens to be broken, and every tenant after it in the ordering
 *     pays for a fault that is not theirs.
 *   * Coverage is reported. `tenants` is how many were considered, not how many
 *     succeeded, so "swept 1 of N" is legible from the response instead of
 *     looking like a healthy run.
 *
 * Sequential on purpose: these are background sweeps sharing a connection pool
 * with live traffic, and a parallel fan-out across every tenant is a
 * self-inflicted load spike on a schedule.
 */
export async function forEachTenant<T>(
  label: string,
  fn: (tenantId: string) => Promise<T>,
): Promise<TenantFanoutResult<T>> {
  const tenantIds = await listTenantIds();
  const results: TenantFanoutResult<T>['results'] = [];
  let ok = 0;
  let failed = 0;

  for (const tenantId of tenantIds) {
    try {
      const value = await fn(tenantId);
      results.push({ tenantId, value });
      ok++;
    } catch (err) {
      const error = (err as Error).message;
      results.push({ tenantId, error });
      failed++;
      logger.warn({ label, tenantId, error }, 'tenant fan-out: tenant failed, continuing');
    }
  }

  logger.info({ label, tenants: tenantIds.length, ok, failed }, 'tenant fan-out complete');
  return { tenants: tenantIds.length, ok, failed, results };
}
