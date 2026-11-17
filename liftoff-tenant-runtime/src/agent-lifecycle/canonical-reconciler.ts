// Canonical agent reconciler.
//
// Periodically (Cloud Scheduler every 5 min) pulls the canonical agent state
// from platform-backend and heals four kinds of local drift:
//   1. cached_internal_agents.status differs from canonical status → overwrite.
//   2. agents.lifecycle differs from UPPER(canonical.status) → UPDATE.
//   3. Canonical = ACTIVE + cron trigger but Cloud Scheduler job is missing or
//      PAUSED → call ensureSchedulerJob (creates or unpauses).
//   4. Canonical ≠ ACTIVE but Cloud Scheduler job is ENABLED → call pauseJob.
//   5. Local `agents` row with no matching canonical (deleted upstream) →
//      mark lifecycle='DELETED' + call deleteJob.
//
// Pub/Sub remains the fast path; this reconciler is the floor. Worst-case
// drift window after this lands: 5 minutes (or 1 missed scheduled tick once
// the self-healing handler lands, whichever fires first).

import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { MetricServiceClient } from '@google-cloud/monitoring';
import { getPoolForService } from '../infrastructure/database';
import { logger } from '../infrastructure/logging';
import {
  listCanonicalAgents,
  fetchCanonicalAgentFull,
  type CanonicalAgent,
} from '../clients/platform-backend-client';
import {
  createOrUnpauseJob,
  resumeJob,
  pauseJob,
  deleteJob,
  getJobStatus,
  listAgentCompanionJobs,
} from '../scheduling/cloud-scheduler';
import { getTenantRuntimeUrl } from '../infrastructure/runtime-env';
import { getCompanionCrons } from './trigger-config-helpers';
import { registerEventAgent } from '../scheduling/event-trigger';
import { handleInternalAgentCreated } from '../events/subscriber';
import type { ControlPlaneEvent } from '../events/types';

const metricClient = new MetricServiceClient();
const METRIC_PREFIX = 'custom.googleapis.com/agent_scheduler';

interface LocalAgentRow {
  id: string;
  tenant_id: string;
  lifecycle: string;
  trigger_config: {
    type?: string;
    cronExpr?: string;
    timezone?: string;
    companionCron?: { cronExpr: string; timezone?: string };
    companionCrons?: Array<{ label: string; cronExpr: string; timezone?: string; objective?: string }>;
  } | null;
  name: string;
}

interface ReconcileSummary {
  tenantId: string;
  checked: number;
  cacheUpdated: number;
  lifecycleUpdated: number;
  schedulerCreated: number;
  schedulerResumed: number;
  schedulerPaused: number;
  schedulerDeleted: number;
  errors: number;
  // Self-heal counters — non-zero means the Pub/Sub creation path failed
  // for at least one agent and the reconciler had to fall back to fetching
  // /canonical-agents/:id/full and replaying handleInternalAgentCreated.
  // Alert in observability when selfHealed > 0 on a tick: it means the
  // event subscriber leaked an agent creation.
  selfHealAttempted?: number;
  selfHealed?: number;
}

const LOCK_KEY_PREFIX = 'canonical_reconciler:';

/**
 * Set the RLS tenant-context GUC on a checked-out client.
 *
 * Why this is required: migration 079_enable_rls.sql enables RLS on every
 * tenant-scoped table with a fail-loud policy (current_setting('app.tenant_id')
 * with no default). Without setting the GUC, every SELECT/UPDATE against
 * cached_internal_agents / agents / internal_agent_runtime_mapping throws
 * "unrecognized configuration parameter".
 *
 * Why set_config and not SET LOCAL: SET LOCAL only persists for the current
 * transaction; we want session-scoped (the client is held for the whole
 * reconcile, no surrounding transaction). The third arg to set_config (`false`)
 * is is_local — false means session-scoped.
 */
async function bindTenantSession(client: PoolClient, tenantId: string): Promise<void> {
  await client.query("SELECT set_config('app.tenant_id', $1, false)", [tenantId]);
}

/**
 * Reset the GUC on the dedicated client BEFORE returning it to the pool, so
 * a future checkout doesn't inherit a stale tenant context if the next caller
 * forgets to set its own. Best-effort; release-on-error still happens.
 */
