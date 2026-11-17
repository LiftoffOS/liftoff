// Usage Ledger Ingester
//
// Polls each tenant's tenant-runtime GET /api/usage-ledger/feed endpoint and
// writes memory-credit events and browser-tool events into
// cost_attribution_events. Per-tenant cursors are stored in
// cost_attribution_cursors with source key `usage_ledger_{tenantId}` so each
// tenant has its own pagination position.
//
// Architecturally mirrors runtime-ingester.ts (one HTTP poll per active
// tenant; resolves the tenant's runtime URL via resolveRuntimeBaseUrl).

import { log } from '../../infrastructure/logging';
import { ingestEventWithBuckets, resolveAccountIdForTenant, getIngesterPool } from '../repository';
import { resolveRuntimeBaseUrl, buildRuntimeHeaders } from '../../connectors/tenant-runtime-url';
import {
  getRuntimeToInternalMap, toInternalAgentId, type RuntimeToInternalMap,
} from '../../internal-agents/runtime-agent-id-map';
import type { CostAttributionEvent, EventType } from '../types';

const FEED_BATCH_SIZE = 500;

// Maps usage_events.event_type → cost_attribution_events.event_type
const EVENT_TYPE_MAP: Record<string, EventType> = {
  memory_save:           'credit',
  memory_retrieve:       'credit',
  web_fetch_advanced:    'web_tool',
  web_extract:           'web_tool',
  web_task:              'web_tool',
  web_research:          'web_tool',
  web_diff:              'web_tool',
  web_identity_connect:  'web_tool',
  web_session_save:      'web_tool',
  web_people_search:     'web_tool',
  web_finance_search:    'web_tool',
  web_deep_research:     'web_tool',
  // Bridged search (perplexity / xai, and the x402 Browserbase rung behind
  // them). Priced from cost_micros like its siblings; without this line the
  // real-time subscriber is a search row's ONLY path and a lost publish loses
  // the charge.
  web_search:            'web_tool',
  // A pane browser session, settled at stop. Not a per-call web_* type: it is
  // minutes of browser time charged as one window, published by the runtime
  // from BrowserUseClient.closeSession. It collapses to 'web_tool' like every
  // sibling so /insights and the vendor monitor see it without a special case,
  // and keeps its own action_type so a session is not read as a tool call.
  browser_session:       'web_tool',
  // A CONNECTOR tool call whose vendor charged per call — today the x402
  // vendors, whose 402 challenge the platform wallet pays in USDC. Published
  // by the tenant runtime's tool gateway off the connector-service executor's
  // receipt-derived costUsd; carries cost_micros + funding in metadata.
  connector_call:        'connector_call',
};

const TOOL_COST_FROM_METADATA = new Set([
  'web_fetch_advanced', 'web_extract', 'web_task',
  'web_research', 'web_diff', 'web_identity_connect', 'web_session_save',
  'web_people_search', 'web_finance_search', 'web_deep_research', 'web_search',
  // Carries cost_micros in metadata exactly like the tool events do. Omitting
  // it here would map the event and then price it off `credits`, which for a
  // session is the count 1 and not a cost, so every browser session would bill
  // zero while looking correctly ingested.
  'browser_session',
  // x402 connector calls carry the settled USDC amount as cost_micros.
  'connector_call',
]);

const MEMORY_CREDIT_TO_USD = 0;  // memory ops are free; finalize before billing.

