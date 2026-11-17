// Independent central auditor for agent schedulers. Runs hourly from
// YOUR_CONTROL_PROJECT, completely separate from the per-tenant
// reconciler. Catches the "reconciler is broken" failure mode that the
// reconciler's own metrics can't catch (because broken reconciler ⇒ no
// metrics written ⇒ no alert fires from Layer A alone).
//
// Design: count-based comparison per tenant. We don't need to translate
// internal_agent_id → localAgentId; we just compare totals. Drill-down for
// "which agent is missing" requires opening the tenant project, which is
// acceptable for alerts that should be rare in steady-state.

import { CloudSchedulerClient } from '@google-cloud/scheduler';
import { MetricServiceClient } from '@google-cloud/monitoring';
import { closePools, withAdminScope } from '../infrastructure/database';
import { log } from '../infrastructure/logging';

const PROJECT_ID = process.env.GCP_PROJECT_ID || 'YOUR_CONTROL_PROJECT';
const REGION = 'us-west1';
const METRIC_PREFIX = 'custom.googleapis.com/agent_scheduler';

const schedulerClient = new CloudSchedulerClient();
const metricClient = new MetricServiceClient();

interface TenantCronAgent {
  tenant_id: string;
  tenant_project_id: string;    // from tenants.gcp_project_id — used to list schedulers
  cron_agent_count: number;     // count(*) WHERE status='active' AND trigger_config->>'type'='cron'
}

interface TenantSchedulerCounts {
  enabled: number;
  paused: number;
  disabled: number;
  total: number;
}

// The `tenants` table has no `slug` or `deleted_at` columns (verified against
// prod schema); it has `gcp_project_id` (which is exactly what we need to call
// listJobs cross-project) and `status` (which we filter on instead of
// deleted_at). Excluded statuses below match the convention used elsewhere
// in platform-backend for "this tenant is no longer operational".
async function listTenantCronExpectations(): Promise<TenantCronAgent[]> {
  return withAdminScope(
    { caller: 'audit-agent-schedulers', reason: 'list tenants with active cron agents' },
    async (c) => {
      const r = await c.query<TenantCronAgent>(
        `SELECT t.id AS tenant_id,
                t.gcp_project_id AS tenant_project_id,
                COUNT(ia.id)::int AS cron_agent_count
           FROM tenants t
           LEFT JOIN internal_agents ia
             ON ia.tenant_id = t.id
            AND ia.deleted_at IS NULL
            AND ia.status = 'active'
            AND ia.trigger_config->>'type' = 'cron'
          WHERE t.gcp_project_id IS NOT NULL
            AND t.status NOT IN ('deleted', 'pending', 'failed')
          GROUP BY t.id, t.gcp_project_id
         HAVING COUNT(ia.id) > 0`,
      );
      return r.rows;
    },
  );
}

async function listTenantSchedulers(tenantProjectId: string, tenantId: string): Promise<TenantSchedulerCounts | null> {
  const parent = schedulerClient.locationPath(tenantProjectId, REGION);
  const counts: TenantSchedulerCounts = { enabled: 0, paused: 0, disabled: 0, total: 0 };
  const prefix = `liftoffos-agent-${tenantId}-`;

  try {
    const [jobs] = await schedulerClient.listJobs({ parent });
    for (const job of jobs) {
      const shortName = (job.name ?? '').split('/').pop() ?? '';
      if (!shortName.startsWith(prefix)) continue;
      counts.total++;
      const state = String(job.state ?? '');
      if (state === 'ENABLED') counts.enabled++;
      else if (state === 'PAUSED') counts.paused++;
      else if (state === 'DISABLED') counts.disabled++;
    }
    return counts;
  } catch (err) {
    log.error({ tenantProjectId, err: (err as Error).message }, 'listJobs failed for tenant project');
    return null;
  }
}