async function clearTenantSession(client: PoolClient): Promise<void> {
  await client.query("SELECT set_config('app.tenant_id', '', false)").catch(() => undefined);
}

/**
 * Reconcile every agent for a tenant. Idempotent. Returns a summary suitable
 * for logging + metrics emission.
 *
 * Concurrency: protected by a Postgres SESSION-level advisory lock held on a
 * DEDICATED client that does ALL the reconcile's queries. This pattern is
 * critical:
 *
 *   - Session-scoped lock + session-scoped RLS GUC live on the same dedicated
 *     client. Releasing the client returns both to the pool, so we reset both
 *     explicitly in finally.
 *   - Each sub-query runs auto-commit (no surrounding BEGIN) on the same
 *     client, so an error on one query does NOT poison subsequent queries —
 *     PostgreSQL only enters the "aborted transaction" state inside an
 *     explicitly open transaction.
 *   - The Cloud Scheduler API calls (pauseJob/resumeJob/createOrUnpauseJob/
 *     deleteJob/getJobStatus) are HTTP and don't touch the client; they run
 *     interleaved with the SQL on this client.
 */
export async function reconcileTenant(tenantId: string): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = {
    tenantId, checked: 0, cacheUpdated: 0, lifecycleUpdated: 0,
    schedulerCreated: 0, schedulerResumed: 0, schedulerPaused: 0, schedulerDeleted: 0,
    errors: 0,
  };

  const pool = getPoolForService('scheduled-execution');
  const lockClient = await pool.connect();
  let lockHeld = false;

  try {
    const lockKey = `${LOCK_KEY_PREFIX}${tenantId}`;
    const lockResult = await lockClient.query<{ acquired: boolean }>(
      `SELECT pg_try_advisory_lock(hashtext($1)) AS acquired`,
      [lockKey],
    );
    if (!lockResult.rows[0].acquired) {
      logger.info({ tenantId }, 'reconcileTenant: another invocation holds the advisory lock, skipping');
      return summary;
    }
    lockHeld = true;

    // Now that the lock is held, set the RLS tenant context on this client.
    // Every subsequent sub-query uses lockClient.query and inherits this GUC.
    await bindTenantSession(lockClient, tenantId);

    let canonical: CanonicalAgent[];
    try {
      canonical = await listCanonicalAgents(tenantId);
    } catch (err) {
      logger.error({ tenantId, err: (err as Error).message }, 'reconcileTenant: listCanonicalAgents failed');
      summary.errors++;
      return summary;
    }
    summary.checked = canonical.length;

    const canonicalById = new Map(canonical.map((c) => [c.id, c]));

    for (const agent of canonical) {
      try {
        await reconcileOneAgent(agent, tenantId, lockClient, summary);
      } catch (err) {
        summary.errors++;
        logger.error(
          { tenantId, internalAgentId: agent.id, err: (err as Error).message },
          'reconcileOneAgent failed',
        );
      }
    }

    // Find local agents whose canonical is missing (deleted upstream) and clean up.
    //
    // Race-window note: this scan reads via `internal_agent_runtime_mapping`,
    // which is intentionally never hard-deleted (the codebase has zero
    // production paths that DELETE from this table). If that invariant
    // changes — i.e., the event subscriber starts removing mapping rows on
    // upstream-delete — this scan would miss the orphan, and the scheduler
    // job would leak. The fail-safe is Layer B's count-based audit, which
    // would catch the leak as `expected < total` for the tenant.
    try {
      const orphanResult = await lockClient.query<{
        agent_id: string;
        internal_agent_id: string;
        canonical_miss_count: number;
      }>(
        `SELECT m.agent_id,
                m.internal_agent_id,
                a.canonical_miss_count
           FROM internal_agent_runtime_mapping m
           JOIN agents a ON a.id = m.agent_id
          WHERE m.tenant_id = $1
            AND a.lifecycle != 'DELETED'`,
        [tenantId],
      );
      // 3 consecutive misses (≈15 min at the 5-min reconciler cadence) before
      // we destructively deleteJob. The prior single-read trigger meant ONE
      // transient bad read from PB (network blip, partial JSON, momentary
      // empty result) could nuke a healthy agent. Three independent HTTP
      // round-trips making the same false negative is vanishingly unlikely.
      const MISS_THRESHOLD = 3;
      for (const row of orphanResult.rows) {
        const presentInCanonical = canonicalById.has(row.internal_agent_id);
        if (presentInCanonical) {
          // Reset on any seen-in-canonical read. Avoid the update when
          // already 0 to keep tick cost down at scale.
          if (row.canonical_miss_count !== 0) {
            await lockClient.query(
              `UPDATE agents SET canonical_miss_count = 0, updated_at = NOW() WHERE id = $1`,
              [row.agent_id],
            );
          }
          continue;
        }
        const newMissCount = row.canonical_miss_count + 1;
        if (newMissCount < MISS_THRESHOLD) {
          // Bump counter; don't delete yet. Log so a spike of misses is
          // observable before the threshold fires.
          await lockClient.query(
            `UPDATE agents SET canonical_miss_count = $2, updated_at = NOW() WHERE id = $1`,
            [row.agent_id, newMissCount],
          );
          logger.info(
            {
              tenantId,
              agentId: row.agent_id,
              internalAgentId: row.internal_agent_id,
              missCount: newMissCount,
              threshold: MISS_THRESHOLD,
            },
            'orphan-gate: canonical missing — incremented miss count, deferring delete',
          );
          continue;
        }
        // Threshold reached — destructive delete is now justified.
        try {
          // Delete the Cloud Scheduler job FIRST, then mark the DB row as
          // DELETED. If the scheduler delete fails, the agents row stays
          // in its prior lifecycle and the next reconcile tick retries.
          // The reverse ordering would orphan the scheduler — the row
          // would be marked DELETED so the next tick's orphan scan
          // (filtering on `lifecycle != 'DELETED'`) wouldn't see it.
          await deleteJob(tenantId, row.agent_id);
          await lockClient.query(
            `UPDATE agents SET lifecycle = 'DELETED', updated_at = NOW() WHERE id = $1`,
            [row.agent_id],
          );
          summary.schedulerDeleted++;
          logger.info(
            {
              tenantId,
              agentId: row.agent_id,
              internalAgentId: row.internal_agent_id,
              missCountAtDelete: newMissCount,
            },
            'Deleted orphaned agent + scheduler (after N-consecutive-misses gate)',
          );
        } catch (err) {
          summary.errors++;
          logger.error(
            { tenantId, agentId: row.agent_id, err: (err as Error).message },
            'orphan cleanup failed (next tick will retry)',
          );
        }
      }
    } catch (err) {
      summary.errors++;
      logger.error({ tenantId, err: (err as Error).message }, 'orphan scan failed');
    }

    await emitMetrics(tenantId, canonical, lockClient);

    return summary;
  } finally {
    if (lockHeld) {
      await lockClient.query(`SELECT pg_advisory_unlock(hashtext($1))`, [`${LOCK_KEY_PREFIX}${tenantId}`])
        .catch((err) => logger.warn({ tenantId, err: (err as Error).message }, 'advisory unlock failed (non-fatal — connection release also drops it)'));
    }
    await clearTenantSession(lockClient);
    lockClient.release();
  }
}

