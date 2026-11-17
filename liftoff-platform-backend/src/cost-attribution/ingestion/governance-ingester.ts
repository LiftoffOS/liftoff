// Governance Ingester
//
// Polls GET /api/governance/actions/ingestion-feed?tenantId=<id>&since=<ISO>&limit=<n>
// on governance-engine and writes connector_call events to
// cost_attribution_events. Per-tenant cursors stored in cost_attribution_cursors
// with source key `governance_{tenantId}`.
//
// Auth: X-Service-Auth (GOVERNANCE_SERVICE_TOKEN) + OIDC identity token,
// same pattern as the governance proxy at src/governance/proxy.ts.

import { buildOidcAuthHeader } from '@liftoffos/service-client';
import { log } from '../../infrastructure/logging';
import {
  getIngesterPool,
  resolveAccountIdForTenant, ingestEventWithBuckets,
} from '../repository';
import { getRuntimeToInternalMap, toInternalAgentId, type RuntimeToInternalMap } from '../../internal-agents/runtime-agent-id-map';

const BATCH_SIZE = 500;

interface TenantRow {
  id: string;
}

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
  createdAt: string; // ISO string
  status: string | null;
}

interface GovernanceFeedResponse {
  rows: GovernanceFeedRow[];
  hasMore: boolean;
  nextSince: string | null;
}

async function getActiveTenants(): Promise<TenantRow[]> {
  const pool = getIngesterPool();
  const result = await pool.query<TenantRow>(
    `SELECT id FROM tenants WHERE status = 'active' OR (status = 'pending' AND runtime_url IS NOT NULL) ORDER BY id`,
  );
  return result.rows;
}

async function getGovernanceCursor(tenantId: string): Promise<Date> {
  const pool = getIngesterPool();
  const result = await pool.query(
    `SELECT last_ts FROM cost_attribution_cursors WHERE source = $1`,
    [`governance_${tenantId}`],
  );
  return (result.rows[0]?.last_ts as Date | undefined) ?? new Date(0);
}

async function updateGovernanceCursor(tenantId: string, lastTs: Date): Promise<void> {
  const pool = getIngesterPool();
  await pool.query(
    `INSERT INTO cost_attribution_cursors (source, last_ts, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (source) DO UPDATE SET
       last_ts    = EXCLUDED.last_ts,
       updated_at = NOW()`,
    [`governance_${tenantId}`, lastTs],
  );
}

async function buildGovernanceHeaders(targetUrl: string): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};

  const serviceToken = process.env.GOVERNANCE_SERVICE_TOKEN;
  if (serviceToken) {
    headers['X-Service-Auth'] = serviceToken;
  }

  try {
    Object.assign(headers, await buildOidcAuthHeader(targetUrl));
  } catch {
    // Local dev / test: no metadata server, skip OIDC silently
  }

  return headers;
}

