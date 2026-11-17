// Developer Proxy Ingester
//
// Polls GET /api/usage/ingestion-feed?after_id=<n>&limit=<n> on the
// developer-proxy and writes developer_proxy_llm events to
// cost_attribution_events through the canonical ingestEventWithBuckets
// boundary — the only OU-charging path; no vendor-specific Stripe meter.
//
// The feed cursors on the developer-proxy usage-log row id (assigned at
// insert = stream completion), so a long-running request whose row lands
// after the cursor last advanced is never skipped. The row id is the stable
// source_id for idempotency. Cursor is stored in cost_attribution_cursors
// with source = 'developer_proxy'.
//
// Auth: X-Service-Token header (DEVELOPER_PROXY_SERVICE_TOKEN) + OIDC identity
// token.

import { buildOidcAuthHeader } from '@liftoffos/service-client';
import { log } from '../../infrastructure/logging';
import { getRuntimeToInternalMap, toInternalAgentId } from '../../internal-agents/runtime-agent-id-map';
import {
  getCursor, updateCursor,
  resolveAccountIdForTenant, ingestEventWithBuckets,
} from '../repository';

const BATCH_SIZE = 500;

interface DevProxyFeedRow {
  id: string;
  tenantId: string;
  agentId: string | null;
  invocationId: string | null;
  actionId: string | null;
  attemptId: string | null;
  vendor: string;
  model: string;
  operation: string | null;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
  startedAt: string; // ISO string
}

interface DevProxyFeedResponse {
  rows: DevProxyFeedRow[];
  hasMore: boolean;
  nextAfterId: number;
}

async function buildDevProxyHeaders(baseUrl: string): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};

  const serviceToken = process.env.DEVELOPER_PROXY_SERVICE_TOKEN;
  if (serviceToken) {
    headers['x-service-token'] = serviceToken;
  }

  try {
    Object.assign(headers, await buildOidcAuthHeader(baseUrl));
  } catch {
    // Local dev / test: no metadata server, skip OIDC silently
  }

  return headers;
}

function getDevProxyBaseUrl(): string | null {
  const url = process.env.DEVELOPER_PROXY_SERVICE_URL;
  if (!url) return null;
  return url.replace(/\/$/, '');
}

export async function runDeveloperProxyIngester(): Promise<{ ingested: number; skipped: number }> {
  const devProxyBaseUrl = getDevProxyBaseUrl();
  if (!devProxyBaseUrl) {
    log.warn({}, 'developer-proxy-ingester: DEVELOPER_PROXY_SERVICE_URL is not set, skipping');
    return { ingested: 0, skipped: 0 };
  }

  let ingested = 0;
  let skipped  = 0;

  const { lastId } = await getCursor('developer_proxy');
  let afterId = lastId ? Number(lastId) : 0;
  let hasMore = true;
  let lastSeenId: number | null = null;
  let lastSeenTs: Date | null = null;

  while (hasMore) {
    const url = `${devProxyBaseUrl}/api/usage/ingestion-feed?after_id=${afterId}&limit=${BATCH_SIZE}`;
    const headers = await buildDevProxyHeaders(devProxyBaseUrl);

    let feed: DevProxyFeedResponse;
    try {
      const response = await fetch(url, { method: 'GET', headers });
      if (!response.ok) {
        log.warn(
          { status: response.status, url },
          'developer-proxy-ingester: non-OK response from developer-proxy, stopping pagination',
        );
        break;
      }
      feed = await response.json() as DevProxyFeedResponse;
    } catch (err) {
      log.warn(
        { error: (err as Error).message, url },
        'developer-proxy-ingester: network error reaching developer-proxy, stopping pagination',
      );
      break;
    }

    if (!feed.rows || feed.rows.length === 0) {
      hasMore = false;
      break;
    }

    const accountIdCache = new Map<string, string | null>();
    let n = 0;
    for (const row of feed.rows) {
      let accountId = accountIdCache.get(row.tenantId);
      if (accountId === undefined) {
        accountId = await resolveAccountIdForTenant(row.tenantId);
        accountIdCache.set(row.tenantId, accountId);
      }
      if (!accountId) continue;

      // This feed is global (cursor over all tenants), so the mapping is
      // resolved per row's tenant. getRuntimeToInternalMap is TTL-cached per
      // tenant, so a page touching one tenant costs one fetch.
      const runtimeToInternal = await getRuntimeToInternalMap(row.tenantId);
      const inserted = await ingestEventWithBuckets(accountId, row.id, row.costMicros / 1_000_000, {
        tenantId:     row.tenantId,
        // The developer-proxy service is a separate repo and the tenant runtime
        // calls it with its own runtime agents.id, so this feed's id space cannot
        // be verified from here. Translate defensively — identity-preserving, so
        // an already-internal id passes through untouched (INV-PB-009).
        agentId:      toInternalAgentId(runtimeToInternal, row.agentId),
        invocationId: row.invocationId ?? null,
        eventType:    'developer_proxy_llm',
        source:       'developer_proxy',
        provider:     row.vendor,
        model:        row.model,
        inputTokens:  row.inputTokens,
        outputTokens: row.outputTokens,
        occurredAt:   new Date(row.startedAt),
      });
      n += inserted > 0 ? 1 : 0;
    }
    ingested += n;
    skipped  += feed.rows.length - n;

    const lastRow = feed.rows[feed.rows.length - 1];
    lastSeenId = Number(lastRow.id);
    lastSeenTs = new Date(lastRow.startedAt);

    afterId = feed.nextAfterId;
    hasMore = feed.hasMore;

    log.debug(
      { ingested: n, skipped: feed.rows.length - n, afterId },
      'developer-proxy-ingester batch complete',
    );
  }

  if (lastSeenId !== null) {
    await updateCursor('developer_proxy', lastSeenTs ?? new Date(), String(lastSeenId));
  }

  return { ingested, skipped };
}