/**
 * One-shot reconcile for a single (tenantId, internalAgentId). Used by the
 * self-healing scheduled-enqueue handler when it sees lifecycle drift on a
 * specific agent.
 *
 * No advisory lock — single-agent self-heal is best-effort and SQL operations
 * are idempotent (UPSERT, UPDATE). If two self-heals race on the same agent,
 * both land at the same final state.
 *
 * Checks out a dedicated client, binds the tenant session GUC, runs the
 * reconcile, releases the client.
 *
 * Returns true if the agent was found and reconciled; false otherwise.
 */
export async function reconcileSingleAgent(opts: {
  tenantId: string;
  internalAgentId: string;
}): Promise<boolean> {
  const pool = getPoolForService('scheduled-execution');
  const canonical = await listCanonicalAgents(opts.tenantId);
  const matching = canonical.find((a) => a.id === opts.internalAgentId);
  if (!matching) return false;

  const client = await pool.connect();
  try {
    await bindTenantSession(client, opts.tenantId);
    await reconcileOneAgent(matching, opts.tenantId, client);
    return true;
  } finally {
    await clearTenantSession(client);
    client.release();
  }
}

/**
 * Reconcile a single agent. Takes a PoolClient with the RLS tenant context
 * already bound (callers — reconcileTenant and reconcileSingleAgent — do this).
 *
 * All sub-queries run auto-commit on the same client. Concurrent reconciles
 * for the same agent are safe because all SQL operations are idempotent
 * (UPSERT for cache, UPDATE for lifecycle, Cloud Scheduler API calls).
 * Cross-agent concurrency for the same tenant is bounded by reconcileTenant's
 * session-scoped advisory lock.
 */
