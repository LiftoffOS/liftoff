// Purge agents the control plane deleted, and the context they learned.
//
// When a workspace deletes an AI team, the control plane marks its row and
// publishes tenant.internal_agent.deleted; this service sets the agent's
// lifecycle to ARCHIVED. That was the whole of it. The row is not a cache
// pointer - it holds system_prompt, user_instructions, instructions_md, role,
// workflow_steps and memory_scope - and the agent's memories outlived it
// twice over, because memories.agent_id is ON DELETE SET NULL, so even a hard
// delete of the agent would have kept every memory's content and merely
// forgotten whose it was.
//
// This is the second half of the control plane's purge: the same grace period,
// read from the same environment variable, applied to this database. The two
// run independently on purpose. Making this one wait for an event from the
// control plane would mean a dropped message leaves the learned context of a
// deleted agent sitting here for ever, with nothing reporting it - and the
// archived lifecycle is already the durable record that the agent is gone, so
// no message is needed to know it.

import { getPool } from '../infrastructure/database';
import { logger } from '../infrastructure/logging';

/**
 * How long an archived agent survives before it is removed for good.
 *
 * Reads the control plane's variable so one setting governs the deployment:
 * a workspace told "thirty days" should not find its agent gone from one
 * database and present in the other. Values below 1 are refused.
 */
export const PURGE_AFTER_DAYS = (() => {
  const raw = process.env.SOFT_DELETE_PURGE_AFTER_DAYS;
  if (raw === undefined || raw.trim() === '') return 30;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) {
    logger.warn('purge: SOFT_DELETE_PURGE_AFTER_DAYS must be a number of days >= 1, using 30', {
      SOFT_DELETE_PURGE_AFTER_DAYS: raw,
    });
    return 30;
  }
  return Math.floor(n);
})();

/** One purge at a time across every instance. Distinct from the control plane's key. */
const PURGE_LOCK_KEY = 8_241_078;

export interface ArchivedAgentPurgeSummary {
  dryRun: boolean;
  olderThanDays: number;
  agentsPurged: number;
  memoriesPurged: number;
  cachedRowsPurged: number;
  /** False when another instance held the lock, in which case nothing ran. */
  ran: boolean;
}

/**
 * Hard-delete agents archived longer than the grace period, with their
 * memories, and the cached control-plane rows marked deleted.
 *
 * `updated_at` is the archive clock. There is no archived_at column, and
 * lifecycle is only written when it changes, so for a row sitting in ARCHIVED
 * the two are the same instant. A row that gets touched again would have its
 * clock reset, which delays a purge rather than skipping it - the safe
 * direction for a destructive pass.
 */
export async function purgeArchivedAgents(opts: {
  dryRun?: boolean;
  olderThanDays?: number;
} = {}): Promise<ArchivedAgentPurgeSummary> {
  const dryRun = opts.dryRun === true;
  const days = opts.olderThanDays ?? PURGE_AFTER_DAYS;
  const summary: ArchivedAgentPurgeSummary = {
    dryRun,
    olderThanDays: days,
    agentsPurged: 0,
    memoriesPurged: 0,
    cachedRowsPurged: 0,
    ran: false,
  };

  const pool = getPool();
  const client = await pool.connect();
  try {
    const locked = (await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [PURGE_LOCK_KEY],
    )).rows[0]?.locked === true;
    if (!locked) {
      logger.debug('purge: another instance holds the lock, skipping this tick');
      return summary;
    }
    summary.ran = true;

    try {
      const expired = (await client.query<{ id: string }>(
        `SELECT id FROM agents
          WHERE lifecycle IN ('ARCHIVED', 'DELETED')
            AND updated_at < NOW() - make_interval(days => $1)`,
        [days],
      )).rows.map((r) => r.id);

      if (expired.length > 0) {
        // Memories first and explicitly. The foreign key is ON DELETE SET
        // NULL, so deleting the agent would leave every memory row in place
        // with its content intact and its owner forgotten - the worst of both
        // outcomes, since the data stays and nothing can tell you whose it is.
        if (dryRun) {
          summary.memoriesPurged = (await client.query<{ n: number }>(
            `SELECT COUNT(*)::int AS n FROM memories WHERE agent_id = ANY($1::uuid[])`,
            [expired],
          )).rows[0]?.n ?? 0;
          summary.agentsPurged = expired.length;
        } else {
          summary.memoriesPurged = (await client.query(
            `DELETE FROM memories WHERE agent_id = ANY($1::uuid[])`,
            [expired],
          )).rowCount ?? 0;
          // Migration 380 made the thirteen blocking foreign keys cascade or
          // null, so this takes the workflows, tasks, actions, instructions
          // and field-level change log with the row.
          summary.agentsPurged = (await client.query(
            `DELETE FROM agents WHERE id = ANY($1::uuid[])`,
            [expired],
          )).rowCount ?? 0;
        }
      }

      // The projection of the control plane's agent. Marked 'deleted' by the
      // event handler and never removed.
      const cachedSql = dryRun
        ? `SELECT COUNT(*)::int AS n FROM cached_internal_agents
            WHERE status = 'deleted' AND synced_at < NOW() - make_interval(days => $1)`
        : `DELETE FROM cached_internal_agents
            WHERE status = 'deleted' AND synced_at < NOW() - make_interval(days => $1)`;
      const cached = await client.query(cachedSql, [days]);
      summary.cachedRowsPurged = dryRun
        ? ((cached.rows[0] as { n: number } | undefined)?.n ?? 0)
        : (cached.rowCount ?? 0);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [PURGE_LOCK_KEY]);
    }
  } finally {
    client.release();
  }

  if (summary.ran) {
    logger.info('purge: archived-agent pass complete', {
      dryRun,
      olderThanDays: days,
      agentsPurged: summary.agentsPurged,
      memoriesPurged: summary.memoriesPurged,
      cachedRowsPurged: summary.cachedRowsPurged,
    });
  }
  return summary;
}

let purgeTimer: NodeJS.Timeout | null = null;

/**
 * Run the purge in-process, on every instance.
 *
 * Deliberately not gated behind a scheduler, a feature flag, or anything else
 * that can be left unset. A deployment that never configured one would keep
 * the learned context of every deleted agent while the product reported it
 * deleted, and nothing would say so. The advisory lock makes the instance
 * count irrelevant; SOFT_DELETE_PURGE_INTERVAL_HOURS changes the cadence but
 * cannot stop the pass.
 */
export function startArchivedAgentPurgeWorker(): void {
  if (purgeTimer) return;

  const hours = Number(process.env.SOFT_DELETE_PURGE_INTERVAL_HOURS ?? 12);
  const intervalMs = (Number.isFinite(hours) && hours > 0 ? hours : 12) * 3_600_000;

  const tick = () => {
    void purgeArchivedAgents().catch((e) =>
      logger.error('purge: archived-agent pass failed', { error: (e as Error).message }),
    );
  };

  // Not at boot: a deploy restarts every instance at once, and a cold start
  // has traffic to serve before it owes anybody a retention sweep.
  setTimeout(tick, 5 * 60_000).unref?.();
  purgeTimer = setInterval(tick, intervalMs);
  purgeTimer.unref?.();

  logger.info('purge: archived-agent worker started', {
    intervalHours: intervalMs / 3_600_000,
    purgeAfterDays: PURGE_AFTER_DAYS,
  });
}

export function stopArchivedAgentPurgeWorker(): void {
  if (purgeTimer) {
    clearInterval(purgeTimer);
    purgeTimer = null;
  }
}
