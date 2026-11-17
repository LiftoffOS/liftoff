// The scheduled caller for `onScheduledReflection`.
//
// `scheduled` is the only trigger type whose gate returns true unconditionally
// — `shouldTriggerReflection` answers `{ shouldTrigger: true }` for it without
// consulting any counter. Every other type is gated on evidence counters, so
// this is the path that reaches the reflection machinery — baseline capture,
// trajectory drift, revert, outcome closure — on a fixed cadence, whatever the
// counters say.
//
// WHY THIS PRE-FILTERS INSTEAD OF FANNING OUT.
//
// `enqueueWithQuotaManagement` increments the tenant's daily quota at ENQUEUE
// time, and the checks that decide whether a reflection is worth running —
// lifecycle, execution-allowed, evidence density — happen later, inside
// `triggerReflection`, when the Cloud Task is delivered. A sweep that enqueued
// every active agent would therefore spend a tenant's ten daily runs on agents
// that are then skipped, and the agents worth reflecting on would be the ones
// that got nothing. Quota is per TENANT (10/day) while agents are many, so the
// order this job chooses is the whole behaviour.
//
// It therefore asks the same two questions up front that the delivered task
// will ask, and enqueues only agents that pass:
//
//   - density >= REFLECTION_DENSITY_THRESHOLD, read through
//     `evidenceDensityFor`, which is the service's own reading under the
//     `scheduled` trigger. Deliberately not a second, looser standard of this
//     job's own — that is the mistake the note-promotion gate was written to
//     avoid, and the reason that method is exported at all.
//   - the tenant is execution-allowed, so a suspended tenant cannot burn quota
//     or accrue Opus spend.
//
// FAIRNESS. Agents are ordered least-recently-reflected first, so a fleet
// larger than the quota rotates through instead of the same few agents at the
// top of an id sort consuming every run forever. An agent that has never been
// reflected on sorts first.
//
// It enqueues; it does not reflect. Everything downstream — quotas, baseline,
// density re-check, the LLM call, closure — belongs to the existing pipeline
// and is not duplicated here.

import { pool } from '../infrastructure/database';
import { logger } from '../infrastructure/logging';
import { reflectionTriggerService } from '../reflection-engine/trigger-service';
import { ReflectionEngineService } from '../reflection-engine/service';
import { isExecutionAllowed } from '../entitlements-client/service';

/** Matches the gate inside `triggerReflection`. Asking a different question
 *  here than the delivered task asks is how a sweep spends quota on runs that
 *  are then skipped. */
const REFLECTION_DENSITY_THRESHOLD = 0.5;

/** Per-tenant enqueue ceiling for one sweep. The daily quota is 10; staying
 *  under it leaves room for the event-driven triggers (a flagged rejection is
 *  a stronger signal than a cadence tick and must not find the quota spent). */
const MAX_ENQUEUED_PER_TENANT = 3;

/** Whole-sweep ceiling, so a large estate cannot turn one cron tick into
 *  hundreds of Cloud Tasks. */
const MAX_ENQUEUED_PER_RUN = 50;

export interface ScheduledReflectionResult {
  agentsConsidered: number;
  enqueued: number;
  skippedLowDensity: number;
  skippedTenantNotAllowed: number;
  skippedQuotaCap: number;
  errors: number;
}

interface CandidateRow {
  id: string;
  tenant_id: string;
  last_reflected_at: Date | null;
}

export async function runScheduledReflection(): Promise<ScheduledReflectionResult> {
  const result: ScheduledReflectionResult = {
    agentsConsidered: 0,
    enqueued: 0,
    skippedLowDensity: 0,
    skippedTenantNotAllowed: 0,
    skippedQuotaCap: 0,
    errors: 0,
  };

  // Least-recently-reflected first. NULLS FIRST puts an agent that has never
  // been reflected on at the front, which on a fleet that has produced zero
  // suggestions is every agent — so the tiebreak on id keeps the order stable
  // rather than letting Postgres return a different arbitrary set each tick.
  const candidates = await pool.query<CandidateRow>(
    `SELECT a.id,
            a.tenant_id,
            (SELECT MAX(rs.created_at)
               FROM reflection_suggestions rs
              WHERE rs.agent_id = a.id) AS last_reflected_at
       FROM agents a
      WHERE a.lifecycle = 'ACTIVE'
      ORDER BY last_reflected_at ASC NULLS FIRST, a.id ASC
      LIMIT $1`,
    [MAX_ENQUEUED_PER_RUN * 4],
  );

  const reflectionService = new ReflectionEngineService();

  const perTenant = new Map<string, number>();
  // Cached per sweep: a tenant's admission state cannot change usefully within
  // one tick, and the entitlements call is a network hop per agent otherwise.
  const tenantAllowed = new Map<string, boolean>();

  for (const row of candidates.rows) {
    if (result.enqueued >= MAX_ENQUEUED_PER_RUN) break;
    result.agentsConsidered++;

    try {
      const used = perTenant.get(row.tenant_id) ?? 0;
      if (used >= MAX_ENQUEUED_PER_TENANT) {
        result.skippedQuotaCap++;
        continue;
      }

      let allowed = tenantAllowed.get(row.tenant_id);
      if (allowed === undefined) {
        allowed = await isExecutionAllowed(row.tenant_id);
        tenantAllowed.set(row.tenant_id, allowed);
      }
      if (!allowed) {
        result.skippedTenantNotAllowed++;
        continue;
      }

      const density = await reflectionService.evidenceDensityFor(row.id, row.tenant_id);
      if (density < REFLECTION_DENSITY_THRESHOLD) {
        result.skippedLowDensity++;
        continue;
      }

      // Only count what was actually enqueued. The trigger service declines on
      // quota by returning rather than throwing, so treating "did not throw" as
      // success reported work that never happened.
      const enqueued = await reflectionTriggerService.onScheduledReflection(row.id, row.tenant_id);
      if (!enqueued) {
        result.skippedQuotaCap++;
        continue;
      }
      perTenant.set(row.tenant_id, used + 1);
      result.enqueued++;
    } catch (err) {
      // One agent's failure must not end the sweep — the next agent is
      // independent, and a sweep that dies on the first error would silently
      // starve everything behind it.
      result.errors++;
      logger.warn(
        { agent_id: row.id, tenant_id: row.tenant_id, error: (err as Error).message },
        'scheduled reflection enqueue failed for one agent',
      );
    }
  }

  logger.info(
    {
      event: 'scheduled_reflection_sweep',
      ...result,
      message: 'scheduled reflection sweep complete',
    },
    'scheduled reflection sweep complete',
  );

  return result;
}
