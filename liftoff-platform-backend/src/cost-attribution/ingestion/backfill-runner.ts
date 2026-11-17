// Backfill Runner
//
// One-shot runner for historical data ingestion. Accepts configuration from
// env vars:
//   BACKFILL_SINCE        — ISO start date (default: 18 months ago)
//   BACKFILL_INGESTERS    — comma-separated list (default: platform_llm,runtime,governance,developer_proxy,sandbox)
//
// Uses a separate cursor namespace: `backfill_<source>` in
// cost_attribution_cursors to avoid colliding with live cursors.
//
// Progress is logged every 10k rows.

import { initDatabase, withAdminScope } from '../../infrastructure/database';
import { log } from '../../infrastructure/logging';
import { insertEvents, getIngesterPool } from '../repository';
import { buildOidcAuthHeader } from '@liftoffos/service-client';
import { computeRowCost } from '../../llm/pricing';
import { getInvocationFeed, getSandboxFeed } from '../clients/tenant-runtime-feed';
import { getRuntimeToInternalMap, toInternalAgentId } from '../../internal-agents/runtime-agent-id-map';
import type { CostAttributionEvent } from '../types';

const BATCH_SIZE = 500;
const LOG_EVERY  = 10_000;
const EIGHTEEN_MONTHS_MS = 18 * 30 * 24 * 60 * 60 * 1000;

type IngesterName = 'platform_llm' | 'runtime' | 'governance' | 'developer_proxy' | 'sandbox';
const ALL_INGESTERS: IngesterName[] = ['platform_llm', 'runtime', 'governance', 'developer_proxy', 'sandbox'];

// ── Cursor helpers (raw pool, backfill_ prefix) ────────────────────────

async function getBackfillCursor(key: string): Promise<Date> {
  const pool = getIngesterPool();
  const result = await pool.query(
    `SELECT last_ts FROM cost_attribution_cursors WHERE source = $1`,
    [`backfill_${key}`],
  );
  return (result.rows[0]?.last_ts as Date | undefined) ?? new Date(0);
}

async function updateBackfillCursor(key: string, lastTs: Date): Promise<void> {
  const pool = getIngesterPool();
  await pool.query(
    `INSERT INTO cost_attribution_cursors (source, last_ts, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (source) DO UPDATE SET
       last_ts    = EXCLUDED.last_ts,
       updated_at = NOW()`,
    [`backfill_${key}`, lastTs],
  );
}

// ── OIDC helper ────────────────────────────────────────────────────────

async function safeOidcHeaders(targetUrl: string): Promise<Record<string, string>> {
  try {
    return await buildOidcAuthHeader(targetUrl);
  } catch {
    return {};
  }
}

// ── Platform LLM backfill ──────────────────────────────────────────────

interface UsageLogRow {
  id:                          string;
  tenant_id:                   string;
  agent_id:                    string | null;
  provider:                    string;
  model:                       string;
  purpose:                     string | null;
  input_tokens:                string;
  output_tokens:               string;
  cache_creation_input_tokens: string | null;
  cache_read_input_tokens:     string | null;
  success:                     boolean;
  timestamp:                   Date;
}

