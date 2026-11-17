// Integration test (plan §8.1, §8.3): exercises the agent-creation pipeline
// against the dev environment.
//
// Auth model:
//   - PB Cloud Run is deployed with invokers=["allUsers"]; app-level
//     requireSchedulerOidc gates /reconcile-runtime-state by verifying the
//     OIDC token's email claim matches CLOUD_SCHEDULER_SA_EMAIL.
//   - CI authenticates via WIF to an SA that has been granted
//     iam.serviceAccountTokenCreator on the scheduler SA so it can impersonate
//     it. The helper getSchedulerOidc mints a token with the right `email`
//     claim.
//
// Why not a Firebase create→chat-turn round trip: that requires a Firebase
// user JWT which can't be minted from a CI SA. Instead this suite asserts the
// invariant that matters: for a known-good canary
// tenant, the steady-state reconciler reports ZERO drift across all five
// drift modes. If create→Pub/Sub→runtime→mapping→instruction is broken end
// to end, the canary tenant accumulates drift and this fails CI.

import { getSchedulerOidc } from './helpers/getRuntimeOidc';

const PB_URL = process.env.PB_URL ?? 'https://api.example.com';
const CANARY_TENANT_ID = process.env.INTEGRATION_CANARY_TENANT_ID ?? '';

const shouldRun = process.env.INTEGRATION_BACKEND === 'dev' && !!PB_URL;
const maybeDescribe = shouldRun ? describe : describe.skip;

interface ReconcileSummary {
  tenantsScanned: number;
  agentsScanned: number;
  drift: Record<string, number>;
  republished: { created: number; updated: number; deleted: number };
  orphansInRuntime: Array<{ tenantId: string; runtimeAgentId: string }>;
  errors: number;
}

async function callReconciler(tenantId?: string): Promise<{ status: number; summary?: ReconcileSummary }> {
  const oidc = await getSchedulerOidc(PB_URL);
  const url = new URL('/api/internal-agents/reconcile-runtime-state', PB_URL);
  url.searchParams.set('dryRun', 'true');
  if (tenantId) url.searchParams.set('tenantId', tenantId);
  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: { Authorization: `Bearer ${oidc}` },
  });
  if (res.status !== 200) return { status: res.status };
  return { status: res.status, summary: await res.json() as ReconcileSummary };
}

maybeDescribe('agent creation pipeline — reconciler smoke', () => {
  jest.setTimeout(120_000);

  it('POST /api/internal-agents/reconcile-runtime-state returns a well-formed ReconcileSummary', async () => {
    const { status, summary } = await callReconciler();
    expect(status).toBe(200);
    expect(summary).toMatchObject({
      tenantsScanned: expect.any(Number),
      agentsScanned: expect.any(Number),
      drift: expect.any(Object),
      republished: expect.any(Object),
      errors: expect.any(Number),
    });
    expect(summary!.drift).toMatchObject({
      missing_create: expect.any(Number),
      missing_instruction: expect.any(Number),
      stale_update: expect.any(Number),
      missed_delete: expect.any(Number),
      orphan_in_runtime: expect.any(Number),
    });
  });

  it('rejects an unauthenticated POST with 401', async () => {
    const res = await fetch(`${PB_URL}/api/internal-agents/reconcile-runtime-state?dryRun=true`, {
      method: 'POST',
    });
    expect([401, 403]).toContain(res.status);
  });

  it('steady-state drift snapshot is bounded (sanity check for the pipeline)', async () => {
    const { status, summary } = await callReconciler();
    expect(status).toBe(200);
    if (summary!.agentsScanned > 0) {
      const totalDrift = Object.values(summary!.drift).reduce((a, b) => a + b, 0);
      const driftRatio = totalDrift / summary!.agentsScanned;
      expect(driftRatio).toBeLessThan(0.25);
    }
    expect(summary!.errors).toBeLessThan(summary!.tenantsScanned + 1);
  });
});

// User-flow guarantee (plan §8.3 / §16 acceptance #7): for a known-good canary
// tenant the steady-state reconciler reports ZERO drift on every drift mode.
// Failing this means the create → Pub/Sub → runtime → mapping → instruction
// pipeline is broken for that tenant.
//
// Set INTEGRATION_CANARY_TENANT_ID to a tenant whose agents are NOT under
// active human curation (a stable test fixture). Skipped when the env var
// is unset so the rest of the suite still runs.
const maybeCanary = shouldRun && CANARY_TENANT_ID.length > 0 ? describe : describe.skip;
maybeCanary('agent creation pipeline — canary tenant zero-drift assertion', () => {
  jest.setTimeout(120_000);

  it(`tenant ${CANARY_TENANT_ID} has zero drift across all 5 modes`, async () => {
    const { status, summary } = await callReconciler(CANARY_TENANT_ID);
    expect(status).toBe(200);
    expect(summary!.tenantsScanned).toBe(1);
    // Hard assertion: ALL drift counts must be 0 for the canary tenant.
    // Any positive count means an agent in this tenant is missing its mapping
    // or compiled_instruction — i.e. the publish→consume→mapping path failed.
    expect(summary!.drift).toEqual({
      missing_create: 0,
      missing_instruction: 0,
      stale_update: 0,
      missed_delete: 0,
      orphan_in_runtime: 0,
    });
    expect(summary!.errors).toBe(0);
  });
});
