import type { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { scrubLogger } from '../observability/scrub-logger';

const LOCK_EXPIRY_SQL = "INTERVAL '15 minutes'";
const HEARTBEAT_INTERVAL_MS = 60_000;

export interface AgentLockHandle {
  tenantId: string;
  agentId: string;
  lockId: string;
  heartbeatTask: ReturnType<typeof setTimeout> | null;
  released: boolean;
}

function isTableMissingError(err: unknown): boolean {
  return (err as { code?: string })?.code === '42P01';
}

export async function tryAcquireAgentLock(
  pool: Pool,
  tenantId: string,
  agentId: string,
): Promise<AgentLockHandle | null> {
  const lockId = uuidv4();
  try {
    // Evict stale rows from crashed/killed processes
    await pool.query(
      `DELETE FROM agent_execution_locks
       WHERE tenant_id = $1 AND agent_id = $2 AND expires_at <= NOW()`,
      [tenantId, agentId],
    );
    const result = await pool.query(
      `INSERT INTO agent_execution_locks (tenant_id, agent_id, lock_id, expires_at)
       VALUES ($1, $2, $3, NOW() + ${LOCK_EXPIRY_SQL})
       ON CONFLICT (tenant_id, agent_id) DO NOTHING
       RETURNING 1`,
      [tenantId, agentId, lockId],
    );
    if ((result.rowCount ?? 0) === 0) return null;
  } catch (err) {
    if (isTableMissingError(err)) {
      // Graceful degradation: table not yet created (pre-migration state)
      scrubLogger.warn({ event: 'agent_execution_locks_table_missing' });
      return { tenantId, agentId, lockId, heartbeatTask: null, released: false };
    }
    throw err;
  }

  const handle: AgentLockHandle = { tenantId, agentId, lockId, heartbeatTask: null, released: false };
  scrubLogger.info({ event: 'agent_lock_acquired', tenantId, agentId });

  const scheduleHeartbeat = (): void => {
    if (handle.released) return;
    handle.heartbeatTask = setTimeout(async () => {
      if (handle.released) return;
      await pool.query(
        `UPDATE agent_execution_locks SET expires_at = NOW() + ${LOCK_EXPIRY_SQL}
         WHERE tenant_id = $1 AND agent_id = $2 AND lock_id = $3`,
        [tenantId, agentId, lockId],
      ).catch(err => scrubLogger.warn({ event: 'agent_lock_heartbeat_failed', err: (err as Error).message }));
      scheduleHeartbeat();
    }, HEARTBEAT_INTERVAL_MS);
  };
  scheduleHeartbeat();
  return handle;
}

export async function releaseAgentLock(pool: Pool, handle: AgentLockHandle): Promise<void> {
  if (handle.released) return;
  handle.released = true;
  if (handle.heartbeatTask) { clearTimeout(handle.heartbeatTask); handle.heartbeatTask = null; }
  scrubLogger.info({ event: 'agent_lock_released', tenantId: handle.tenantId, agentId: handle.agentId });
  await pool.query(
    `DELETE FROM agent_execution_locks WHERE tenant_id = $1 AND agent_id = $2 AND lock_id = $3`,
    [handle.tenantId, handle.agentId, handle.lockId],
  ).catch(err => scrubLogger.warn({ event: 'agent_lock_release_failed', err: (err as Error).message }));
}
