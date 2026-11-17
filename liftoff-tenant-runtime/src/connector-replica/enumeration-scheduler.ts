// Keeping the census current.
//
// The worker reconciles a page; the source fetches one. This is the thing that
// decides a page should be fetched at all — without it the whole census is a
// set of tables nothing ever writes to, and every surface built on it reports
// an empty workspace forever, indistinguishable from a workspace with no data.
//
// DEFAULT OFF. Enumeration spends the same vendor quota agents do, and the free
// Composio tier is 20,000 calls a month across the whole platform. Turning this
// on for a fleet before that arithmetic has been done would spend the month on
// bookkeeping. `CENSUS_ENABLED=1` is the deliberate decision to start.

import { COMPOSIO_MANAGED_TYPES } from '../billing/composio-call-reporter';
import { getPoolForService } from '../infrastructure/database';
import { forEachTenant } from '../infrastructure/tenant-registry';
import { logger } from '../infrastructure/logging';
import { toolGatewayService } from '../tool-gateway/router';
import { enumerableFunctions, buildConnectorEnumerationSource } from './connector-enumeration-source';
import { claimDueJobs, runEnumerationJob } from './enumerate-worker';

/** How often to look for due jobs. The jobs themselves carry their own
 *  schedules (`next_run_at`), so this only sets how promptly a due one is
 *  noticed. */
const TICK_INTERVAL_MS = 5 * 60 * 1000;

/** Jobs per tick. Small on purpose: enumeration competes with agent work for
 *  the same vendor quota, and the census is never the urgent thing. */
const JOBS_PER_TICK = 3;

export function isCensusEnabled(): boolean {
  return process.env.CENSUS_ENABLED === '1';
}

/**
 * May this connector be enumerated?
 *
 * NO for anything Composio routes, unless an operator has explicitly said the
 * tier decision is made. Composio bills ONE organization-wide meter — 20,000
 * tool calls a month across every tenant on the free tier — and roughly ninety
 * connectors route through it. Enumerating those would spend the platform's
 * whole monthly budget on bookkeeping, and it would spend it on the exact
 * budget the quota governance exists to protect.
 *
 * A connector that does NOT route through Composio has its own vendor limits,
 * which the job's parking behaviour already respects.
 */
export function isEnumerableConnector(connectorType: string): boolean {
  if (!COMPOSIO_MANAGED_TYPES.has(connectorType)) return true;
  return process.env.CENSUS_INCLUDE_COMPOSIO === '1';
}

/**
 * Create enumeration jobs for connectors that declare list functions and do not
 * have one yet.
 *
 * Idempotent: `ON CONFLICT DO NOTHING` against the (tenant, connector, scope)
 * unique key, so a repeated tick adds nothing and an operator can call it after
 * connecting something new.
 */
export async function ensureEnumerationJobs(tenant: string): Promise<number> {
  const { withTenantScope } = await import('../infrastructure/database');
  const pool = getPoolForService('default');

  const manifests = await pool.query<{ id: string; connector_type: string }>(
    `SELECT id, connector_type FROM connector_manifests
      WHERE tenant_id = $1 AND enabled = true`,
    [tenant],
  );

  let created = 0;
  let skippedComposio = 0;
  for (const m of manifests.rows) {
    if (!isEnumerableConnector(m.connector_type)) {
      skippedComposio++;
      continue;
    }
    for (const fn of enumerableFunctions(m.connector_type)) {
      const inserted = await withTenantScope(tenant, (client) =>
        client.query(
          `INSERT INTO connector_enumeration_state
             (tenant_id, connector_id, connector_type, scope)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (tenant_id, connector_id, scope) DO NOTHING`,
          [tenant, m.id, m.connector_type, fn.name],
        ),
      );
      created += inserted.rowCount ?? 0;
    }
  }

  // Said out loud rather than left as a silent omission: an operator looking at
  // a thin census needs to know the difference between "nothing to enumerate"
  // and "most of the catalogue is deliberately excluded".
  if (skippedComposio > 0) {
    logger.info(
      {
        metric: 'census.composio_connectors_skipped',
        tenantId: tenant,
        skipped: skippedComposio,
        reason: 'composio_shared_monthly_quota',
      },
      'census: Composio-routed connectors are excluded until a paid tier is chosen (CENSUS_INCLUDE_COMPOSIO=1 overrides)',
    );
  }
  return created;
}

/** One pass: claim what is due and run it. Exported so an operator or a test
 *  can drive a single tick without waiting for the interval. */
export async function runEnumerationTick(tenant: string): Promise<{ jobsRun: number; entities: number }> {
  const jobs = await claimDueJobs(tenant, JOBS_PER_TICK);
  if (jobs.length === 0) return { jobsRun: 0, entities: 0 };

  const source = buildConnectorEnumerationSource({
    toolGateway: toolGatewayService,
    // The census is platform bookkeeping, not an agent's work. It carries the
    // tenant's identity and no agent's, so nothing it does is attributed to an
    // agent that did not ask for it.
    agentId: 'census',
    instructionVersion: 0,
    traceId: `census-${tenant}`,
  });

  let entities = 0;
  for (const job of jobs) {
    const outcome = await runEnumerationJob({ job, source });
    entities += outcome.entitiesUpserted;
    logger.info(
      {
        metric: 'census.job_complete',
        tenantId: tenant,
        connectorType: job.connectorType,
        scope: job.scope,
        upserted: outcome.entitiesUpserted,
        markedDeleted: outcome.entitiesMarkedDeleted,
        batchKind: outcome.batchKind,
        parkedForMs: outcome.parkedForMs,
        error: outcome.error,
      },
      'census enumeration job finished',
    );
  }
  return { jobsRun: jobs.length, entities };
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Start the census loop. No-op unless `CENSUS_ENABLED=1`, and it says which
 *  of the two it did — a background job that is merely silent is
 *  indistinguishable from one that is broken. */
export function startEnumerationScheduler(): void {
  if (!isCensusEnabled()) {
    logger.info({ event: 'census_scheduler_disabled' }, 'census scheduler not started (CENSUS_ENABLED != 1)');
    return;
  }
  if (timer) return;

  logger.info({ event: 'census_scheduler_started', intervalMs: TICK_INTERVAL_MS }, 'census scheduler started');

  timer = setInterval(() => {
    void (async () => {
      // Every tenant this runtime serves, not one of them. Tenant ids come from
      // the `tenants` table and never from process.env.TENANT_ID: that variable
      // holds the tenant SLUG, and every column here is a UUID, so a slug is a
      // cast error on every tick — which reads as the scheduler being broken
      // rather than as the wrong identifier.
      try {
        await forEachTenant('census-tick', async (tenant) => {
          await ensureEnumerationJobs(tenant);
          await runEnumerationTick(tenant);
        });
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'census_tick_failed');
      }
    })();
  }, TICK_INTERVAL_MS);
  timer.unref();
}

/** Stop the loop. Used by shutdown and by tests. */
export function stopEnumerationScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