// Liveness + reachability, emitted on EVERY run regardless of what the audit
// found. Layer C watches this rather than the per-tenant metrics below,
// because those are legitimately empty whenever no tenant has a cron agent
// (dev, routinely) — an absence alert on them cannot tell "auditor is dead"
// from "auditor ran and had nothing to say". This one is unconditional, so
// its absence means exactly one thing.
//
// `unreachable` is the signal the tenant loop's comment promised and never
// emitted: a tenant the auditor cannot see was silently `continue`d, so a
// permission failure looked identical to a clean audit. That is how this job
// sat at 129 consecutive failures with every downstream layer reporting green.
async function emitAuditorLiveness(audited: number, unreachable: number): Promise<void> {
  const now = { seconds: Math.floor(Date.now() / 1000) };
  const point = (type: string, value: number) => ({
    metric: { type: `${METRIC_PREFIX}/${type}`, labels: {} },
    resource: { type: 'global', labels: { project_id: PROJECT_ID } },
    points: [{ interval: { endTime: now }, value: { int64Value: String(value) } }],
  });

  await metricClient.createTimeSeries({
    name: `projects/${PROJECT_ID}`,
    timeSeries: [
      point('auditor_heartbeat', 1),
      point('auditor_audited_count', audited),
      point('auditor_unreachable_count', unreachable),
    ] as never,
  });
}

async function emitAuditMetrics(rows: Array<{
  tenant_id: string;
  expected: number;
  enabled: number;
  paused: number;
  disabled: number;
  missing: number;
}>): Promise<void> {
  if (rows.length === 0) return; // createTimeSeries rejects empty timeSeries

  const now = { seconds: Math.floor(Date.now() / 1000) };
  const series = rows.flatMap((row) =>
    (['expected', 'enabled', 'paused', 'disabled', 'missing'] as const).map((kind) => ({
      metric: {
        type: `${METRIC_PREFIX}/${kind}_count`,
        labels: { tenant_id: row.tenant_id, source: 'auditor' },
      },
      resource: { type: 'global', labels: { project_id: PROJECT_ID } },
      points: [{
        interval: { endTime: now },
        value: { int64Value: String(row[kind]) },
      }],
    })),
  );

  // createTimeSeries has a hard limit of 200 time series per request — chunk.
  const CHUNK = 150;
  for (let i = 0; i < series.length; i += CHUNK) {
    await metricClient.createTimeSeries({
      name: `projects/${PROJECT_ID}`,
      timeSeries: series.slice(i, i + CHUNK) as never,
    });
  }
}

async function main(): Promise<void> {
  // No initDatabase() — withAdminScope lazily builds its own admin pool
  // (ensureAdminPool in infrastructure/database.ts). Calling initDatabase()
  // here would open a second, unused default pool whose only effect is one
  // extra DB connection held until closePools() runs.

  const expectations = await listTenantCronExpectations();
  log.info({ tenant_count: expectations.length }, 'audit-agent-schedulers started');

  const results: Array<{
    tenant_id: string;
    expected: number;
    enabled: number;
    paused: number;
    disabled: number;
    missing: number;
  }> = [];

  let unreachable = 0;

  for (const e of expectations) {
    const counts = await listTenantSchedulers(e.tenant_project_id, e.tenant_id);
    if (!counts) {
      // Counted, not just logged — see emitAuditorLiveness. A log line is not
      // a signal: nothing alerts on it, and the audit still exits 0.
      unreachable++;
      log.warn({ tenant_id: e.tenant_id, tenant_project_id: e.tenant_project_id },
        'tenant project unreachable; skipping in audit');
      continue;
    }
    const missing = Math.max(0, e.cron_agent_count - counts.enabled - counts.paused - counts.disabled);
    results.push({
      tenant_id: e.tenant_id,
      expected: e.cron_agent_count,
      enabled: counts.enabled,
      paused: counts.paused,
      disabled: counts.disabled,
      missing,
    });

    if (counts.enabled !== e.cron_agent_count) {
      log.warn({
        event: 'agent_scheduler_audit_drift',
        tenant_id: e.tenant_id,
        tenant_project_id: e.tenant_project_id,
        expected: e.cron_agent_count,
        enabled: counts.enabled,
        paused: counts.paused,
        disabled: counts.disabled,
        missing,
      }, 'tenant has scheduler drift — investigate in tenant project');
    }
  }

  await emitAuditMetrics(results);
  await emitAuditorLiveness(results.length, unreachable);
}

// Use closePools() (not getPool().end()) so BOTH the default pool AND the
// admin pool opened by withAdminScope are torn down. Without this, the admin
// pool's TCP keepalive keeps the event loop alive and the Cloud Run Job hangs
// until task-timeout (1800s) kills it.
main()
  .then(async () => {
    await closePools();
    process.exit(0);
  })
  .catch(async (err) => {
    log.error({ err: (err as Error).message }, 'audit-agent-schedulers failed');
    await closePools().catch(() => undefined);
    process.exit(1);
  });