async function ingestOneTenant(
  tenantId: string,
  governanceBaseUrl: string,
): Promise<{ ingested: number; skipped: number }> {
  let ingested = 0;
  let skipped  = 0;

  // The governance engine stores whichever agent id the tool-gateway handed it.
  // That is the control-plane id on the governed path (tool-gateway translates
  // via resolveGovernanceAgentId), but it falls back to the RUNTIME id whenever
  // the agent had no mapping row at call time, which leaves those rows
  // runtime-keyed and unresolvable. Translate defensively here: the
  // lookup is identity for ids that are already internal, so this only repairs
  // the fallback rows (INV-PB-009).
  //
  // Resolved on the first page that has rows, then reused for the rest of the
  // cycle. Fetching it up front cost a cross-service call for every tenant on
  // every cycle whether or not it had any governed actions.
  let runtimeToInternalPromise: Promise<RuntimeToInternalMap> | null = null;
  const resolveMap = (): Promise<RuntimeToInternalMap> => (
    runtimeToInternalPromise ??= getRuntimeToInternalMap(tenantId)
  );

  const since = await getGovernanceCursor(tenantId);

  let pageSince = since.toISOString();
  let hasMore = true;
  let lastSeenTs: Date | null = null;

  while (hasMore) {
    const url = `${governanceBaseUrl}/api/governance/actions/ingestion-feed?tenantId=${encodeURIComponent(tenantId)}&since=${encodeURIComponent(pageSince)}&limit=${BATCH_SIZE}`;
    const headers = await buildGovernanceHeaders(governanceBaseUrl);

    let feed: GovernanceFeedResponse;
    try {
      const response = await fetch(url, { method: 'GET', headers });
      if (!response.ok) {
        log.warn(
          { status: response.status, url, tenantId },
          'governance-ingester: non-OK response, stopping pagination for tenant',
        );
        break;
      }
      feed = await response.json() as GovernanceFeedResponse;
    } catch (err) {
      log.warn(
        { error: (err as Error).message, url, tenantId },
        'governance-ingester: network error, stopping pagination for tenant',
      );
      break;
    }

    if (!feed.rows || feed.rows.length === 0) {
      hasMore = false;
      break;
    }

    // There are rows, so the map is now genuinely needed.
    const runtimeToInternal = await resolveMap();

    const accountIdCache = new Map<string, string | null>();
    let n = 0;
    for (const row of feed.rows) {
      let accountId = accountIdCache.get(row.tenantId);
      if (accountId === undefined) {
        accountId = await resolveAccountIdForTenant(row.tenantId);
        accountIdCache.set(row.tenantId, accountId);
      }
      if (!accountId) continue;
      const inserted = await ingestEventWithBuckets(accountId, row.id, row.costUsd, {
        tenantId:              row.tenantId,
        agentId:               toInternalAgentId(runtimeToInternal, row.agentId),
        workflowId:            row.workflowId ?? null,
        actionId:              row.id,
        connector:             row.connector ?? null,
        entityType:            row.entityType ?? null,
        actionType:            row.actionType ?? null,
        eventType:             'connector_call',
        source:                'governance',
        correlationConfidence: 'direct',
        occurredAt:            new Date(row.createdAt),
      });
      n += inserted > 0 ? 1 : 0;
    }
    ingested += n;
    skipped  += feed.rows.length - n;

    const lastRow = feed.rows[feed.rows.length - 1];
    lastSeenTs = new Date(lastRow.createdAt);

    pageSince = feed.nextSince ?? pageSince;
    hasMore   = feed.hasMore;

    log.debug(
      { tenantId, ingested: n, skipped: feed.rows.length - n, pageSince },
      'governance-ingester batch complete',
    );
  }

  if (lastSeenTs !== null) {
    await updateGovernanceCursor(tenantId, lastSeenTs);
  }

  return { ingested, skipped };
}

export async function runGovernanceIngester(onlyTenantId?: string): Promise<{ ingested: number; skipped: number; errors: number }> {
  const governanceBaseUrl = (process.env.GOVERNANCE_SERVICE_URL ?? '').replace(/\/$/, '');
  if (!governanceBaseUrl) {
    log.warn({}, 'governance-ingester: GOVERNANCE_SERVICE_URL is not set, skipping');
    return { ingested: 0, skipped: 0, errors: 0 };
  }

  // A pass armed by one workspace's finished run reads only that workspace (ingest-runner.ts).
  const tenants = (await getActiveTenants()).filter((t) => !onlyTenantId || t.id === onlyTenantId);
  let ingested = 0;
  let skipped  = 0;
  let errors   = 0;

  for (const tenant of tenants) {
    try {
      const result = await ingestOneTenant(tenant.id, governanceBaseUrl);
      ingested += result.ingested;
      skipped  += result.skipped;
    } catch (err) {
      errors++;
      log.warn(
        { tenantId: tenant.id, error: (err as Error).message },
        'governance-ingester: failed to ingest tenant (skipping)',
      );
    }
  }

  return { ingested, skipped, errors };
}