async function backfillPlatformLLM(since: Date): Promise<number> {
  const pool = getIngesterPool();
  let total   = 0;

  const storedCursor = await getBackfillCursor('platform_llm');
  // Use the later of (since, stored backfill cursor) so we can resume
  let pageTs = storedCursor > since ? storedCursor : since;

  while (true) {
    const result = await withAdminScope({ caller: 'cost-attribution.backfill-runner', reason: 'cross-tenant llm_usage_log backfill sweep' }, (client) => client.query<UsageLogRow>(
      `SELECT
         id::text,
         tenant_id, agent_id, provider,
         COALESCE(model, '') as model,
         purpose, input_tokens, output_tokens,
         cache_creation_input_tokens,
         cache_read_input_tokens,
         COALESCE(success, true) as success,
         timestamp
       FROM llm_usage_log
       WHERE timestamp > $1
         AND tenant_id IS NOT NULL
       ORDER BY timestamp ASC
       LIMIT $2`,
      [pageTs, BATCH_SIZE],
    ));

    if (result.rows.length === 0) break;

    const events: CostAttributionEvent[] = result.rows.map(row => {
      const inputTokens  = parseInt(row.input_tokens)  || 0;
      const outputTokens = parseInt(row.output_tokens) || 0;
      const cacheCreate  = parseInt(row.cache_creation_input_tokens ?? '0') || 0;
      const cacheRead    = parseInt(row.cache_read_input_tokens  ?? '0') || 0;
      // row.timestamp: a backfill prices historical rows, so evaluating
      // time-windowed rates against now() would be wrong for every row it
      // touches. See computeRowCost / pricing-tiers.ts.
      const costUsd      = computeRowCost(row.provider, row.model, inputTokens, outputTokens, cacheCreate, cacheRead, row.timestamp);

      return {
        tenantId:             row.tenant_id,
        // ATTRIBUTION_AGENT_ID_OK: reads this repo's own llm_usage_log, which is
        // internal-space. Mirrors platform-llm-ingester; see its note for the one
        // historical exception (skills-backfill.ts, deleted in 9009626).
        agentId:              row.agent_id,
        purpose:              row.purpose,
        eventType:            'llm_invocation',
        source:               'platform_llm',
        sourceId:             row.id,
        provider:             row.provider,
        model:                row.model,
        inputTokens,
        outputTokens,
        cachedTokens:         cacheRead,
        costUsd,
        correlationConfidence: row.agent_id ? 'direct' : 'unmatched',
        occurredAt:            row.timestamp,
        // ouConsumed/customerCostUsd/cost_bucket are populated by migration 210
        // (Step 1 fills ou_consumed from cost_usd; Step 3 walks tenants to fill
        // customer_cost_usd + cost_bucket). Defaults satisfy the typed shape.
        ouConsumed: 0,
        customerCostUsd: 0,
        costBucket: 'unknown' as const,
      };
    });

    await insertEvents(events);
    total  += events.length;
    pageTs  = result.rows[result.rows.length - 1].timestamp;

    await updateBackfillCursor('platform_llm', pageTs);

    if (total % LOG_EVERY < BATCH_SIZE) {
      log.info({ total, pageTs }, 'backfill: platform_llm progress');
    }

    if (result.rows.length < BATCH_SIZE) break;
  }

  return total;
}

// ── Runtime backfill ───────────────────────────────────────────────────

async function getActiveTenants(): Promise<Array<{ id: string; hosting_mode: string | null }>> {
  const pool = getIngesterPool();
  // Include 'pending' alongside 'active' — tenants remain 'pending' until
  // explicitly promoted via the activation flow. Any tenant with a runtime_url
  // is provisioned and has invocations worth ingesting.
  const result = await pool.query<{ id: string; hosting_mode: string | null }>(
    `SELECT id, hosting_mode FROM tenants
     WHERE status IN ('active', 'pending')
       AND runtime_url IS NOT NULL
     ORDER BY id`,
  );
  return result.rows;
}

async function backfillRuntime(since: Date): Promise<number> {
  const tenants = await getActiveTenants();
  let total = 0;

  for (const tenant of tenants) {
    try {
      const storedCursor = await getBackfillCursor(`runtime_${tenant.id}`);
      let pageSince = storedCursor > since ? storedCursor : since;

      while (true) {
        const feed = await getInvocationFeed(tenant.id, pageSince, BATCH_SIZE);
        if (!feed || feed.rows.length === 0) break;

        const events: CostAttributionEvent[] = feed.rows.map(row => {
          const costUsd =
            row.costUsd ??
            (row.inputPricePerMillion != null && row.outputPricePerMillion != null
              ? (row.inputTokens * row.inputPricePerMillion +
                 row.outputTokens * row.outputPricePerMillion) / 1_000_000
              : 0);

          return {
            tenantId:            tenant.id,
            // Prefer the control-plane id the feed now emits; fall back to the
            // runtime id only for rows from a runtime predating it or an
            // unmapped agent (INV-PB-009). Mirrors runtime-ingester.
            agentId:             row.internalAgentId || row.agentId || null,
            threadId:            row.threadId ?? null,
            invocationId:        row.id,
            parentInvocationId:  row.triggeredBy === 'agent' ? (row.triggerRef ?? null) : null,
            eventType:           'llm_invocation',
            source:              'tenant_runtime',
            sourceId:            row.id,
            provider:            row.provider,
            model:               row.modelId ?? null,
            inputTokens:         row.inputTokens,
            outputTokens:        row.outputTokens,
            costUsd,
            hostingMode:         tenant.hosting_mode ?? null,
            correlationConfidence: row.agentId ? 'direct' : 'unmatched',
            occurredAt:          new Date(row.startedAt),
          // ouConsumed/customerCostUsd/costBucket populated by migration 210.
          ouConsumed: 0,
          customerCostUsd: 0,
          costBucket: 'unknown' as const,
          };
        });

        await insertEvents(events);
        total    += events.length;
        pageSince = new Date(feed.nextSince);

        await updateBackfillCursor(`runtime_${tenant.id}`, pageSince);

        if (total % LOG_EVERY < BATCH_SIZE) {
          log.info({ total, tenantId: tenant.id }, 'backfill: runtime progress');
        }

        if (!feed.hasMore) break;
      }
    } catch (err) {
      log.warn(
        { tenantId: tenant.id, error: (err as Error).message },
        'backfill: runtime tenant error (skipping)',
      );
    }
  }

  return total;
}