export async function reconcileOneAgent(
  agent: CanonicalAgent,
  tenantId: string,
  client: PoolClient,
  summary?: ReconcileSummary,
): Promise<void> {
  // 1. Upsert cached_internal_agents AND return whether the new row differs
  // from the prior one. The "did something change" signal uses Postgres'
  // IS DISTINCT FROM operator on JSONB (which normalizes key order and
  // whitespace) — comparing JSON.stringify() in JS would produce false
  // positives every tick.
  //
  // First-time INSERT (prior row didn't exist) is NOT counted as a change —
  // it's the initial cache populate, not a drift heal. The
  // `prior_status IS NOT NULL` guard distinguishes update-with-change from
  // first-insert.
  const newIntegrationsJson = JSON.stringify(agent.integrations);
  const upsertRes = await client.query<{ changed: boolean }>(
    `WITH prior AS (
       SELECT status AS prior_status, integrations AS prior_integrations
         FROM cached_internal_agents
        WHERE internal_agent_id = $1 AND tenant_id = $2
     ),
     upsert AS (
       INSERT INTO cached_internal_agents
         (internal_agent_id, tenant_id, role, status, integrations, entity_version, synced_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, NOW())
       ON CONFLICT (internal_agent_id, tenant_id) DO UPDATE SET
         role = EXCLUDED.role,
         status = EXCLUDED.status,
         integrations = EXCLUDED.integrations,
         entity_version = GREATEST(cached_internal_agents.entity_version, EXCLUDED.entity_version),
         synced_at = NOW()
       RETURNING 1
     )
     SELECT
       EXISTS(SELECT 1 FROM prior) AND (
         ((SELECT prior_status FROM prior) IS DISTINCT FROM $4)
         OR ((SELECT prior_integrations FROM prior) IS DISTINCT FROM $5::jsonb)
       ) AS changed
       FROM upsert`,
    [agent.id, tenantId, agent.role, agent.status, newIntegrationsJson, agent.currentVersion],
  );
  if (upsertRes.rows[0]?.changed) {
    if (summary) summary.cacheUpdated++;
  }

  // 2. Find the local agents row via the mapping (may not exist yet).
  const mapRes = await client.query<{ agent_id: string }>(
    `SELECT agent_id FROM internal_agent_runtime_mapping
      WHERE internal_agent_id = $1 AND tenant_id = $2`,
    [agent.id, tenantId],
  );
  let localAgentId = mapRes.rows[0]?.agent_id;
  if (!localAgentId) {
    // No mapping yet — the original Pub/Sub creation event was lost (DLQ
    // exhausted, subscriber crashed mid-handler, schema-drift caused skip).
    // Self-heal by fetching the FULL payload from PB and replaying the same
    // creation logic the event subscriber would have run, then continue
    // with the rest of the reconcile (lifecycle, scheduler, companions).
    //
    // Without this, agents stay permanently un-scheduled. The previous
    // "V1: log + skip" branch was the structural hole.
    if (summary) summary.selfHealAttempted = (summary.selfHealAttempted ?? 0) + 1;
    try {
      const fullPayload = await fetchCanonicalAgentFull(tenantId, agent.id);
      if (!fullPayload) {
        logger.info(
          { tenantId, internalAgentId: agent.id },
          'self-heal: canonical /full returned 404 — agent likely deleted between list and fetch, skipping',
        );
        return;
      }
      // Synthesize the same ControlPlaneEvent envelope the original
      // tenant.internal_agent.created publisher would have built. The
      // handler's idempotency check (lines 1288-1354 in subscriber.ts) means
      // re-firing this is safe if the original event ever did arrive late.
      const syntheticEvent: ControlPlaneEvent = {
        event_id: `self-heal-${randomUUID()}`,
        tenant_id: tenantId,
        entity_type: 'internal_agent',
        entity_id: agent.id,
        event_type: 'tenant.internal_agent.created',
        entity_version: agent.currentVersion,
        event_version: 1,
        occurred_at: new Date().toISOString(),
        payload: fullPayload,
      };
      await handleInternalAgentCreated(syntheticEvent);
      logger.info(
        { tenantId, internalAgentId: agent.id },
        'self-heal: agent row + mapping + scheduler created from canonical',
      );
      // Re-read the mapping the handler just created so the remainder of
      // reconcileOneAgent (steps 3–6) can act on it this tick rather than
      // waiting another 5 minutes.
      const reMap = await client.query<{ agent_id: string }>(
        `SELECT agent_id FROM internal_agent_runtime_mapping
          WHERE internal_agent_id = $1 AND tenant_id = $2`,
        [agent.id, tenantId],
      );
      localAgentId = reMap.rows[0]?.agent_id;
      if (!localAgentId) {
        // handleInternalAgentCreated finished without throwing but no mapping
        // exists — defensive log; next tick will retry.
        logger.warn(
          { tenantId, internalAgentId: agent.id },
          'self-heal: handler completed but mapping still missing — will retry next tick',
        );
        return;
      }
      if (summary) summary.selfHealed = (summary.selfHealed ?? 0) + 1;
    } catch (err) {
      if (summary) summary.errors++;
      logger.error(
        { tenantId, internalAgentId: agent.id, err: (err as Error).message },
        'self-heal failed — next reconcile tick will retry',
      );
      return;
    }
  }

  // 3. Read local agent's lifecycle + trigger.
  const localRes = await client.query<LocalAgentRow>(
    `SELECT id, tenant_id, lifecycle, trigger_config, name FROM agents WHERE id = $1`,
    [localAgentId],
  );
  const local = localRes.rows[0];
  if (!local) {
    logger.warn(
      { tenantId, internalAgentId: agent.id, localAgentId },
      'Mapping points at missing agents row — deferring to event subscriber',
    );
    return;
  }

  // 4. Heal lifecycle if it doesn't match canonical.
  const expectedLifecycle = agent.status.toUpperCase();
  if (local.lifecycle !== expectedLifecycle) {
    await client.query(
      `UPDATE agents SET lifecycle = $2, updated_at = NOW() WHERE id = $1`,
      [localAgentId, expectedLifecycle],
    );
    if (summary) summary.lifecycleUpdated++;
    logger.info(
      { tenantId, localAgentId, from: local.lifecycle, to: expectedLifecycle },
      'Healed agents.lifecycle from canonical',
    );
  }

  // 5. Heal Cloud Scheduler state.
  const wantsCron = agent.status === 'active'
    && agent.triggerConfig?.type === 'cron'
    && !!agent.triggerConfig.cronExpr;
  const wantsEvent = agent.status === 'active'
    && agent.triggerConfig?.type === 'event'
    && !!agent.triggerConfig.eventTopic;

  const status = await getJobStatus(tenantId, localAgentId);
  const currentJobState: 'ENABLED' | 'PAUSED' | 'MISSING' =
    !status?.exists ? 'MISSING'
    : status.state === 'ENABLED' ? 'ENABLED'
    : status.state === 'PAUSED' ? 'PAUSED'
    : 'MISSING'; // DISABLED, UPDATE_FAILED, unknown — treat as missing for healing

  if (wantsCron) {
    if (currentJobState === 'MISSING') {
      await createOrUnpauseJob({
        tenantId,
        agentId: localAgentId,
        cronExpr: agent.triggerConfig!.cronExpr!,
        apiBaseUrl: getTenantRuntimeUrl(),
        timezone: agent.triggerConfig!.timezone,
        description: `Scheduled execution for agent: ${local.name}`,
      });
      if (summary) summary.schedulerCreated++;
      logger.info({ tenantId, localAgentId, cronExpr: agent.triggerConfig!.cronExpr },
        'Reconciler created missing Cloud Scheduler job');
    } else if (currentJobState === 'PAUSED') {
      // Fast-path resume: 1 API call (~1s) vs createOrUnpauseJob's 3 (~30-60s).
      await resumeJob(tenantId, localAgentId);
      if (summary) summary.schedulerResumed++;
      logger.info({ tenantId, localAgentId }, 'Reconciler resumed paused Cloud Scheduler job');
    }
  } else {
    if (currentJobState === 'ENABLED') {
      await pauseJob(tenantId, localAgentId);
      if (summary) summary.schedulerPaused++;
      logger.info(
        { tenantId, localAgentId, canonicalStatus: agent.status, triggerType: agent.triggerConfig?.type },
        'Reconciler paused Cloud Scheduler job (canonical no longer ACTIVE+cron)',
      );
    }
  }

  // Event-trigger registration — a BACKSTOP, not the mechanism.
  //
  // The registration path is handleInternalAgentUpdated -> ensureSchedulerJob,
  // and the dispatch path reloads from the database when a miss cannot be
  // trusted (see event-trigger.ts). This tick exists only for the case where
  // both of those missed: the update was lost (DLQ, crash) AND the reconciler
  // saw the canonical change first.
  //
  // So finding drift here is a DEFECT, not routine healing, and it is logged
  // as one. This used to log "Reconciler ensured event-trigger registration"
  // on every tick whether or not anything was wrong, which made the tick that
  // actually repaired something indistinguishable from the thousands that
  // asserted an already-correct fact: a real repair read as routine.
  //
  // Silence is the healthy state. Re-asserting a registration that already
  // exists logs nothing.
  if (wantsEvent) {
    try {
      const eventTopic = agent.triggerConfig!.eventTopic!;
      if (registerEventAgent(localAgentId, tenantId, eventTopic)) {
        logger.warn(
          { tenantId, localAgentId, eventTopic },
          'Reconciler repaired a MISSING event-trigger registration — the update path did not '
            + 'reach this process; events for this topic were being dropped until now',
        );
      }
    } catch (err) {
      logger.warn(
        { tenantId, localAgentId, err: (err as Error).message },
        'Reconciler event-trigger registration failed (next tick will retry)',
      );
    }
  }

  // 6. Reconcile companion crons (drift-converge add/remove/edit). No-op for
  // agents that declare no companions.
  try {
    await reconcileCompanions(
      tenantId,
      localAgentId,
      local.name,
      local.lifecycle === 'ACTIVE',
      local.trigger_config,
      getTenantRuntimeUrl(),
    );
  } catch (err) {
    logger.warn(
      { tenantId, localAgentId, err: (err as Error).message },
      'reconcileCompanions failed (next tick will retry)',
    );
  }
}

