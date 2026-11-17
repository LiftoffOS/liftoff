// Converge `agent_execution_allowed` with the account's provisioned billing.
//
// The flag only ever becomes TRUE through three event-driven paths: tenant
// activation that finds an already-active subscription, the
// subscription-activated webhook, and the provisioning outbox worker. A tenant
// that misses all three keeps FALSE with nothing to notice, because nothing
// about it looks broken: the tenant is `active`, its dashboard renders, and
// only agent execution is refused.
//
// The rule this converges on: an ACTIVE tenant whose account has a
// billing_controls row has had billing provisioned, so execution is allowed.
//
// Suspension does not travel on this flag. The entitlement snapshot carries
// `billing_controls.suspended` separately as `billingSuspended` and
// execution-guard reads both, so enabling here grants no spend that a
// suspension would not still stop. That separation is why the rule can key on
// the row's EXISTENCE and ignore its contents.
//
// A tenant whose account has NO billing_controls row is reported and left
// alone. A missing row means an internal/exempt account OR one that was never
// provisioned — opposite answers, with no third fact here to tell them apart.
// Presence is therefore a positive gate only; absence decides nothing.
//
// Writes go through EntitlementService.enableAgentExecution, never a raw
// UPDATE. The raw form leaves `version` unchanged and publishes no event, so a
// runtime holding a cached snapshot keeps refusing execution with no way to
// learn otherwise.
//
// Idempotent, and safe to re-run: the candidate query returns only rows that
// would change, and enableAgentExecution is itself a no-op on a flag that is
// already TRUE. Set DRY_RUN=1 to report without writing.

import { initDatabase, closePools, withAdminScope } from '../infrastructure/database';
import { EntitlementService } from '../entitlements/service';
import { log } from '../infrastructure/logging';

export interface ConvergeResult {
  /** Tenants whose flag was flipped to TRUE through the service. */
  enabled: string[];
  /** Drift this script deliberately refuses to decide. Not a failure. */
  skippedNoBillingControls: string[];
  /** enableAgentExecution threw. Exits non-zero. */
  failed: string[];
}

interface CandidateRow {
  tenant_id: string;
  name: string | null;
  email: string | null;
  billing_provisioned: boolean;
}

// Every ACTIVE tenant whose entitlement still says execution is not allowed —
// both the ones to repair and the ones to report, so the ambiguous cases are
// visible in the same run rather than silently absent from it.
const CANDIDATES = `
  SELECT t.id AS tenant_id,
         t.name,
         ac.email,
         (bc.account_id IS NOT NULL) AS billing_provisioned
    FROM entitlements e
    JOIN tenants t                ON t.id = e.tenant_id
    LEFT JOIN accounts ac         ON ac.id = t.account_id
    LEFT JOIN billing_controls bc ON bc.account_id = t.account_id
   WHERE e.agent_execution_allowed = FALSE
     AND t.status = 'active'
   ORDER BY t.created_at`;

export async function runConvergeAgentExecution(): Promise<ConvergeResult> {
  const dryRun = process.env.DRY_RUN === '1';

  // entitlements is RLS-enabled and this sweep has no single tenant scope, so
  // the candidate LIST is read under admin scope. Each write then opens its own
  // tenant scope inside the service.
  const result = await withAdminScope(
    {
      caller: 'converge-agent-execution-allowed',
      reason: 'list active tenants whose entitlement still refuses execution (cross-tenant, no single scope)',
    },
    (client) => client.query<CandidateRow>(CANDIDATES),
  );

  const out: ConvergeResult = { enabled: [], skippedNoBillingControls: [], failed: [] };
  const entitlementService = new EntitlementService();

  for (const row of result.rows) {
    if (!row.billing_provisioned) {
      out.skippedNoBillingControls.push(row.tenant_id);
      log.warn(
        { tenantId: row.tenant_id, tenantName: row.name, email: row.email },
        'converge: account has no billing_controls row — internal/exempt or never provisioned, leaving alone',
      );
      continue;
    }

    if (dryRun) {
      out.enabled.push(row.tenant_id);
      log.info(
        { tenantId: row.tenant_id, tenantName: row.name, email: row.email },
        'converge: WOULD enable agent execution (DRY_RUN)',
      );
      continue;
    }

    try {
      // A null return means the flag was already TRUE — a race with one of the
      // three event paths, not an error. Counted as enabled either way: the
      // tenant ends the run in the state this script exists to produce.
      await entitlementService.enableAgentExecution(row.tenant_id);
      out.enabled.push(row.tenant_id);
      log.info(
        { tenantId: row.tenant_id, tenantName: row.name, email: row.email },
        'converge: agent execution enabled',
      );
    } catch (err) {
      out.failed.push(row.tenant_id);
      log.error(
        { tenantId: row.tenant_id, err: (err as Error).message },
        'converge: enableAgentExecution failed',
      );
    }
  }

  log.info(
    {
      dryRun,
      enabled: out.enabled.length,
      skippedNoBillingControls: out.skippedNoBillingControls.length,
      failed: out.failed.length,
    },
    'converge-agent-execution-allowed done',
  );
  return out;
}

async function run(): Promise<void> {
  let exitCode = 0;
  try {
    await initDatabase();
    const result = await runConvergeAgentExecution();
    exitCode = result.failed.length > 0 ? 1 : 0;
  } catch (err) {
    log.error({ err: (err as Error).message }, 'converge-agent-execution-allowed: unexpected error');
    exitCode = 1;
  } finally {
    try {
      await closePools();
    } catch (err) {
      // Pool-close noise must not turn a successful convergence into a failure.
      log.error({ err: (err as Error).message }, 'converge-agent-execution-allowed: closePools failed');
    }
  }
  process.exitCode = exitCode;
}

if (require.main === module) {
  void run();
}
