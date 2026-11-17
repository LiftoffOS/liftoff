// Ingestion Runner
//
// Orchestrates all cost attribution ingesters. Run by the cost-pass route
// (POST /api/internal/jobs/cost-attribution-ingest): in full by the daily
// housekeeping pass, and scoped to the source that spent when a spend signal
// armed it (maintenance-targets.ts).
// Each ingester is fail-isolated: a failure in one doesn't block others.

import { log } from '../../infrastructure/logging';
import { runPlatformLLMIngester } from './platform-llm-ingester';
import { runRuntimeIngester } from './runtime-ingester';
import { runGovernanceIngester } from './governance-ingester';
import { runDeveloperProxyIngester } from './developer-proxy-ingester';
import { runSandboxIngester } from './sandbox-ingester';
import { runUsageLedgerIngester } from './usage-ledger-ingester';
import type { IngestScope, IngestSource } from './ingest-scope';

export interface IngestStats {
  platformLlm:     { ingested: number; skipped: number; error?: string };
  runtime:         { ingested: number; skipped: number; errors: number; error?: string };
  governance:      { ingested: number; skipped: number; errors: number; error?: string };
  developer_proxy: { ingested: number; skipped: number; error?: string };
  sandbox:         { ingested: number; skipped: number; errors: number; error?: string };
  usageLedger:     { ingested: number; skipped: number; errors: number; error?: string };
}

export async function runAllIngesters(scope: IngestScope = {}): Promise<IngestStats> {
  const want = (source: IngestSource) => !scope.sources || scope.sources.includes(source);
  const tenantId = scope.tenantId;
  const stats: IngestStats = {
    platformLlm:     { ingested: 0, skipped: 0 },
    runtime:         { ingested: 0, skipped: 0, errors: 0 },
    governance:      { ingested: 0, skipped: 0, errors: 0 },
    developer_proxy: { ingested: 0, skipped: 0 },
    sandbox:         { ingested: 0, skipped: 0, errors: 0 },
    usageLedger:     { ingested: 0, skipped: 0, errors: 0 },
  };

  // Platform LLM (reads llm_usage_log in same DB — always available)
  if (want('platformLlm')) {
    try {
      stats.platformLlm = await runPlatformLLMIngester();
      log.info(stats.platformLlm, 'cost-attribution: platform-llm-ingester complete');
    } catch (err) {
      stats.platformLlm.error = (err as Error).message;
      log.error(
        { error: (err as Error).message },
        'cost-attribution: platform-llm-ingester failed',
      );
    }
  }

  // Tenant Runtime (polls each tenant's /api/invocations/ingestion-feed)
  if (want('runtime')) {
    try {
      stats.runtime = await runRuntimeIngester(tenantId);
      log.info(stats.runtime, 'cost-attribution: runtime-ingester complete');
    } catch (err) {
      stats.runtime.error = (err as Error).message;
      log.error(
        { error: (err as Error).message },
        'cost-attribution: runtime-ingester failed',
      );
    }
  }

  // Governance (polls governance-engine /api/governance/actions/ingestion-feed)
  if (want('governance')) {
    try {
      stats.governance = await runGovernanceIngester(tenantId);
      log.info(stats.governance, 'cost-attribution: governance-ingester complete');
    } catch (err) {
      stats.governance.error = (err as Error).message;
      log.error(
        { error: (err as Error).message },
        'cost-attribution: governance-ingester failed',
      );
    }
  }

  // Developer Proxy (polls developer-proxy /api/usage/ingestion-feed)
  if (want('developer_proxy')) {
    try {
      stats.developer_proxy = await runDeveloperProxyIngester();
      log.info(stats.developer_proxy, 'cost-attribution: developer-proxy-ingester complete');
    } catch (err) {
      stats.developer_proxy.error = (err as Error).message;
      log.error(
        { error: (err as Error).message },
        'cost-attribution: developer-proxy-ingester failed',
      );
    }
  }

  // Sandbox (polls each tenant's /api/invocations/sandbox-feed)
  if (want('sandbox')) {
    try {
      stats.sandbox = await runSandboxIngester(tenantId);
      log.info(stats.sandbox, 'cost-attribution: sandbox-ingester complete');
    } catch (err) {
      stats.sandbox.error = (err as Error).message;
      log.error(
        { error: (err as Error).message },
        'cost-attribution: sandbox-ingester failed',
      );
    }
  }

  // Usage Ledger (memory credits + browser-tool events)
  if (want('usageLedger')) {
    try {
      stats.usageLedger = await runUsageLedgerIngester(tenantId);
      log.info(stats.usageLedger, 'cost-attribution: usage-ledger-ingester complete');
    } catch (err) {
      stats.usageLedger.error = (err as Error).message;
      log.error({ error: (err as Error).message }, 'cost-attribution: usage-ledger-ingester failed');
    }
  }

  return stats;
}