// ── Governance backfill ────────────────────────────────────────────────

interface GovernanceFeedRow {
  id: string;
  tenantId: string;
  agentId: string | null;
  workflowId: string | null;
  connector: string | null;
  entityType: string | null;
  actionType: string | null;
  costUsd: number;
  traceId: string | null;
  createdAt: string;
  status: string | null;
}

interface GovernanceFeedResponse {
  rows: GovernanceFeedRow[];
  hasMore: boolean;
  nextSince: string;
}

async function backfillGovernance(since: Date): Promise<number> {
  const governanceBaseUrl = (process.env.GOVERNANCE_SERVICE_URL ?? '').replace(/\/$/, '');
  if (!governanceBaseUrl) {
    log.warn({}, 'backfill: GOVERNANCE_SERVICE_URL not set, skipping governance');
    return 0;
  }

  const serviceToken = process.env.GOVERNANCE_SERVICE_TOKEN;
  const tenants = await getActiveTenants();
  let total = 0;

  for (const tenant of tenants) {
    try {
      const storedCursor = await getBackfillCursor(`governance_${tenant.id}`);
      let pageSince = (storedCursor > since ? storedCursor : since).toISOString();

      while (true) {
        const url = `${governanceBaseUrl}/api/governance/actions/ingestion-feed?tenantId=${encodeURIComponent(tenant.id)}&since=${encodeURIComponent(pageSince)}&limit=${BATCH_SIZE}`;
        const headers: Record<string, string> = {};
        if (serviceToken) headers['X-Service-Auth'] = serviceToken;
        Object.assign(headers, await safeOidcHeaders(governanceBaseUrl));

        let feed: GovernanceFeedResponse;
        try {
          const response = await fetch(url, { method: 'GET', headers });
          if (!response.ok) {
            log.warn({ status: response.status, tenantId: tenant.id }, 'backfill: governance non-OK, skipping tenant');
            break;
          }
          feed = await response.json() as GovernanceFeedResponse;
        } catch (err) {
          log.warn({ error: (err as Error).message, tenantId: tenant.id }, 'backfill: governance network error, skipping tenant');
          break;
        }

        if (!feed.rows || feed.rows.length === 0) break;

        // The governance engine stores whichever id the tool-gateway handed it,
        // falling back to the runtime id for agents unmapped at call time.
        // Mirrors governance-ingester; identity-preserving so already-internal
        // ids pass through untouched (INV-PB-009).
        const govMap = await getRuntimeToInternalMap(tenant.id);

        const events: CostAttributionEvent[] = feed.rows.map(row => ({
          tenantId:             row.tenantId,
          agentId:              toInternalAgentId(govMap, row.agentId),
          workflowId:           row.workflowId ?? null,
          actionId:             row.id,
          connector:            row.connector ?? null,
          entityType:           row.entityType ?? null,
          actionType:           row.actionType ?? null,
          eventType:            'connector_call',
          source:               'governance',
          sourceId:             row.id,
          costUsd:              row.costUsd,
          correlationConfidence: 'direct',
          occurredAt:           new Date(row.createdAt),
          // ouConsumed/customerCostUsd/costBucket populated by migration 210.
          ouConsumed: 0,
          customerCostUsd: 0,
          costBucket: 'unknown' as const,
        }));

        await insertEvents(events);
        total    += events.length;
        pageSince = feed.nextSince;

        const lastRow = feed.rows[feed.rows.length - 1];
        await updateBackfillCursor(`governance_${tenant.id}`, new Date(lastRow.createdAt));

        if (total % LOG_EVERY < BATCH_SIZE) {
          log.info({ total, tenantId: tenant.id }, 'backfill: governance progress');
        }

        if (!feed.hasMore) break;
      }
    } catch (err) {
      log.warn(
        { tenantId: tenant.id, error: (err as Error).message },
        'backfill: governance tenant error (skipping)',
      );
    }
  }

  return total;
}

