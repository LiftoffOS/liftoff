// B5 — fleet-harvest config parsing.
//
// Multi-tenant diagnostics need a per-tenant harness URL + service token (one global token has
// no path to another tenant's runtime). Enrollment is a CSV env var generated from the
// terraform fleet map. These helpers are pure/env-injectable so the parsing + skip semantics are
// unit-testable without running the diagnostics script (which executes on import).

import { logger as log } from '../infrastructure/logging';

/** Where to reach ONE tenant's runtime harness. */
export interface HarvestEndpoint {
  harnessUrl: string | undefined;
  serviceToken: string | undefined;
}

export interface FleetTenant {
  tenantId: string;
  harnessUrl: string;
  tokenEnvName: string;
}

/** Parse DIAGNOSTICS_FLEET_TENANTS — a CSV of `tenantId=harnessUrl=tokenEnvName` triples (the
 *  terraform fleet map generates all three). Splits on the FIRST and LAST '=' so a harness URL
 *  containing '=' survives. Malformed entries are skipped (not thrown). Token resolution is
 *  separate (resolveFleetEndpoints) so parsing is env-independent. */
export function parseFleetTenants(csv: string | undefined): FleetTenant[] {
  if (!csv) return [];
  const out: FleetTenant[] = [];
  for (const raw of csv.split(',')) {
    const entry = raw.trim();
    if (!entry) continue;
    const firstEq = entry.indexOf('=');
    const lastEq = entry.lastIndexOf('=');
    if (firstEq < 0 || firstEq === lastEq) continue; // need at least two '='
    const tenantId = entry.slice(0, firstEq).trim();
    const harnessUrl = entry.slice(firstEq + 1, lastEq).trim();
    const tokenEnvName = entry.slice(lastEq + 1).trim();
    if (!tenantId || !harnessUrl || !tokenEnvName) continue;
    out.push({ tenantId, harnessUrl, tokenEnvName });
  }
  return out;
}

/** Resolve each fleet tenant's per-tenant token from its named env var. A tenant whose token env
 *  is missing is SKIPPED + logged — never falls back to another tenant's token. */
export function resolveFleetEndpoints(
  fleet: FleetTenant[],
  env: NodeJS.ProcessEnv = process.env,
): Array<{ tenantId: string; endpoint: HarvestEndpoint }> {
  const out: Array<{ tenantId: string; endpoint: HarvestEndpoint }> = [];
  for (const t of fleet) {
    const serviceToken = env[t.tokenEnvName];
    if (!serviceToken) {
      log.warn({ message: 'fleet tenant token env missing — skipping tenant', tenant: t.tenantId, tokenEnvName: t.tokenEnvName });
      continue;
    }
    out.push({ tenantId: t.tenantId, endpoint: { harnessUrl: t.harnessUrl, serviceToken } });
  }
  return out;
}

/** The test-harness router's mount prefix on every tenant agent-service (TR index.ts:
 *  `app.use('/api/internal/test-harness', testHarnessRouter)`). harvestViaTR is handed the
 *  run-agent URL (matching the DIAGNOSTICS_TR_HARNESS_URL shape) and swaps the trailing path to
 *  /harvest itself. */
const TEST_HARNESS_RUN_AGENT_PATH = '/api/internal/test-harness/run-agent';

/** Build a tenant's harness (run-agent) URL from its base runtime_url. `runtime_url` is the base
 *  Cloud Run service URL — paths are appended to it (the reconciler does the same:
 *  `${runtimeUrl}/internal/agents/sync-state`). */
export function harnessUrlForRuntime(runtimeUrl: string): string {
  return `${runtimeUrl.replace(/\/+$/, '')}${TEST_HARNESS_RUN_AGENT_PATH}`;
}

interface FleetTenantRow { tenantId: string; runtimeUrl: string }

/** Auto-discover the ACTIVE fleet from PB so eval harvest is DEFAULT for every execution-enabled
 *  tenant with a runtime_url — no manual per-tenant enrollment. Calls PB's internal
 *  `/api/internal/diagnostics/fleet-tenants` (PB verifies X-Service-Auth via verifyServiceAuth →
 *  TENANT_RUNTIME_SERVICE_TOKEN; the diagnostics job's DIAGNOSTICS_SERVICE_TOKEN is that same
 *  shared secret, so one token authenticates both this PB call AND each tenant's TR /harvest).
 *  Returns [] (and logs) on any failure so the caller can fall back to the static CSV. */
export async function discoverFleetEndpoints(
  env: NodeJS.ProcessEnv = process.env,
): Promise<Array<{ tenantId: string; endpoint: HarvestEndpoint }>> {
  const pbUrl = env.PLATFORM_BACKEND_URL;
  const token = env.DIAGNOSTICS_SERVICE_TOKEN;
  if (!pbUrl || !token) {
    log.warn({ message: 'fleet auto-discovery skipped — PLATFORM_BACKEND_URL or DIAGNOSTICS_SERVICE_TOKEN unset', hasUrl: !!pbUrl, hasToken: !!token });
    return [];
  }
  const url = `${pbUrl.replace(/\/+$/, '')}/api/internal/diagnostics/fleet-tenants`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, {
      headers: { 'X-Service-Auth': token, accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) {
      log.warn({ message: 'fleet auto-discovery non-200 — falling back to static enrollment', status: res.status });
      return [];
    }
    const body = (await res.json()) as { tenants?: FleetTenantRow[] };
    const rows = body.tenants ?? [];
    const out = rows
      .filter((r) => r.tenantId && r.runtimeUrl)
      .map((r) => ({
        tenantId: r.tenantId,
        endpoint: { harnessUrl: harnessUrlForRuntime(r.runtimeUrl), serviceToken: token } as HarvestEndpoint,
      }));
    log.info({ message: 'fleet auto-discovered', tenants: out.length });
    return out;
  } catch (err) {
    log.warn({ message: 'fleet auto-discovery failed — falling back to static enrollment', err: (err as Error).message });
    return [];
  } finally {
    clearTimeout(timer);
  }
}