// Reconcile per-agent companion Cloud Scheduler jobs against the agent's
// trigger_config.companionCrons. Runs at the tail of reconcileOneAgent so the
// per-agent lifecycle, name, and triggerConfig are already in scope.
async function reconcileCompanions(
  tenantId: string,
  localAgentId: string,
  agentName: string,
  agentLifecycleIsActive: boolean,
  triggerConfig: LocalAgentRow['trigger_config'],
  apiBaseUrl: string,
): Promise<void> {
  const desired = getCompanionCrons(triggerConfig as any);
  const existing = await listAgentCompanionJobs(tenantId, localAgentId);
  const desiredByLabel = new Map(desired.map(c => [c.label, c]));
  const existingByLabel = new Map(existing.map(e => [e.label, e]));

  // 1. Delete jobs that exist but are no longer desired (regardless of lifecycle)
  for (const e of existing) {
    if (!desiredByLabel.has(e.label)) {
      try { await deleteJob(tenantId, localAgentId, `-companion-${e.label}`); }
      catch (err: any) { if (err.code !== 5) throw err; }
    }
  }

  // 2. Create or heal jobs that are desired
  if (agentLifecycleIsActive) {
    // An ACTIVE agent's jobs are healed unconditionally. Repeated failures pause
    // the AGENT, so the branch below already has them covered — a routine can no
    // longer be held down by state of its own that this loop would have to know
    // about and Resume could not clear.
    for (const c of desired) {
      const ex = existingByLabel.get(c.label);
      const triggeredByLabel = `companion:${c.label}`;
      if (!ex) {
        await createOrUnpauseJob({
          tenantId, agentId: localAgentId,
          cronExpr: c.cronExpr,
          apiBaseUrl,
          timezone: c.timezone,
          description: `Companion (${c.label}) for agent: ${agentName}`,
          jobSuffix: `-companion-${c.label}`,
          triggeredByLabel,
        });
      } else if (ex.schedule !== c.cronExpr || ex.paused) {
        // Schedule changed or job paused while agent ACTIVE — heal via resume.
        // resumeJob includes self-heal of stale body via desiredBodyExtras.
        try {
          await resumeJob(tenantId, localAgentId, `-companion-${c.label}`, { triggeredByLabel });
        } catch (err: any) {
          if (err.code === 5) {
            await createOrUnpauseJob({
              tenantId, agentId: localAgentId,
              cronExpr: c.cronExpr,
              apiBaseUrl,
              timezone: c.timezone,
              description: `Companion (${c.label}) for agent: ${agentName}`,
              jobSuffix: `-companion-${c.label}`,
              triggeredByLabel,
            });
          } else throw err;
        }
      }
    }
  } else {
    // Non-ACTIVE: ensure all desired companions are paused
    for (const c of desired) {
      try { await pauseJob(tenantId, localAgentId, `-companion-${c.label}`); }
      catch (err: any) { if (err.code !== 5) throw err; }
    }
  }
}