// ── Developer Proxy backfill ───────────────────────────────────────────

interface DevProxyFeedRow {
  id: string;
  tenantId: string;
  agentId: string | null;
  invocationId: string | null;
  vendor: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
  startedAt: string;
}

interface DevProxyFeedResponse {
  rows: DevProxyFeedRow[];
  hasMore: boolean;
  nextSince: string;
}

async function backfillDeveloperProxy(since: Date): Promise<number> {
  const devProxyBaseUrl = (process.env.DEVELOPER_PROXY_SERVICE_URL ?? '').replace(/\/$/, '');
  if (!devProxyBaseUrl) {
    log.warn({}, 'backfill: DEVELOPER_PROXY_SERVICE_URL not set, skipping developer_proxy');
    return 0;
  }

  const storedCursor = await getBackfillCursor('developer_proxy');
  let pageSince = (storedCursor > since ? storedCursor : since).toISOString();
  let total = 0;

  const devProxyServiceToken = process.env.DEVELOPER_PROXY_SERVICE_TOKEN;

  while (true) {
    const url = `${devProxyBaseUrl}/api/usage/ingestion-feed?since=${encodeURIComponent(pageSince)}&limit=${BATCH_SIZE}`;
    const headers: Record<string, string> = await safeOidcHeaders(devProxyBaseUrl);
    if (devProxyServiceToken) headers['X-Service-Token'] = devProxyServiceToken;

    let feed: DevProxyFeedResponse;
    try {
      const response = await fetch(url, { method: 'GET', headers });
      if (!response.ok) {
        log.warn({ status: response.status }, 'backfill: developer_proxy non-OK, stopping');
        break;
      }
      feed = await response.json() as DevProxyFeedResponse;
    } catch (err) {
      log.warn({ error: (err as Error).message }, 'backfill: developer_proxy network error, stopping');
      break;
    }

    if (!feed.rows || feed.rows.length === 0) break;

    // Global feed (cursor over all tenants), so the map is resolved per row's
    // tenant. getRuntimeToInternalMap is TTL-cached per tenant. Mirrors
    // developer-proxy-ingester: the upstream service's id space cannot be
    // verified from this repo, so translate defensively (INV-PB-009).
    const devProxyMaps = new Map<string, Awaited<ReturnType<typeof getRuntimeToInternalMap>>>();
    for (const tid of new Set(feed.rows.map((r) => r.tenantId))) {
      devProxyMaps.set(tid, await getRuntimeToInternalMap(tid));
    }

    const events: CostAttributionEvent[] = feed.rows.map(row => ({
      tenantId:     row.tenantId,
      agentId:      toInternalAgentId(devProxyMaps.get(row.tenantId) ?? new Map(), row.agentId),
      invocationId: row.invocationId ?? null,
      eventType:    'developer_proxy_llm',
      source:       'developer_proxy',
      sourceId:     row.id,
      costUsd:      row.costMicros / 1_000_000,
      provider:     row.vendor,
      model:        row.model,
      inputTokens:  row.inputTokens,
      outputTokens: row.outputTokens,
      occurredAt:   new Date(row.startedAt),
      // ouConsumed/customerCostUsd/costBucket populated by migration 210.
      ouConsumed: 0,
      customerCostUsd: 0,
      costBucket: 'unknown' as const,
    }));

    await insertEvents(events);
    total    += events.length;
    pageSince = feed.nextSince;

    const lastRow = feed.rows[feed.rows.length - 1];
    await updateBackfillCursor('developer_proxy', new Date(lastRow.startedAt));

    if (total % LOG_EVERY < BATCH_SIZE) {
      log.info({ total }, 'backfill: developer_proxy progress');
    }

    if (!feed.hasMore) break;
  }

  return total;
}

// ── Sandbox backfill ───────────────────────────────────────────────────

