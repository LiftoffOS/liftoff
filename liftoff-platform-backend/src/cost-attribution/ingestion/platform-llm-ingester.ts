// Platform LLM Ingester
//
// Reads llm_usage_log (platform-backend's own DB) and writes to
// cost_attribution_events. This covers all LLM calls made by
// platform-backend itself: insights, CAIO, distillation, agent chat
// secondary calls (title generation, rolling summary, etc.).
//
// Cursor: the MAX(timestamp) of the last ingested row, stored in
// cost_attribution_cursors WHERE source = 'platform_llm'.

import { log } from '../../infrastructure/logging';
import {
  getCursor, updateCursor,
  resolveAccountIdForTenant, ingestEventWithBuckets,
} from '../repository';
import { withAdminScope } from '../../infrastructure/database';
import { computeRowCost } from '../../llm/pricing';
import { wasRunByokFunded } from '../../byok-gateway/usage-recorder';

const BATCH_SIZE = 500;

interface UsageLogRow {
  id:                       string;
  tenant_id:                string;
  agent_id:                 string | null;
  provider:                 string;
  model:                    string;
  purpose:                  string | null;
  input_tokens:             string;
  output_tokens:            string;
  cache_creation_input_tokens: string | null;
  cache_read_input_tokens:  string | null;
  /** What the vendor charged, when it reported one (NUMERIC arrives as a
   *  string). NULL for every direct-API provider. */
  vendor_cost_usd: string | null;
  web_search_requests:      string | null;
  success:                  boolean;
  timestamp:                Date;
  session_id:               string | null;
  item_id:                  string | null;  // platform-owner attribution for knowledge embeds
  invocation_id:            string | null;  // the run the BYOK gateway keyed its request rows by
}

