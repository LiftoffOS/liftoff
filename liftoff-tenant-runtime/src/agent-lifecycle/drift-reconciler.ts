// Lifecycle Drift Reconciler
//
// The canonical source of truth for agent status is the platform backend's
// internal_agents.status column (what the /teams UI displays). This mirrors
// into cached_internal_agents.status in the tenant runtime via the event
// subscriber. The agents.lifecycle column is what actually drives execution
// and scheduler state.
//
// These three fields can drift when:
//   - A Pub/Sub event is dropped or delivered out of order
//   - A partial failure occurs mid-handler (e.g. DB committed, scheduler
//     update threw)
//   - Someone writes to agents.lifecycle directly, bypassing the event flow
//   - The Cloud Scheduler is manually resumed while the agent is PAUSED
//
// This module reconciles all three periodically. The canonical status wins;
// local state is healed to match.

import { getPoolForService } from '../infrastructure/database';
import { logger } from '../infrastructure/logging';
import { pauseJob, createOrUnpauseJob } from '../scheduling/cloud-scheduler';

interface DriftRow {
  agent_id: string;
  tenant_id: string;
  local_lifecycle: string;
  canonical_status: string | null;
  expected_lifecycle: string;
  agent_name: string;
  trigger_type: string | null;
}

/**
 * Reconcile all agents for all tenants. Finds drift between agents.lifecycle
 * and cached_internal_agents.status, heals the local state to match the
 * canonical state, and pauses the scheduler if the canonical state is
 * PAUSED/DRAFT/ARCHIVED.
 *
 * Returns the number of agents healed.
 */
export async function reconcileAllAgents(): Promise<{
  checked: number;
  healed: number;
  schedulerHealed: number;
  errors: number;
}> {
  const pool = getPoolForService('scheduled-execution');
  let checked = 0;
  let healed = 0;
  let schedulerHealed = 0;
  let errors = 0;

  // Find all agents with drift: local agents.lifecycle ≠ canonical status
  const driftResult = await pool.query<DriftRow>(
    `SELECT
       a.id as agent_id,
       a.tenant_id,
       a.lifecycle as local_lifecycle,
       c.status as canonical_status,
       UPPER(c.status) as expected_lifecycle,
       a.name as agent_name,
       a.trigger_config->>'type' as trigger_type
     FROM agents a
     JOIN internal_agent_runtime_mapping m
       ON m.agent_id = a.id AND m.tenant_id = a.tenant_id
     JOIN cached_internal_agents c
       ON c.internal_agent_id = m.internal_agent_id AND c.tenant_id = a.tenant_id
     WHERE UPPER(c.status) != a.lifecycle`
  );

  checked = driftResult.rows.length;

  for (const row of driftResult.rows) {
    try {
      logger.error('Lifecycle drift detected', {
        agent_id: row.agent_id,
        tenant_id: row.tenant_id,
        agent_name: row.agent_name,
        local_lifecycle: row.local_lifecycle,
        canonical_status: row.canonical_status,
        expected_lifecycle: row.expected_lifecycle,
      });

      // Heal the local agents table to match canonical
      await pool.query(
        `UPDATE agents SET lifecycle = $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3`,
        [row.expected_lifecycle, row.agent_id, row.tenant_id]
      );
      healed++;

      // If canonical state is anything but ACTIVE, pause the scheduler.
      // If canonical state IS ACTIVE and local was not, the scheduler may
      // need to be unpaused — but only if there's an existing cron trigger.
      if (row.trigger_type === 'cron') {
        try {
          if (row.expected_lifecycle === 'ACTIVE') {
            // Was paused/draft/archived, canonical says active — unpause.
            // NOTE: createOrUnpauseJob requires full trigger config to recreate,
            // which we don't have here. We only log this case; the activation
            // event handler is responsible for creating/unpausing scheduler jobs.
            logger.warn('Drift heal: canonical=ACTIVE but scheduler state unknown — relying on activation event', {
              agent_id: row.agent_id,
              agent_name: row.agent_name,
            });
          } else {
            // Canonical is paused/draft/archived — pause the scheduler.
            await pauseJob(row.tenant_id, row.agent_id);
            schedulerHealed++;
            logger.info('Drift heal: paused Cloud Scheduler job to match canonical state', {
              agent_id: row.agent_id,
              tenant_id: row.tenant_id,
            });
          }
        } catch (schedErr) {
          logger.warn({ err: schedErr, agent_id: row.agent_id }, 'Non-fatal: scheduler reconciliation failed');
        }
      }
    } catch (err) {
      errors++;
      logger.error({ err, agent_id: row.agent_id }, 'Failed to reconcile agent drift');
    }
  }

  if (checked > 0) {
    logger.info('Drift reconciliation completed', {
      checked,
      healed,
      scheduler_healed: schedulerHealed,
      errors,
    });
  }

  // Silence unused-import warning for createOrUnpauseJob while we only pause.
  void createOrUnpauseJob;

  return { checked, healed, schedulerHealed, errors };
}
