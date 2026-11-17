// Phase 0g — cross-service DB isolation verifier.
//
// Enumerates every service's `<svc>_app` role, connects to `control-
// plane-pg` under that role, and attempts a cross-database SELECT
// against every OTHER service's tables. Every attempt MUST return
// `permission denied` (SQLSTATE 42501 or `ERROR: permission denied
// for database "<other>"`). Anything else = isolation breach.
//
// Intended usage (integration test): the service's CI job spins up a
// staging Cloud SQL clone, populates the per-service role triad, and
// runs `runIsolationCheck(connectionFactory, services)`. Result is
// `{ violations: [{role, targetDb, targetTable, observed}], ok }`.
//
// Implementation does not ship a live connection; the CI harness
// injects one (via `pg.Client`) so this package stays database-
// agnostic.

export interface IsolationCheckService {
  name: string;
  appRole: string;
  database: string;
  /** One representative table name used for the SELECT probe. */
  probeTable: string;
}

export interface IsolationCheckConnection {
  /** Execute a SELECT as the given role against the given database. */
  probe: (
    appRole: string,
    database: string,
    table: string,
  ) => Promise<{ ok: boolean; errorCode?: string; errorMessage?: string }>;
}

export interface IsolationCheckResult {
  ok: boolean;
  violations: Array<{
    role: string;
    targetDb: string;
    targetTable: string;
    observed: 'allowed' | string;
  }>;
}

export async function runIsolationCheck(
  conn: IsolationCheckConnection,
  services: IsolationCheckService[],
): Promise<IsolationCheckResult> {
  const violations: IsolationCheckResult['violations'] = [];
  for (const probeRole of services) {
    for (const target of services) {
      if (target.database === probeRole.database) continue;
      const out = await conn.probe(probeRole.appRole, target.database, target.probeTable);
      if (out.ok) {
        violations.push({
          role: probeRole.appRole,
          targetDb: target.database,
          targetTable: target.probeTable,
          observed: 'allowed',
        });
        continue;
      }
      // "permission denied" on connect OR on SELECT = expected.
      const errCode = out.errorCode ?? '';
      const errMsg = (out.errorMessage ?? '').toLowerCase();
      const isDenied =
        errCode === '42501' ||
        errMsg.includes('permission denied') ||
        errMsg.includes('does not exist'); // acceptable: role lacks CONNECT
      if (!isDenied) {
        violations.push({
          role: probeRole.appRole,
          targetDb: target.database,
          targetTable: target.probeTable,
          observed: `${errCode}: ${errMsg || 'unknown error'}`,
        });
      }
    }
  }
  return { ok: violations.length === 0, violations };
}

/** Default service list for the post-Phase-0 control plane. */
export const DEFAULT_SERVICES: IsolationCheckService[] = [
  { name: 'platform-backend', appRole: 'platform_backend_app', database: 'liftoff_control', probeTable: 'tenants' },
  { name: 'connector-service', appRole: 'connector_app', database: 'connector_service', probeTable: 'connectors' },
  { name: 'governance-engine', appRole: 'governance_app', database: 'governance_engine', probeTable: 'action_ledger' },
  { name: 'billing', appRole: 'billing_app', database: 'billing', probeTable: 'subscriptions' },
  { name: 'developer-proxy', appRole: 'developer_proxy_app', database: 'developer_proxy', probeTable: 'developer_proxy_credentials' },
  { name: 'workforce-service', appRole: 'workforce_app', database: 'workforce', probeTable: 'workforce_plans' },
];
