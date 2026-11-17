// restamp-workspace-ai-policies — the platform's internal switch lever for the
// Workspace AI constants (model-registry/workspace-ai-vendors.ts).
//
// ITS REASON FOR EXISTING IS BEING REMOVED, and this run is how. A policy no
// longer holds a resolved model id: `buildWorkspaceAiPolicy` writes the provider
// and the tier and the runtime resolves the model against the registry on every
// call. So the rebuild below now DROPS the stale ids from every stored policy
// rather than refreshing them — one sweep, after which there is nothing left for
// a model upgrade to reach. Expect it to rewrite every tenant exactly once (the
// stored policy carries ids, the rebuilt one does not, so they compare unequal),
// then go quiet and stay quiet.
//
// Once that sweep has run in every environment this script and its deploy step
// should go. It is kept for now because a policy written by an older release can
// still arrive, and because deleting the sweep before it has swept would leave
// the ids in place with nothing that removes them.
//
// What it did, and why the materialisation was the defect:
//
// Vendor-map and background-task assignments WERE materialized into each
// tenant's model_configs.routing_policy at write time, so editing the central
// constants alone did not reach tenants already stamped. This script closed
// the loop: for every tenant with a config row, read its selectedVendor marker
// (absent → 'default'), rebuild the policy through buildWorkspaceAiPolicy with
// the CURRENT constants, and write it through setWorkspaceVendor — preserving
// the single-row invariant and firing the standard tenant.model_config.updated
// sync events to the runtimes. Tenants' own selections are untouched by
// construction (the rebuild starts from each tenant's stored marker).
//
// THIS RUNS ON EVERY DEPLOY (cloudbuild.yaml, after the service is live), which
// is what makes a model upgrade SWEEPING. A tier change — a new large model, a
// vendor's ladder moving a generation — has to reach the tenants that already
// exist, not only the ones created afterwards. Left as a lever somebody
// remembers to pull, it does not get pulled: when the OpenAI ladder moved to
// the GPT-6 line, every existing workspace was still stamped on the generation
// before it, and the default-vendor workspaces were two Anthropic generations
// behind that, because the last person to change a tier did not run this.
//
// UNCHANGED TENANTS ARE SKIPPED, and that skip is what makes running it on
// every deploy safe rather than merely possible. setWorkspaceVendor upserts
// unconditionally and publishes unconditionally, so without the comparison
// every release would bump every tenant's config version and emit one event per
// tenant per deploy — turning `version` from a change signal into a deploy
// counter and waking every runtime for nothing.
//
// The counts below MEASURE rather than tally: a tenant only lands in
// `restamped` when its stored policy actually differed, and the line logged for
// it names the before and after. A run that reports 0 restamped and N unchanged
// is a real statement that the estate is already current — which is the whole
// point of a check that runs unattended.
//
// Usage: node dist/scripts/restamp-workspace-ai-policies.js
// Idempotent: a second run restamps nothing.

import { initSecrets } from '../infrastructure/secrets';
import { initDatabase, withAdminScope, closePools } from '../infrastructure/database';
import { ModelRegistryService } from '../model-registry/service';
import { refreshWorkspaceAiVendorModels } from '../model-registry/workspace-ai-vendor-loader';
import {
  buildWorkspaceAiPolicy,
  isWorkspaceAiSelection,
  routingPolicyEquals,
  type WorkspaceAiSelection,
} from '../model-registry/workspace-ai-vendors';
import type { RoutingPolicy } from '../model-registry/types';
import { log } from '../infrastructure/logging';

/** The model ids a policy names, flattened for a readable before/after line.
 *  The default model first because it is the one a reader is looking for. */
function modelsOf(policy: RoutingPolicy | undefined): string {
  if (!policy) return '<none>';
  const tasks = Object.entries(policy.taskOverrides ?? {})
    .filter(([task]) => task !== 'embedding')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([task, model]) => `${task}=${model}`);
  return [`default=${policy.defaultModel ?? '?'}`, ...tasks].join(' ');
}

async function main(): Promise<void> {
  await initSecrets();
  await initDatabase();

  // What a tier means for a vendor comes from the `models` registry, applied
  // over the static seed by workspace-ai-vendor-loader. That loader runs in the
  // API process; this is a Job and has to load the same rows itself. Without
  // this, a re-stamp writes the BOOTSTRAP seed while PATCH /api/tenants/:id
  // writes the registry, and the two disagree tenant by tenant depending on
  // which last touched the row — the drift this whole mechanism removes.
  //
  // Deliberately NOT caught: a registry read that failed knows nothing about
  // what a tier means, and stamping the seed across the estate on that answer
  // is worse than not stamping at all. The rejection handler below exits 1.
  const applied = await refreshWorkspaceAiVendorModels();
  log.info({ applied }, 'restamp: workspace AI vendor map loaded from the registry');

  // Enumerate tenants with a config row. model_configs is RLS-scoped; this is
  // a deliberate cross-tenant operator read, so it goes through withAdminScope
  // with an explicit caller/reason per docs/rls.md.
  //
  // The WHOLE policy is read, not just the marker: the comparison below needs
  // what is actually stored, and reading only the marker is what would force an
  // unconditional write.
  const rows = await withAdminScope(
    {
      caller: 'scripts/restamp-workspace-ai-policies',
      reason: 'operator re-stamp: enumerate tenant ids + routing policies across tenants',
    },
    (client) => client.query<{ tenant_id: string; routing_policy: RoutingPolicy | null }>(
      `SELECT tenant_id, routing_policy FROM model_configs`,
    ),
  );

  const service = new ModelRegistryService();
  let restamped = 0;
  let unchanged = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows.rows) {
    const current = row.routing_policy ?? undefined;
    const marker = current?.selectedVendor ?? null;
    const selection: WorkspaceAiSelection =
      marker != null && isWorkspaceAiSelection(marker) ? marker : 'default';
    if (marker != null && !isWorkspaceAiSelection(marker)) {
      // A marker this build does not recognize (e.g. a vendor removed from the
      // constants). Do NOT silently rewrite the tenant onto 'default' — that
      // would change their selection without consent. Skip loudly instead.
      log.error(
        { tenantId: row.tenant_id, marker },
        'restamp: unrecognized selectedVendor marker — tenant SKIPPED; resolve the marker before re-running',
      );
      skipped++;
      continue;
    }

    // Build the policy this tenant WOULD get, and write only if it differs.
    // buildWorkspaceAiPolicy is pure and is the same function setWorkspaceVendor
    // calls, so this is the real comparison rather than an approximation of it.
    const next = buildWorkspaceAiPolicy(selection, current);
    if (routingPolicyEquals(current, next)) {
      unchanged++;
      continue;
    }

    try {
      await service.setWorkspaceVendor(row.tenant_id, selection);
      restamped++;
      log.info(
        {
          tenantId: row.tenant_id,
          selection,
          before: modelsOf(current),
          after: modelsOf(next),
        },
        'restamp: tenant policy moved',
      );
    } catch (err) {
      failed++;
      log.error(
        { tenantId: row.tenant_id, selection, err: (err as Error).message },
        'restamp: setWorkspaceVendor failed for tenant',
      );
    }
  }

  log.info(
    { restamped, unchanged, skipped, failed, total: rows.rows.length },
    'workspace-ai policy re-stamp complete',
  );
  if (failed > 0) process.exitCode = 1;
}

main().then(
  () => closePools().then(() => process.exit(process.exitCode ?? 0)),
  (err) => {
    log.error({ err }, 'workspace-ai policy re-stamp failed');
    closePools().finally(() => process.exit(1));
  },
);