interface FeedEvent {
  id: string;
  tenant_id: string;
  agent_id: string;
  workflow_id: string | null;
  action_id: string | null;
  event_type: string;
  credits: number;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

interface FeedResponse {
  events: FeedEvent[];
  nextCursor: string | null;
  hasMore: boolean;
}

interface TenantRow { id: string }

async function getActiveTenants(): Promise<TenantRow[]> {
  const pool = getIngesterPool();
  const result = await pool.query<TenantRow>(
    `SELECT id FROM tenants
     WHERE status = 'active' OR (status = 'pending' AND runtime_url IS NOT NULL)
     ORDER BY id`,
  );
  return result.rows;
}

function cursorKeyFor(tenantId: string): string {
  return `usage_ledger_${tenantId}`;
}

async function getTenantCursor(tenantId: string): Promise<Date> {
  const pool = getIngesterPool();
  const result = await pool.query<{ last_ts: Date | null }>(
    `SELECT last_ts FROM cost_attribution_cursors WHERE source = $1`,
    [cursorKeyFor(tenantId)],
  );
  return result.rows[0]?.last_ts ?? new Date(0);
}

async function setTenantCursor(tenantId: string, lastTs: Date): Promise<void> {
  const pool = getIngesterPool();
  await pool.query(
    `INSERT INTO cost_attribution_cursors (source, last_ts, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (source) DO UPDATE SET
       last_ts    = EXCLUDED.last_ts,
       updated_at = NOW()`,
    [cursorKeyFor(tenantId), lastTs],
  );
}

async function fetchFeedPage(tenantId: string, since: Date): Promise<FeedResponse | null> {
  const base = await resolveRuntimeBaseUrl(tenantId);
  // The tenant is REQUIRED by the feed. Without it the runtime returned every
  // tenant's events to every caller, and this loop then translated each event's
  // agent id using whichever tenant it happened to be iterating — writing
  // runtime ids into a column that must hold internal_agents.id whenever those
  // two differed (INV-PB-009 / ADR-039).
  const params = new URLSearchParams({
    tenantId: tenantId,
    cursor: since.toISOString(),
    limit: String(FEED_BATCH_SIZE),
  });
  const url = `${base}/api/usage-ledger/feed?${params}`;
  const headers = await buildRuntimeHeaders(tenantId);
  try {
    const res = await fetch(url, { method: 'GET', headers });
    if (!res.ok) {
      log.warn({ tenantId, status: res.status }, 'usage-ledger-ingester: feed non-2xx');
      return null;
    }
    return await res.json() as FeedResponse;
  } catch (err) {
    log.warn({ tenantId, error: (err as Error).message }, 'usage-ledger-ingester: feed request failed');
    return null;
  }
}

/** Returns the row id and template ready for ingestEventWithBuckets.
 *  Null when the event_type isn't one we ingest. */
type MappedEvent = {
  sourceId: string;
  costUsd: number;
  template: Omit<CostAttributionEvent, 'sourceId' | 'costUsd' | 'ouConsumed' | 'customerCostUsd' | 'costBucket'>;
};

function mapEvent(e: FeedEvent, runtimeToInternal: RuntimeToInternalMap): MappedEvent | null {
  const targetType = EVENT_TYPE_MAP[e.event_type];
  if (!targetType) return null;
  const isBrowserTool = TOOL_COST_FROM_METADATA.has(e.event_type);
  const costUsd = isBrowserTool
    ? ((e.metadata?.cost_micros as number ?? 0) / 1_000_000)
    : e.credits * MEMORY_CREDIT_TO_USD;
  const vendor   = isBrowserTool ? (e.metadata?.vendor    as string | undefined) ?? null : null;
  const toolName = isBrowserTool ? (e.metadata?.tool_name as string | undefined) ?? null : null;
  // The owning thread and invocation, when the producer recorded them. These
  // are the drill-down keys the audit trail is keyed by, and the real-time
  // web-tool subscriber already books them — the backstop must land the same
  // row shape, or attribution depends on which path got there first.
  const threadId     = isBrowserTool ? (e.metadata?.thread_id     as string | undefined) ?? null : null;
  const invocationId = isBrowserTool ? (e.metadata?.invocation_id as string | undefined) ?? null : null;
  // Whose key paid the vendor. This poll is the BACKSTOP for the same events
  // the web-tool spend subscriber books in real time, so it has to read funding
  // the same way or the charge depends on which path got there first. Only
  // 'platform' moves a row off the BYOK bypass; absent or unrecognised leaves
  // it where it has always gone.
  const webToolFunding =
    e.metadata?.funding === 'platform' ? 'platform' as const : undefined;

  // The platform x402 wallet paid the vendor for this call. Routes the row to
  // the x402 branch of ingestEventWithBuckets: real OU consumption, one row
  // bucketed 'x402_wallet_funded', usage counted per call (migration 440).
  const x402Funded = e.metadata?.funding === 'x402_wallet';

  // A connector_call whose funding we do not recognise is SKIPPED, not
  // charged. The runtime only publishes x402-funded connector calls today, so
  // this shape is a producer defect — and routing it to the customer path
  // would invent a charge for a call whose pricing nobody decided. Refusing
  // to guess is the honest failure; the warn is the signal to decide.
  if (targetType === 'connector_call' && !x402Funded) {
    log.warn(
      { eventId: e.id, tenantId: e.tenant_id, funding: e.metadata?.funding ?? null },
      'usage-ledger-ingester: connector_call with unrecognised funding — skipped, not charged',
    );
    return null;
  }

  // D2.3: web_deep_research events carry a deterministic `idempotency_key`
  // in metadata (pre-charge = deep_research_id; delta =
  // `${deep_research_id}/delta`). Using it as source_id makes both
  // applyOuConsumption's isDuplicate callback AND the
  // cost_attribution_events partial unique index dedup replays cleanly,
  // even though usage_events.id is a different UUID each time.
  const idempotencyKey = (e.metadata?.idempotency_key as string | undefined);
  const sourceId = idempotencyKey ?? e.id;

  return {
    sourceId,
    costUsd,
    template: {
      tenantId:   e.tenant_id,
      // usage_events.agent_id is the runtime agents.id (this feed is the tenant
      // runtime's own ledger); cost_attribution_events is keyed by
      // internal_agents.id. Identity-preserving, so an already-internal id passes
      // through untouched (INV-PB-009).
      agentId:    toInternalAgentId(runtimeToInternal, e.agent_id),
      workflowId: e.workflow_id ?? null,
      actionId:   e.action_id ?? null,
      eventType:  targetType,
      source:     'tenant_runtime',
      connector:  vendor,
      actionType: toolName,
      threadId,
      invocationId,
      occurredAt: new Date(e.created_at),
      webToolFunding,
      ...(x402Funded
        ? { x402Funded: true, usageQuantity: 1, usageUnit: 'call' as const }
        : {}),
    },
  };
}

async function ingestOneTenant(tenantId: string): Promise<{ ingested: number; skipped: number }> {
  // Resolve account once per tenant: events without an account are dropped
  // (matches the runtime-ingester convention).
  const accountId = await resolveAccountIdForTenant(tenantId);
  if (!accountId) return { ingested: 0, skipped: 0 };

  // Resolved on the first event that needs translating, then reused for the
  // rest of the cycle. Fetching it up front cost a cross-service call for every
  // tenant on every cycle whether or not it had any usage, and an idle tenant
  // never stops being idle. Three tenants with no agents and no events were
  // generating ~500 blocked calls a day between them on this alone.
  let runtimeToInternalPromise: Promise<RuntimeToInternalMap> | null = null;
  const resolveMap = (): Promise<RuntimeToInternalMap> => (
    runtimeToInternalPromise ??= getRuntimeToInternalMap(tenantId)
  );

  let since = await getTenantCursor(tenantId);
  let ingested = 0;
  let skipped  = 0;
  let foreign  = 0;
  let hasMore  = true;

  while (hasMore) {
    const feed = await fetchFeedPage(tenantId, since);
    if (!feed || feed.events.length === 0) break;

    // There is work, so the map is now genuinely needed.
    const runtimeToInternal = await resolveMap();

    for (const e of feed.events) {
      // Belt and braces with the feed's tenant filter. The id translation below
      // is only valid for the tenant whose map we hold, so an event belonging to
      // someone else must not be translated here — that mismatch is exactly what
      // wrote runtime ids into cost_attribution_events while the feed was
      // global. Correct on this side too, so neither end alone can reintroduce
      // it.
      if (e.tenant_id && e.tenant_id !== tenantId) {
        foreign++;
        continue;
      }

      const mapped = mapEvent(e, runtimeToInternal);
      if (!mapped) { skipped++; continue; }
      try {
        const inserted = await ingestEventWithBuckets(
          accountId,
          mapped.sourceId,
          mapped.costUsd,
          mapped.template,
        );
        ingested += inserted > 0 ? 1 : 0;
      } catch (err) {
        skipped++;
        log.warn(
          { tenantId, sourceId: mapped.sourceId, error: (err as Error).message },
          'usage-ledger-ingester: ingestEventWithBuckets failed',
        );
      }
    }

    if (feed.nextCursor) {
      since = new Date(feed.nextCursor);
      await setTenantCursor(tenantId, since);
    }
    hasMore = feed.hasMore;
  }

  if (foreign > 0) {
    // Loud on purpose: with the feed filtering correctly this is unreachable,
    // so a non-zero count means the runtime handed back somebody else's events
    // and the filter has regressed.
    log.warn(
      { tenantId, foreign },
      'usage-ledger-ingester: feed returned events for other tenants; they were not ingested',
    );
  }

  return { ingested, skipped };
}

export async function runUsageLedgerIngester(onlyTenantId?: string): Promise<{ ingested: number; skipped: number; errors: number }> {
  // A pass armed by one workspace's finished run reads only that workspace (ingest-runner.ts).
  const tenants = (await getActiveTenants()).filter((t) => !onlyTenantId || t.id === onlyTenantId);
  let ingested = 0;
  let skipped  = 0;
  let errors   = 0;

  for (const t of tenants) {
    try {
      const result = await ingestOneTenant(t.id);
      ingested += result.ingested;
      skipped  += result.skipped;
    } catch (err) {
      errors++;
      log.warn(
        { tenantId: t.id, error: (err as Error).message },
        'usage-ledger-ingester: tenant failed (skipping)',
      );
    }
  }

  log.debug({ ingested, skipped, errors }, 'usage-ledger-ingester sweep complete');
  return { ingested, skipped, errors };
}
