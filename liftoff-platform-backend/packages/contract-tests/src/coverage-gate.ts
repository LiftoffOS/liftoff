// Coverage gate (Phase 0c). Asserts every Connect-RPC method in the
// four new services has a contract fixture ($def) registered. Run as a
// CI gate — fails the build if a proto RPC lacks validators.
//
// Source of truth: static list below, updated in lockstep with the
// proto surface in liftoff-proto. CI step enforces that every $def
// named `<RpcName>Request` and `<RpcName>Response` exists in the
// corresponding service schema.

import billingSchema from '../fixtures/billing-service.schema.json';
import developerProxySchema from '../fixtures/developer-proxy-service.schema.json';
import workforceSchema from '../fixtures/workforce-service.schema.json';

/** Every RPC name across the four Phase 0a services. */
export const EXPECTED_RPCS: Record<string, string[]> = {
  billing: [
    'GetSubscription',
    'ReportUsage',
    'ReconcileMeters',
    'ListInvoices',
    'CreateCheckoutSession',
    'ReplayEvents',
    'ExportTenantData',
    'DeleteTenantUserData',
  ],
  developerProxy: [
    'CreateCredential',
    'ListCredentials',
    'RevokeCredential',
    'GetUsage',
    'InitiatePkceSetup',
    'CompletePkceSetup',
    'ExportTenantData',
    'DeleteTenantUserData',
  ],
  workforce: [
    'DraftPlan',
    'CommitPlan',
    'GetPlan',
    'ListPlans',
    'ResumeStuckPlan',
    'GetCAIOToolDefinitions',
    'ExportTenantData',
    'DeleteTenantUserData',
  ],
};

const schemaByService: Record<string, { $defs?: Record<string, unknown> }> = {
  billing: billingSchema,
  developerProxy: developerProxySchema,
  workforce: workforceSchema,
};

export interface CoverageGateResult {
  passed: boolean;
  missing: Array<{ service: string; rpc: string; missing: 'Request' | 'Response' | 'both' }>;
}

export function checkCoverage(): CoverageGateResult {
  const missing: CoverageGateResult['missing'] = [];
  for (const [service, rpcs] of Object.entries(EXPECTED_RPCS)) {
    const defs = schemaByService[service]?.$defs ?? {};
    for (const rpc of rpcs) {
      const hasReq = Object.hasOwn(defs, `${rpc}Request`);
      const hasResp = Object.hasOwn(defs, `${rpc}Response`);
      if (!hasReq && !hasResp) {
        missing.push({ service, rpc, missing: 'both' });
      } else if (!hasReq) {
        missing.push({ service, rpc, missing: 'Request' });
      } else if (!hasResp) {
        missing.push({ service, rpc, missing: 'Response' });
      }
    }
  }
  return { passed: missing.length === 0, missing };
}

/** CLI entry point — `node dist/coverage-gate.js`. Exits non-zero on failure. */
export function runCliCoverageGate(): void {
  const result = checkCoverage();
  if (result.passed) {
    console.log('[contract-coverage-gate] OK — all contract RPCs have request + response fixtures.');
    return;
  }
  console.error('[contract-coverage-gate] FAIL — missing fixtures:');
  for (const m of result.missing) {
    console.error(`  ${m.service}.${m.rpc} missing ${m.missing}`);
  }
  process.exit(1);
}
