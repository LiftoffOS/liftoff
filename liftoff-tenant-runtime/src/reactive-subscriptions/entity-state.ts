// Connector_entity_state diff helper.
//
// For each incoming entity event, diff the watched paths against last known
// state. Returns a `changes` map the predicate evaluator uses for
// `changed_to`. Per-entity advisory lock serializes concurrent
// polling/webhook updates so neither path observes the other's partial diff.

import { getPool } from '../infrastructure/database';

export async function diffAndUpdate(
  tenantId: string,
  connectorId: string,
  entityType: string,
  entityId: string,
  watchedPaths: string[],
  entityData: Record<string, unknown>,
): Promise<Record<string, { old: unknown; new: unknown }>> {
  const pool = getPool();
  const newValues: Record<string, unknown> = {};
  for (const p of watchedPaths) newValues[p] = resolve(entityData, p);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lockKey = `ces:${connectorId}:${entityType}:${entityId}`;
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [lockKey]);

    const { rows } = await client.query<{ watched_paths: Record<string, unknown> }>(
      `SELECT watched_paths FROM connector_entity_state
       WHERE tenant_id=$1 AND connector_id=$2 AND entity_type=$3 AND entity_id=$4
       FOR UPDATE`,
      [tenantId, connectorId, entityType, entityId]
    );
    const oldValues = rows[0]?.watched_paths ?? {};

    const changes: Record<string, { old: unknown; new: unknown }> = {};
    for (const p of watchedPaths) {
      if (!deepEqual(oldValues[p], newValues[p])) {
        changes[p] = { old: oldValues[p], new: newValues[p] };
      }
    }

    await client.query(
      `INSERT INTO connector_entity_state (tenant_id, connector_id, entity_type, entity_id, watched_paths, last_seen_at)
       VALUES ($1,$2,$3,$4,$5,NOW())
       ON CONFLICT (tenant_id, connector_id, entity_type, entity_id) DO UPDATE SET
         watched_paths = EXCLUDED.watched_paths, last_seen_at = NOW()`,
      [tenantId, connectorId, entityType, entityId, JSON.stringify(newValues)]
    );

    await client.query('COMMIT');
    return changes;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function resolve(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((cur, p) => (cur == null ? cur : (cur as Record<string, unknown>)[p]), obj);
}
