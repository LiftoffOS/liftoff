#!/usr/bin/env node
/**
 * reconcile-wal-vs-governance.ts — Phase 3d dual-write reconciliation.
 *
 * Runs nightly (Cloud Scheduler) once the backfill is complete and the
 * tenant-runtime starts writing to both its local `governance_wal` table
 * AND the centralized governance-engine. For the last 25 hours, we diff
 * rows by `idempotency_key` and report anything present in one side but
 * not the other.
 *
 * Exit codes:
 *   0 — diff is empty (or both sides empty)
 *   1 — diff non-empty (alert via Cloud Scheduler alerting)
 *   2 — script error (configuration/connectivity)
 *
 * The WAL side is fetched over HTTP from the tenant runtime, NOT by opening
 * its database. It cannot be read directly: YOUR_TENANT_PROJECT is
 * ipv4Enabled=false on YOUR_TENANT_PROJECT, this job runs on
 * vpc-${env}, and the two networks peer only with their own
 * servicenetworking — peering is not transitive. Wiring the five DB arguments
 * this script originally wanted got as far as
 * `failed to dial ... SFEClient is nil`, with both vpc-egress settings; a
 * Cloud SQL socket cannot bridge an unrouted network. The runtime serves
 * GET /api/internal/governance/wal-keys behind the same X-Service-Auth token
 * platform-backend's outbox reconciler already uses, which is a path that
 * demonstrably works.
 *
 * Inputs (env / CLI):
 *   --tenant-id              required, e.g. liftoffos
 *   --tenant-runtime-url     required, base URL of the tenant runtime
 *   --tenant-service-token   required, literal or SM resource
 *   --governance-db-host     private IP or /cloudsql socket path
 *   --governance-db-password literal or SM resource
 *   --window-hours           default 25 (overlap guard)
 */

import { Pool } from 'pg';
import { buildOidcAuthHeader } from '@liftoffos/service-client';

interface Opts {
  tenantId: string;
  tenantRuntimeUrl: string;
  tenantServiceToken: string;
  governanceDbHost: string;
  governanceDbPort: number;
  governanceDbName: string;
  governanceDbUser: string;
  governanceDbPassword: string;
  windowHours: number;
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else {
      out[key] = 'true';
    }
  }
  return out;
}

async function resolve(secretOrLiteral: string): Promise<string> {
  if (!secretOrLiteral.startsWith('projects/')) return secretOrLiteral;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');
  const client = new SecretManagerServiceClient();
  const [version] = await client.accessSecretVersion({ name: secretOrLiteral });
  return version.payload.data.toString('utf8');
}

async function buildOpts(): Promise<Opts> {
  const cli = parseArgs(process.argv.slice(2));
  const pick = (k: string, env: string): string | undefined =>
    cli[k] ?? process.env[env];
  const tenantId = pick('tenant-id', 'RECONCILE_TENANT_ID');
  const tenantRuntimeUrl = pick('tenant-runtime-url', 'RECONCILE_TENANT_RUNTIME_URL');
  const tenantToken = pick('tenant-service-token', 'RECONCILE_TENANT_SERVICE_TOKEN');
  const govDbHost = pick('governance-db-host', 'RECONCILE_GOV_DB_HOST');
  const govPw = pick('governance-db-password', 'RECONCILE_GOV_DB_PASSWORD');
  if (!tenantId || !tenantRuntimeUrl || !tenantToken || !govDbHost || !govPw) {
    throw new Error(
      'reconcile: missing required args (tenant-id, tenant-runtime-url, ' +
      'tenant-service-token, governance-db-host, governance-db-password)',
    );
  }

  return {
    tenantId,
    tenantRuntimeUrl: tenantRuntimeUrl.replace(/\/+$/, ''),
    tenantServiceToken: await resolve(tenantToken),
    governanceDbHost: govDbHost,
    governanceDbPort: Number(pick('governance-db-port', 'RECONCILE_GOV_DB_PORT') ?? 5432),
    governanceDbName: pick('governance-db-name', 'RECONCILE_GOV_DB_NAME') ?? 'governance_engine',
    governanceDbUser: pick('governance-db-user', 'RECONCILE_GOV_DB_USER') ?? 'governance_admin',
    governanceDbPassword: await resolve(govPw),
    windowHours: Number(pick('window-hours', 'RECONCILE_WINDOW_HOURS') ?? 25),
  };
}

export interface ReconcileReport {
  tenantId: string;
  windowHours: number;
  walCount: number;
  govCount: number;
  walNotInGov: string[];
  govNotInWal: string[];
  // Tenant ids the runtime actually reported, and whether they line up with
  // the id this job compares governance rows against. The two are separate
  // identifier spaces (the runtime keys its WAL by whatever the tool-gateway
  // passed; this job is configured with a short name like "liftoffos"), and if
  // they ever diverge the diff below would be total and entirely spurious.
  runtimeTenantIds: string[];
  tenantIdMismatch: boolean;
}

