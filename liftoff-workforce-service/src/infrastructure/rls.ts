import { getPool } from './database.js';
import type { PoolClient } from 'pg';

/**
 * Runs fn inside a transaction with app.current_tenant_id set as a session-local
 * GUC. RLS policies on workforce_plans, team_plan_threads, team_plan_messages,
 * team_plan_rate_limit_events, and caio_memory read this setting to enforce
 * tenant isolation.
 *
 * Does NOT commit/rollback — the caller controls the transaction lifecycle.
 * For single-query usage, fn can return immediately after the query.
 */
export async function withTenantContext<T>(
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.current_tenant_id', $1, true)`,
      [tenantId],
    );
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
