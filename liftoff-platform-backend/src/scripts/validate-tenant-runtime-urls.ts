// Cron-triggered Cloud Run Job. Validates that every tenant.runtime_url:
//   1. Matches the expected derivation from tenant.gcp_project_id (the live
//      Cloud Run agent-service URL in that project).
//   2. Returns 200 on GET /healthz within 5s.
//
// Emits custom metric `custom.googleapis.com/liftoff/tenants/runtime_url_invalid`
// per tenant; alerts at >0 sustained 5 min (C-5).
//
// Does NOT auto-correct — drift may indicate a project move or a deliberate
// rerouting. Surfaces to operators via the metric.

// The @google-cloud/run package exports `v2.ServicesClient`; there is no
// top-level `CloudRunV2Client`. listServices() pages all Cloud Run services
// under the supplied parent location.
import { v2 } from '@google-cloud/run';
import { initSecrets } from '../infrastructure/secrets';
import { initDatabase, closePools, withAdminScope } from '../infrastructure/database';
import { fetchWithOidc } from '../infrastructure/oidc-fetch';
import { writeCustomMetric } from '../infrastructure/monitoring';
import { log } from '../infrastructure/logging';

interface TenantRow {
  id: string;
  runtime_url: string;
  gcp_project_id: string;
}

export async function runValidation(): Promise<{ tenantCount: number; invalidCount: number }> {
  const metricsProject = process.env.INTERNAL_AGENT_METRICS_PROJECT_ID ?? process.env.GCP_PROJECT_ID;

  const tenants = await withAdminScope(
    { caller: 'validate-tenant-runtime-urls', reason: 'list active tenants' },
    (c) => c.query<TenantRow>(
      `SELECT id::text, runtime_url, gcp_project_id
         FROM tenants
        WHERE status = 'active'
          AND runtime_url IS NOT NULL AND runtime_url <> ''
          AND gcp_project_id IS NOT NULL AND gcp_project_id <> ''`,
    ).then((r) => r.rows),
  );

  const runClient = new v2.ServicesClient();
  let invalidCount = 0;

  for (const t of tenants) {
    let invalid = false;
    let reason = '';

    // 1. Derive expected URL from gcp_project_id by listing Cloud Run services
    try {
      const [services] = await runClient.listServices({
        parent: `projects/${t.gcp_project_id}/locations/us-west1`,
      });
      const expected = services.find((s: { name?: string | null; uri?: string | null }) => s.name?.endsWith('/agent-service'))?.uri ?? null;
      if (!expected) {
        invalid = true;
        reason = `no agent-service in ${t.gcp_project_id}`;
      } else if (t.runtime_url !== expected) {
        invalid = true;
        reason = `runtime_url=${t.runtime_url} expected=${expected}`;
      }
    } catch (err) {
      invalid = true;
      reason = `listServices failed: ${(err as Error).message}`;
    }

    // 2. Probe /health (NOT /healthz — Cloud Run's GFE intercepts /healthz at
    //    the platform layer and returns a generic 404 before the container
    //    sees it. /health is mounted in tenant-runtime's index.ts and is
    //    reachable via normal Cloud Run routing.)
    if (!invalid) {
      try {
        const r = await fetchWithOidc(`${t.runtime_url}/health`, { timeoutMs: 5000 });
        if (!r.ok) {
          invalid = true;
          reason = `/health ${r.status}`;
        }
      } catch (err) {
        invalid = true;
        reason = `/health fetch failed: ${(err as Error).message}`;
      }
    }

    await writeCustomMetric({
      metricType: 'custom.googleapis.com/liftoff/tenants/runtime_url_invalid',
      labels: { tenant_id: t.id, gcp_project_id: t.gcp_project_id },
      value: invalid ? 1 : 0,
      projectId: metricsProject,
    });
    if (invalid) {
      invalidCount++;
      log.error(
        { tenantId: t.id, gcp_project_id: t.gcp_project_id, runtime_url: t.runtime_url, reason },
        'runtime_url validation failed',
      );
    }
  }

  log.info({ tenantCount: tenants.length, invalidCount }, 'runtime_url validation complete');
  return { tenantCount: tenants.length, invalidCount };
}

async function main(): Promise<void> {
  await initSecrets();
  await initDatabase();
  try {
    await runValidation();
  } finally {
    await closePools();
  }
}

if (require.main === module) {
  main().then(
    () => process.exit(0),
    (e) => {
      log.error({ err: (e as Error).message, stack: (e as Error).stack }, 'validator failed');
      process.exit(1);
    },
  );
}
