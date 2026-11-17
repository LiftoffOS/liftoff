// Runtime Ingester
//
// Polls each tenant's runtime service via GET /api/invocations/ingestion-feed
// and writes completed invocations as 'llm_invocation' events to
// cost_attribution_events. Cursor is stored per-tenant in
// cost_attribution_cursors with source key `runtime_{tenantId}`.
//
// The tenant-runtime stores per-invocation cost_usd as a computed value
// (input_price_per_million * input_tokens + output_price_per_million * output_tokens).
// We trust this value; if it's null (no price snapshot), we recompute it
// from the per-row pricing fields (see Anthropic semantics note below).

import { log } from '../../infrastructure/logging';
import { getInvocationFeed } from '../clients/tenant-runtime-feed';
import { getIngesterPool, resolveAccountIdForTenant, ingestEventWithBuckets } from '../repository';
import { wasRunByokFunded } from '../../byok-gateway/usage-recorder';

const BATCH_SIZE = 500;

interface TenantRow {
  id: string;
  hosting_mode: string | null;
}

async function getActiveTenants(): Promise<TenantRow[]> {
  const pool = getIngesterPool();
  const result = await pool.query<TenantRow>(
    `SELECT id, hosting_mode FROM tenants WHERE status = 'active' OR (status = 'pending' AND runtime_url IS NOT NULL) ORDER BY id`,
  );
  return result.rows;
}

async function getIngestionCursor(tenantId: string): Promise<Date> {
  const pool = getIngesterPool();
  const result = await pool.query(
    `SELECT last_ts FROM cost_attribution_cursors WHERE source = $1`,
    [`runtime_${tenantId}`],
  );
  return (result.rows[0]?.last_ts as Date | undefined) ?? new Date(0);
}

async function updateIngestionCursor(tenantId: string, lastTs: Date): Promise<void> {
  const pool = getIngesterPool();
  await pool.query(
    `INSERT INTO cost_attribution_cursors (source, last_ts, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (source) DO UPDATE SET
       last_ts    = EXCLUDED.last_ts,
       updated_at = NOW()`,
    [`runtime_${tenantId}`, lastTs],
  );
}

async function ingestOneTenant(tenantId: string, hostingMode: string | null): Promise<{ ingested: number; skipped: number }> {
  let ingested = 0;
  let skipped  = 0;

  let since = await getIngestionCursor(tenantId);
  let hasMore = true;

  while (hasMore) {
    const feed = await getInvocationFeed(tenantId, since, BATCH_SIZE);
    if (!feed || feed.rows.length === 0) break;

    const accountId = await resolveAccountIdForTenant(tenantId);
    let n = 0;
    if (accountId) {
      for (const row of feed.rows) {
        // Provider-aware fresh-input — the SDK-reported `input_tokens`
        // means different things across providers:
        //   Anthropic / Anthropic-via-Vertex: EXCLUDES cache_read tokens;
        //     freshInput = inputTokens (no subtraction).
        //   OpenAI / Google: INCLUDES the cached portion;
        //     freshInput = max(0, inputTokens - cachedTokens).
        // The historical formula subtracted unconditionally, producing
        // negative cost on Anthropic cache hits (e.g. input=3, cached=11040
        // → ≈ -$0.055). PB's negative-cost guard short-circuited the row,
        // silently under-charging customers.
        const isAnthropic = row.provider === 'anthropic' || row.provider === 'anthropic-vertex';
        const freshInput = isAnthropic
          ? row.inputTokens
          : Math.max(0, row.inputTokens - row.cachedTokens);
        const costUsd =
          row.costUsd ??
          (row.inputPricePerMillion != null && row.outputPricePerMillion != null
            ? (freshInput * row.inputPricePerMillion +
               (row.cachedInputPricePerMillion != null ? row.cachedTokens * row.cachedInputPricePerMillion : 0) +
               row.outputTokens * row.outputPricePerMillion) / 1_000_000
            : 0);

        // Control-plane id preferred so cost_attribution_events.agent_id stays
        // in one id space; falls back to the runtime id when the feed omits it
        // (older runtime) or the agent has no mapping row (INV-TR-010).
        const attributionAgentId = row.internalAgentId || row.agentId || null;

        // Whose key paid. Read from the gateway's own per-request rows rather
        // than re-derived: it is the only component that sees which credential
        // went out on the wire. A run with no gateway rows — every run that did
        // not use a customer key — answers false and bills as it does today.
        const byokFunded = await wasRunByokFunded(tenantId, row.id);

        const inserted = await ingestEventWithBuckets(accountId, row.id, costUsd, {
          tenantId,
          byokFunded,
          agentId:             attributionAgentId,
          threadId:            row.threadId ?? null,
          invocationId:        row.id,
          parentInvocationId:  row.triggeredBy === 'agent' ? (row.triggerRef ?? null) : null,
          purpose:             null,
          eventType:           'llm_invocation',
          source:              'tenant_runtime',
          provider:            row.provider,
          model:               row.modelId ?? null,
          inputTokens:         row.inputTokens,
          outputTokens:        row.outputTokens,
          cachedTokens:        row.cachedTokens,
          hostingMode:         hostingMode ?? null,
          correlationConfidence: attributionAgentId ? 'direct' : 'unmatched',
          occurredAt:          new Date(row.startedAt),
        });
        n += inserted > 0 ? 1 : 0;
      }
    }
    ingested += n;
    skipped  += feed.rows.length - n;

    // Advance the cursor to the last row's startedAt timestamp
    since = new Date(feed.nextSince);
    hasMore = feed.hasMore;

    log.debug(
      { tenantId, ingested: n, skipped: feed.rows.length - n, since },
      'runtime-ingester tenant batch complete',
    );
  }

  if (ingested + skipped > 0) {
    await updateIngestionCursor(tenantId, since);
  }

  return { ingested, skipped };
}

export async function runRuntimeIngester(onlyTenantId?: string): Promise<{ ingested: number; skipped: number; errors: number }> {
  // A pass armed by one workspace's finished run reads only that workspace (ingest-runner.ts).
  const tenants = (await getActiveTenants()).filter((t) => !onlyTenantId || t.id === onlyTenantId);
  let ingested = 0;
  let skipped  = 0;
  let errors   = 0;

  for (const tenant of tenants) {
    try {
      const result = await ingestOneTenant(tenant.id, tenant.hosting_mode);
      ingested += result.ingested;
      skipped  += result.skipped;
    } catch (err) {
      errors++;
      log.warn(
        { tenantId: tenant.id, error: (err as Error).message },
        'runtime-ingester: failed to ingest tenant (skipping)',
      );
    }
  }

  return { ingested, skipped, errors };
}
