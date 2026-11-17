// Sandbox Ingester
//
// For each active tenant, polls GET /api/invocations/sandbox-feed?since=<ISO>&limit=<n>
// via tenantRuntimeClient and writes sandbox events to cost_attribution_events.
//
// Per-tenant cursors are stored in cost_attribution_cursors with source key
// `sandbox_{tenantId}` (raw pool.query, same pattern as runtime-ingester.ts).
//
// Pricing: 1 credit = $0.001

import { getPool } from '../../infrastructure/database';
import { log } from '../../infrastructure/logging';
import { getSandboxFeed } from '../clients/tenant-runtime-feed';
import { resolveAccountIdForTenant, ingestEventWithBuckets } from '../repository';

const BATCH_SIZE = 500;
const CREDIT_TO_USD = 0.001;

interface TenantRow {
  id: string;
  hosting_mode: string | null;
}

async function getActiveTenants(): Promise<TenantRow[]> {
  const pool = getPool();
  const result = await pool.query<TenantRow>(
    `SELECT id, hosting_mode FROM tenants WHERE status = 'active' OR (status = 'pending' AND runtime_url IS NOT NULL) ORDER BY id`,
  );
  return result.rows;
}

async function getSandboxCursor(tenantId: string): Promise<Date> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT last_ts FROM cost_attribution_cursors WHERE source = $1`,
    [`sandbox_${tenantId}`],
  );
  return (result.rows[0]?.last_ts as Date | undefined) ?? new Date(0);
}

async function updateSandboxCursor(tenantId: string, lastTs: Date): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO cost_attribution_cursors (source, last_ts, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (source) DO UPDATE SET
       last_ts    = EXCLUDED.last_ts,
       updated_at = NOW()`,
    [`sandbox_${tenantId}`, lastTs],
  );
}

async function ingestOneTenant(tenantId: string): Promise<{ ingested: number; skipped: number }> {
  let ingested = 0;
  let skipped  = 0;

  let since = await getSandboxCursor(tenantId);
  let hasMore = true;

  while (hasMore) {
    const feed = await getSandboxFeed(tenantId, since, BATCH_SIZE);
    if (!feed || feed.rows.length === 0) break;

    const accountId = await resolveAccountIdForTenant(tenantId);
    let n = 0;
    if (accountId) {
      for (const row of feed.rows) {
        const inserted = await ingestEventWithBuckets(
          accountId,
          `sandbox_${row.id}`,
          row.creditsConsumed * CREDIT_TO_USD,
          {
            tenantId,
            // Control-plane id preferred; falls back to the runtime id when the
            // feed omits it or the agent is unmapped (INV-TR-010).
            agentId:      row.internalAgentId ?? row.agentId ?? null,
            invocationId: row.invocationId ?? null,
            eventType:    'sandbox',
            source:       'tenant_runtime',
            occurredAt:   new Date(row.timestamp),
          },
        );
        n += inserted > 0 ? 1 : 0;
      }
    }
    ingested += n;
    skipped  += feed.rows.length - n;

    since   = new Date(feed.nextSince);
    hasMore = feed.hasMore;

    log.debug(
      { tenantId, ingested: n, skipped: feed.rows.length - n, since },
      'sandbox-ingester tenant batch complete',
    );
  }

  if (ingested + skipped > 0) {
    await updateSandboxCursor(tenantId, since);
  }

  return { ingested, skipped };
}

export async function runSandboxIngester(onlyTenantId?: string): Promise<{ ingested: number; skipped: number; errors: number }> {
  // A pass armed by one workspace's finished run reads only that workspace (ingest-runner.ts).
  const tenants = (await getActiveTenants()).filter((t) => !onlyTenantId || t.id === onlyTenantId);
  let ingested = 0;
  let skipped  = 0;
  let errors   = 0;

  for (const tenant of tenants) {
    try {
      const result = await ingestOneTenant(tenant.id);
      ingested += result.ingested;
      skipped  += result.skipped;
    } catch (err) {
      errors++;
      log.warn(
        { tenantId: tenant.id, error: (err as Error).message },
        'sandbox-ingester: failed to ingest tenant (skipping)',
      );
    }
  }

  return { ingested, skipped, errors };
}