const CREDIT_TO_USD = 0.001;

async function backfillSandbox(since: Date): Promise<number> {
  const tenants = await getActiveTenants();
  let total = 0;

  for (const tenant of tenants) {
    try {
      const storedCursor = await getBackfillCursor(`sandbox_${tenant.id}`);
      let pageSince = storedCursor > since ? storedCursor : since;

      while (true) {
        const feed = await getSandboxFeed(tenant.id, pageSince, BATCH_SIZE);
        if (!feed || feed.rows.length === 0) break;

        const events: CostAttributionEvent[] = feed.rows.map(row => ({
          tenantId:     tenant.id,
          // Mirrors sandbox-ingester — prefer the feed's internalAgentId.
          agentId:      row.internalAgentId ?? row.agentId ?? null,
          invocationId: row.invocationId ?? null,
          eventType:    'sandbox',
          source:       'tenant_runtime',
          sourceId:     `sandbox_${row.id}`,
          costUsd:      row.creditsConsumed * CREDIT_TO_USD,
          occurredAt:   new Date(row.timestamp),
          // ouConsumed/customerCostUsd/costBucket populated by migration 210.
          ouConsumed: 0,
          customerCostUsd: 0,
          costBucket: 'unknown' as const,
        }));

        await insertEvents(events);
        total    += events.length;
        pageSince = new Date(feed.nextSince);

        await updateBackfillCursor(`sandbox_${tenant.id}`, pageSince);

        if (total % LOG_EVERY < BATCH_SIZE) {
          log.info({ total, tenantId: tenant.id }, 'backfill: sandbox progress');
        }

        if (!feed.hasMore) break;
      }
    } catch (err) {
      log.warn(
        { tenantId: tenant.id, error: (err as Error).message },
        'backfill: sandbox tenant error (skipping)',
      );
    }
  }

  return total;
}

// ── Main entry point ───────────────────────────────────────────────────

export async function runBackfill(): Promise<void> {
  const sinceDateStr = process.env.BACKFILL_SINCE;
  const since = sinceDateStr
    ? new Date(sinceDateStr)
    : new Date(Date.now() - EIGHTEEN_MONTHS_MS);

  if (isNaN(since.getTime())) {
    throw new Error(`BACKFILL_SINCE is not a valid ISO date: "${sinceDateStr}"`);
  }

  // Load synced open-weights rates so this job (a standalone Cloud Run Job that does
  // NOT boot the service's background loader) attributes cost consistently with the
  // live path, which reads model_pricing. Best-effort — computeRowCost falls back to
  // the static MODEL_PRICING table if the load fails.
  try {
    const { refreshModelPricingRates } = await import('../../llm/model-pricing-loader');
    const count = await refreshModelPricingRates();
    log.info({ count }, 'backfill: loaded synced model_pricing rates');
  } catch (err) {
    log.warn({ err }, 'backfill: synced rate load failed; using static MODEL_PRICING');
  }

  const ingestersRaw = process.env.BACKFILL_INGESTERS;
  const requestedNames = ingestersRaw
    ? (ingestersRaw.split(',').map(s => s.trim()) as IngesterName[])
    : ALL_INGESTERS;

  const ingesters = requestedNames.filter(n => (ALL_INGESTERS as string[]).includes(n));
  if (ingesters.length === 0) {
    log.warn({ requestedNames }, 'backfill: no valid ingesters specified');
    return;
  }

  await initDatabase();

  log.info({ since: since.toISOString(), ingesters }, 'backfill: starting');

  const totals: Record<string, number> = {};

  for (const name of ingesters) {
    log.info({ name }, `backfill: running ${name}`);
    try {
      let count = 0;
      switch (name) {
        case 'platform_llm': count = await backfillPlatformLLM(since); break;
        case 'runtime':      count = await backfillRuntime(since);      break;
        case 'governance':   count = await backfillGovernance(since);   break;
        case 'developer_proxy': count = await backfillDeveloperProxy(since); break;
        case 'sandbox':      count = await backfillSandbox(since);      break;
      }
      totals[name] = count;
      log.info({ name, count }, `backfill: ${name} complete`);
    } catch (err) {
      log.error(
        { name, error: (err as Error).message },
        `backfill: ${name} failed`,
      );
      totals[name] = -1;
    }
  }

  log.info({ totals }, 'backfill: all ingesters complete');
}