// Fetch the runtime's replicated idempotency keys. A non-200, a network
// failure or a malformed body throws: the caller exits 2 (inconclusive), never
// 1 (drift). An empty key set is a real answer and must never be manufactured
// out of a failure — treating "I could not ask" as "the runtime has nothing"
// would report every governance row as an orphan.
export async function fetchWalKeys(opts: Opts): Promise<{ keys: Set<string>; tenantIds: string[] }> {
  const url = `${opts.tenantRuntimeUrl}/api/internal/governance/wal-keys`
    + `?windowHours=${encodeURIComponent(String(opts.windowHours))}`;

  // Two credentials, and both are required. agent-service enforces IAM
  // run.invoker (its policy names specific service accounts, not allUsers), so
  // Cloud Run rejects the request before Express sees it without the OIDC
  // identity token; X-Service-Auth is the app-layer check behind that. Sending
  // only the service token gets a 403 from the platform that looks nothing
  // like an auth failure in the runtime's logs.
  const oidc = await buildOidcAuthHeader(url);

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      ...oidc,
      'x-service-auth': opts.tenantServiceToken,
    },
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    throw new Error(`reconcile: tenant runtime wal-keys returned ${res.status} ${res.statusText}`);
  }

  const body = await res.json() as { keys?: unknown; tenantIds?: unknown };
  if (!Array.isArray(body.keys)) {
    throw new Error('reconcile: tenant runtime wal-keys returned no keys array');
  }

  return {
    keys: new Set(body.keys.map(String)),
    tenantIds: Array.isArray(body.tenantIds) ? body.tenantIds.map(String) : [],
  };
}

export async function reconcile(opts: Opts): Promise<ReconcileReport> {
  const govPool = new Pool({
    host: opts.governanceDbHost,
    port: opts.governanceDbPort,
    database: opts.governanceDbName,
    user: opts.governanceDbUser,
    password: opts.governanceDbPassword,
    max: 2,
  });

  try {
    const sinceClause = `NOW() - ($1 || ' hour')::interval`;

    // WAL side: keys the runtime says it already replicated, in the window.
    // Every one of them should have landed in governance.actions.
    const { keys: walKeys, tenantIds: runtimeTenantIds } = await fetchWalKeys(opts);

    // Governance side: rows whose idempotency_key was written in the same
    // window. governance-pg stamps created_at on write.
    const govRes = await govPool.query(
      `SELECT idempotency_key FROM actions
        WHERE tenant_id = $2
          AND idempotency_key IS NOT NULL
          AND created_at > ${sinceClause}`,
      [String(opts.windowHours), opts.tenantId],
    );
    const govKeys = new Set<string>(govRes.rows.map(r => r.idempotency_key));

    const walNotInGov: string[] = [];
    for (const k of walKeys) {
      if (!govKeys.has(k)) walNotInGov.push(k);
    }
    const govNotInWal: string[] = [];
    for (const k of govKeys) {
      if (!walKeys.has(k)) govNotInWal.push(k);
    }

    // Only a mismatch when the runtime returned ids at all — an empty WAL
    // window legitimately reports none, and calling that a mismatch would
    // fire on every quiet night.
    const tenantIdMismatch =
      runtimeTenantIds.length > 0 && !runtimeTenantIds.includes(opts.tenantId);

    return {
      tenantId: opts.tenantId,
      windowHours: opts.windowHours,
      walCount: walKeys.size,
      govCount: govKeys.size,
      walNotInGov,
      govNotInWal,
      runtimeTenantIds,
      tenantIdMismatch,
    };
  } finally {
    await govPool.end().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const opts = await buildOpts();
  const report = await reconcile(opts);
  // JSON-on-a-line for Cloud Logging ingestion.
  console.log(JSON.stringify({
    event: 'reconcile_report',
    tenantId: report.tenantId,
    windowHours: report.windowHours,
    walCount: report.walCount,
    govCount: report.govCount,
    walNotInGovCount: report.walNotInGov.length,
    govNotInWalCount: report.govNotInWal.length,
    // Cap the key list to 50 items per side to avoid blowing log line length.
    walNotInGovSample: report.walNotInGov.slice(0, 50),
    govNotInWalSample: report.govNotInWal.slice(0, 50),
    runtimeTenantIds: report.runtimeTenantIds,
    tenantIdMismatch: report.tenantIdMismatch,
  }));

  // A mismatch means the two sides are not describing the same tenant, so the
  // diff below is meaningless rather than alarming. Exit 2 (inconclusive), not
  // 1 (drift) — reporting a fabricated 100% drift would be worse than saying
  // nothing, and this is exactly the shape of defect that let a job report
  // healthy for months.
  if (report.tenantIdMismatch) {
    console.error(JSON.stringify({
      event: 'reconcile_tenant_id_mismatch',
      configured: report.tenantId,
      runtimeReported: report.runtimeTenantIds,
    }));
    process.exit(2);
  }

  const drift = report.walNotInGov.length + report.govNotInWal.length;
  process.exit(drift === 0 ? 0 : 1);
}

if (require.main === module) {
  main().catch(err => {
    console.error('reconcile failed:', err);
    process.exit(2);
  });
}