export async function runPlatformLLMIngester(): Promise<{ ingested: number; skipped: number }> {
  let ingested = 0;
  let skipped  = 0;

  const { lastTs } = await getCursor('platform_llm');
  const since = lastTs ?? new Date(0);

  let pageTs = since;
  let hasMore = true;

  while (hasMore) {
    // Cross-tenant read: this ingester sweeps llm_usage_log for every tenant's
    // platform LLM usage. withAdminScope (liftoff_admin, BYPASSRLS) is required
    // once FORCE ROW LEVEL SECURITY is enabled — a plain getPool() read would be
    // filtered to (and error on) the unset app.current_tenant_id GUC. The
    // per-row write path (ingestEventWithBuckets) already self-scopes via
    // withAdminScope.
    const result = await withAdminScope(
      {
        caller: 'cost-attribution.platform-llm-ingester',
        reason: "cross-tenant read of llm_usage_log to ingest every tenant's platform LLM usage into cost_attribution_events",
      },
      (client) => client.query<UsageLogRow>(
      `SELECT
         id::text,
         tenant_id, agent_id, provider,
         COALESCE(model, '') as model,
         purpose, input_tokens, output_tokens,
         cache_creation_input_tokens,
         cache_read_input_tokens,
         web_search_requests,
         COALESCE(success, true) as success,
         timestamp, session_id, item_id, invocation_id,
         vendor_cost_usd
       FROM llm_usage_log
       WHERE timestamp > $1 AND tenant_id IS NOT NULL
       ORDER BY timestamp ASC
       LIMIT $2`,
      [pageTs, BATCH_SIZE],
      ),
    );

    if (result.rows.length === 0) {
      hasMore = false;
      break;
    }

    // Resolve accountId per tenant at batch boundary to avoid N+1 lookups
    const accountIdCache = new Map<string, string | null>();
    // Same reason, for the BYOK lookup: one chat turn writes several usage rows
    // under ONE invocation id (the turn, its summarization, its title), and the
    // answer is a property of the run rather than of the row. Without this the
    // page pays one query per row for a question it already asked.
    const byokCache = new Map<string, boolean>();
    let n = 0;
    let attempted = 0;
    for (const row of result.rows) {
      const inputTokens  = parseInt(row.input_tokens)  || 0;
      const outputTokens = parseInt(row.output_tokens) || 0;
      const cacheCreate  = parseInt(row.cache_creation_input_tokens ?? '0') || 0;
      const cacheRead    = parseInt(row.cache_read_input_tokens  ?? '0') || 0;

      // row.timestamp, not now(): conditional rates can be scoped to a UTC
      // window, so a row must be priced against when the CALL happened. A
      // catch-up sweep after an outage would otherwise price hours of backlog
      // against whichever window the ingester happened to run in.
      // WHAT THE VENDOR CHARGED BEATS WHAT WE WOULD HAVE ESTIMATED.
      //
      // For a gateway-served model the estimate cannot be right in principle:
      // the same model is served by many endpoints at different prices, and a
      // price list cannot say which one took the request. `sync-model-pricing`
      // answers that with the MAX across endpoints — safe, and about 2x the
      // median, so the customer is charged for an endpoint we did not use.
      // Where the vendor reported the real charge, that is the figure.
      //
      // Parsed with `> 0` rather than a null check: a NULL or an unparseable
      // value must fall through to the estimate, never book zero. NULL is the
      // normal case for Anthropic, OpenAI, Google and xAI, which publish price
      // lists rather than per-call charges.
      const reported = row.vendor_cost_usd == null ? NaN : Number(row.vendor_cost_usd);
      const costUsd = Number.isFinite(reported) && reported > 0
        ? reported
        : computeRowCost(
            row.provider,
            row.model,
            inputTokens,
            outputTokens,
            cacheCreate,
            cacheRead,
            row.timestamp,
          );

      let accountId = accountIdCache.get(row.tenant_id);
      if (accountId === undefined) {
        accountId = await resolveAccountIdForTenant(row.tenant_id);
        accountIdCache.set(row.tenant_id, accountId);
      }
      attempted += 1;
      if (!accountId) continue;

      // Whose key paid. The gateway is the only component that sees which
      // credential went out on the wire, so the answer is read from its own
      // per-request rows rather than re-derived here. A run with no gateway
      // rows — every ordinary call — answers false and bills as it does today.
      let byokFunded = false;
      if (row.invocation_id) {
        const byokKey = `${row.tenant_id}:${row.invocation_id}`;
        const cached = byokCache.get(byokKey);
        if (cached === undefined) {
          byokFunded = await wasRunByokFunded(row.tenant_id, row.invocation_id);
          byokCache.set(byokKey, byokFunded);
        } else {
          byokFunded = cached;
        }
      }

      const inserted = await ingestEventWithBuckets(accountId, row.id, costUsd, {
        tenantId:              row.tenant_id,
        byokFunded,
        // ATTRIBUTION_AGENT_ID_OK: llm_usage_log is THIS repo's own table,
        // written by this repo's LLM calls with internal_agents.id. The one
        // historical exception was skills-backfill.ts, which logged the RUNTIME
        // id under purpose='skills_decomposition'; it was deleted in 9009626
        // and its orphaned rows are re-keyed by
        // src/scripts/backfill-attribution-agent-ids.ts. No runtime feed reaches
        // this ingester, so translating here would be semantically wrong.
        agentId:               row.agent_id,
        purpose:               row.purpose,
        eventType:             'llm_invocation',
        source:                'platform_llm',
        provider:              row.provider,
        model:                 row.model,
        inputTokens,
        outputTokens,
        cachedTokens:          cacheRead,
        correlationConfidence: row.agent_id ? 'direct' : 'unmatched',
        occurredAt:            row.timestamp,
        itemId:                row.item_id,
      });
      n += inserted > 0 ? 1 : 0;
    }
    ingested += n;
    skipped  += attempted - n;

    // Advance cursor to the timestamp of the last row in this batch
    pageTs = result.rows[result.rows.length - 1].timestamp;

    if (result.rows.length < BATCH_SIZE) {
      hasMore = false;
    }

    log.debug(
      { ingested: n, skipped: attempted - n, pageTs },
      'platform-llm-ingester batch complete',
    );
  }

  // Persist the new cursor
  if (ingested > 0 || skipped > 0) {
    await updateCursor('platform_llm', pageTs);
  }

  return { ingested, skipped };
}