// After the reconcile loop completes, derive the "unhealthy" counts directly
// from the live Cloud Scheduler state (NOT from the reconciler's heal counters,
// which represent what we just fixed, not what's still broken).
//
// Reads use the same RLS-bound client. GCP_PROJECT_ID is read lazily here so
// that test runs / dev environments without it set just skip metric emission
// (return early) rather than throwing.
async function emitMetrics(
  tenantId: string,
  canonical: CanonicalAgent[],
  client: PoolClient,
): Promise<void> {
  const tenantProjectId = process.env.GCP_PROJECT_ID ?? '';
  if (!tenantProjectId) return;

  let missingCount = 0;
  let pausedCount = 0;
  let failingCount = 0;

  for (const agent of canonical) {
    if (agent.status !== 'active' || agent.triggerConfig?.type !== 'cron') continue;

    const mapRes = await client.query<{ agent_id: string }>(
      `SELECT agent_id FROM internal_agent_runtime_mapping
        WHERE internal_agent_id = $1 AND tenant_id = $2`,
      [agent.id, tenantId],
    );
    const localAgentId = mapRes.rows[0]?.agent_id;
    if (!localAgentId) { missingCount++; continue; }

    const status = await getJobStatus(tenantId, localAgentId);
    if (!status?.exists) {
      missingCount++;
    } else if (status.state === 'PAUSED') {
      pausedCount++;
    } else if (status.state === 'ENABLED' && status.lastAttemptTime && status.lastAttemptResult === 'failed') {
      // Only count as failing when the job has actually attempted at least
      // once. Cloud Scheduler returns lastAttemptResult='failed' as a default
      // for never-fired jobs (cloud-scheduler.ts:469: `code === 0 ? 'success' : 'failed'`
      // where code is undefined on a fresh job). Without the lastAttemptTime
      // guard, every brand-new agent immediately triggers the failing-count alert.
      failingCount++;
    }
  }

  const now = { seconds: Math.floor(Date.now() / 1000) };
  const series = (['missing', 'paused', 'failing'] as const).map((kind) => ({
    metric: {
      type: `${METRIC_PREFIX}/${kind}_count`,
      labels: { tenant_id: tenantId, source: 'reconciler' },
    },
    resource: { type: 'global', labels: { project_id: tenantProjectId } },
    points: [{
      interval: { endTime: now },
      value: { int64Value: String({ missing: missingCount, paused: pausedCount, failing: failingCount }[kind]) },
    }],
  }));

  try {
    await metricClient.createTimeSeries({
      name: `projects/${tenantProjectId}`,
      timeSeries: series as never,
    });
  } catch (err) {
    logger.warn({ tenantId, err: (err as Error).message }, 'metric emission failed (non-fatal)');
  }
}
