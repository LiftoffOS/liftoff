// `withTenantContext` is the Phase 0h contract: every RPC handler in
// every new service must be reachable ONLY through this helper. It pins
// the standard Liftoff RLS variable name (`app.current_tenant_id`) so
// the four new services all speak the same SQL dialect, and delegates
// to the existing `withTenantScope` implementation.

import type { Pool, PoolClient } from 'pg';

import { withTenantScope } from './tenant-scope.js';

export const DEFAULT_RLS_VARIABLE_NAME = 'app.current_tenant_id';

/**
 * Preferred helper across the Phase 0a services (billing, developer-proxy,
 * workforce). Wraps {@link withTenantScope} with the Liftoff
 * convention. RLS policies must read
 * `current_setting('app.current_tenant_id', false)` — the `false` flag
 * makes missing context a hard error, not a silent no-match.
 *
 * The static analyzer at `scripts/rls-fence.ts` rejects any call to
 * `pool.query(...)` / `client.query(...)` that isn't inside one of
 * these blocks — keeping the runtime contract and the build gate in
 * sync.
 */
export async function withTenantContext<T>(
  pool: Pool,
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (!tenantId) {
    throw new Error('withTenantContext: tenantId is required');
  }
  return withTenantScope(pool, tenantId, { rlsVariableName: DEFAULT_RLS_VARIABLE_NAME }, fn);
}
