import type { Pool, PoolClient } from 'pg';

declare const tenantScopeBrand: unique symbol;

/**
 * A PoolClient whose transaction has had the RLS variable bound to a tenant.
 *
 * The brand exists because "the caller already scoped this" was previously an
 * assertion in a comment, which nothing checks and which a reader has to take
 * on trust. A function that requires a scoped connection can now say so in its
 * signature, and handing it an unscoped pool client stops compiling.
 *
 * withTenantScope is the only place that mints one. There is no exported
 * constructor and no way to satisfy the brand except by going through the
 * helper that establishes the scope — short of a deliberate cast, which is
 * greppable in a way a missing set_config is not.
 *
 * It says scoped, NOT scoped-to-whom. A brand cannot catch a connection bound
 * to the wrong tenant; only a test that records which tenant each statement ran
 * under can do that.
 */
export type TenantScopedClient = PoolClient & { readonly [tenantScopeBrand]: true };

export interface TenantScopeOptions {
  /**
   * Postgres session variable that RLS policies reference. The two Liftoff
   * repos use different names: platform-backend uses `app.current_tenant_id`,
   * tenant-runtime uses `app.tenant_id`. Caller picks the one its policies
   * expect.
   */
  rlsVariableName: string;
  /**
   * Fired once per withTenantScope call AFTER release (fire-and-forget).
   * Useful for per-tenant metering / cost attribution. Exceptions inside
   * this hook are swallowed.
   */
  onComplete?: (tenantId: string, durationMs: number) => void;
}

/**
 * Execute `fn` inside a Postgres transaction with `SET LOCAL <rls-var> = $1`
 * so RLS policies filter rows to the given tenant. SET LOCAL is
 * transaction-scoped — COMMIT/ROLLBACK clears it — and the RESET in finally
 * is defense-in-depth against the connection returning to the pool with
 * the variable still set.
 *
 * Throws are re-raised after ROLLBACK. The pool client is always released.
 */
export async function withTenantScope<T>(
  pool: Pool,
  tenantId: string,
  options: TenantScopeOptions,
  fn: (client: TenantScopedClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  const startMs = Date.now();
  try {
    await client.query('BEGIN');
    // Postgres does not accept prepared-statement parameters in `SET LOCAL`
    // (the parser rejects `$1` with "syntax error at or near \"$1\""). Use
    // set_config(name, value, is_local=true) — the functional equivalent
    // that does take parameters, so we don't have to interpolate the tenant
    // id into the SQL string and reinvent escaping.
    await client.query(`SELECT set_config($1, $2, true)`, [options.rlsVariableName, tenantId]);
    // The one place the brand is minted. The scope is established immediately
    // above; from here on the type carries that fact to anything this client
    // is handed to.
    const result = await fn(client as TenantScopedClient);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    await client.query(`RESET ${options.rlsVariableName}`).catch(() => {});
    client.release();
    if (options.onComplete) {
      try {
        options.onComplete(tenantId, Date.now() - startMs);
      } catch {
        // swallow metering errors
      }
    }
  }
}

export interface AdminScopeOptions {
  /** The RLS variable to RESET at the start of the admin transaction. */
  rlsVariableName: string;
  /**
   * Audit hook fired before the transaction begins. Callers use this to log
   * the admin-scope invocation (who, why, etc.).
   */
  onInvoke?: (ctx: { caller: string; actor?: string; reason?: string }) => void;
}

export interface AdminScopeContext {
  caller: string;
  actor?: string;
  reason?: string;
}

/**
 * Execute `fn` using an admin pool (typically bound to a BYPASSRLS role).
 * Callers supply the admin pool — this helper only manages the transaction
 * boundary, RLS-variable reset, and audit hook. Caller is responsible for
 * restricting which code paths can invoke this (e.g. via an ESLint rule).
 */
export async function withAdminScope<T>(
  adminPool: Pool,
  ctx: AdminScopeContext,
  options: AdminScopeOptions,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  options.onInvoke?.(ctx);

  const client = await adminPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`RESET ${options.rlsVariableName}`);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
