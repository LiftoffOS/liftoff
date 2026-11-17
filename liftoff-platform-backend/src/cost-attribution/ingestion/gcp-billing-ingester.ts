// GCP Billing Ingester
//
// Queries the GCP Billing BigQuery export table for tenant-attributed and
// platform-level infrastructure costs, then writes them as 'infra_compute'
// events to cost_attribution_events.
//
// Run daily (once per day). Uses a date-based cursor stored under source
// key 'gcp_billing' in cost_attribution_cursors. Defaults to yesterday if
// no cursor is set. Processes one day at a time to support catch-up.
//
// Two queries per run:
//   A) Tenant-labeled resources  — resources tagged with `tenant-id` GCP label
//   B) Platform overhead          — unlabeled resources, summed to a single row
//                                   attributed to the 'platform' sentinel tenant
//
// Environment variables:
//   GCP_BILLING_SHARED_BQ_DATASET — fully-qualified BQ table reference in the
//     form 'project.dataset.table', e.g.
//     'YOUR_CONTROL_PROJECT.billing_export.gcp_billing_export_resource_v1_ABCD'
//
// If GCP_BILLING_SHARED_BQ_DATASET is not set the ingester returns immediately
// with { ingested: 0, skipped: 0 } so the server can start without BQ.

import { getBigQueryClient } from '../../infrastructure/bigquery-client';
import { log } from '../../infrastructure/logging';
import {
  getCursor, updateCursor, insertEvents,
  resolveAccountIdForTenant, ingestEventWithBuckets,
} from '../repository';

// ── Types ─────────────────────────────────────────────────────────────

interface TenantBillingRow {
  tenant_id: string;
  gcp_service: string;
  cost_usd: number;
  usage_date: string;
}

interface PlatformOverheadRow {
  gcp_service: string;
  cost_usd: number;
}

/** A GCP label is free text; a tenant id is a UUID. Only one of those is safe to
 *  put in a `WHERE id = $1` against a uuid column. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Date helpers ──────────────────────────────────────────────────────

/** Return an ISO date string (YYYY-MM-DD) for yesterday in UTC. */
function yesterdayUtc(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Parse the last processed date from cursor last_ts. Returns null when unset. */
function cursorToDate(lastTs: Date | null): string | null {
  if (!lastTs) return null;
  return lastTs.toISOString().slice(0, 10);
}

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * True when BigQuery says the configured TABLE does not exist.
 *
 * This is not the same as "the export has no data yet", and conflating the two
 * cost six months of ingestion. An export table that exists but holds nothing
 * for the requested day returns ZERO ROWS, not an error — it never reaches this
 * function. So an exception here means the reference itself is wrong: a typo, a
 * renamed table, or a dataset that was never created.
 *
 * Matching is narrow for the same reason. `msg.includes('not found')` also
 * matched "Not found: Dataset", a missing column, and any unrelated message
 * containing those words, so a genuine query bug would be swallowed as a benign
 * skip.
 */
function isMissingBillingTable(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return msg.includes('not found: table') || msg.includes('not found: dataset');
}

// ── Ingester ──────────────────────────────────────────────────────────

export interface GcpBillingIngestResult {
  ingested: number;
  skipped: number;
  /**
   * The configured table does not exist. Distinct from "nothing to ingest": a
   * caller looping for catch-up must stop rather than spin, and an operator
   * needs to know the difference between no data and no table.
   */
  tableMissing?: boolean;
}

export async function runGcpBillingIngester(): Promise<GcpBillingIngestResult> {
  const billingTable = process.env.GCP_BILLING_SHARED_BQ_DATASET;

  if (!billingTable) {
    log.warn('GCP_BILLING_SHARED_BQ_DATASET not set — gcp-billing-ingester skipped');
    return { ingested: 0, skipped: 0 };
  }

  const { lastTs } = await getCursor('gcp_billing');
  const lastProcessedDate = cursorToDate(lastTs);
  const yesterday = yesterdayUtc();

  // No-op if already up to date (cursor is at or beyond yesterday)
  if (lastProcessedDate && lastProcessedDate >= yesterday) {
    log.debug(
      { lastProcessedDate, yesterday },
      'gcp-billing-ingester: cursor is current, nothing to do',
    );
    return { ingested: 0, skipped: 0 };
  }

  // Process only one day at a time; caller may invoke daily to catch up.
  const date = lastProcessedDate ? nextDay(lastProcessedDate) : yesterdayUtc();

  log.info({ date, billingTable }, 'gcp-billing-ingester: processing date');

  const bq = getBigQueryClient();
  // Each event needs a tx to call applyOuConsumption; we collect inputs and
  // process them via ingestEventWithBuckets after both queries finish.
  interface PendingEvent {
    accountId: string | 'PLATFORM_NULL';
    baseSourceId: string;
    rawCostUsd: number;
    template: Parameters<typeof ingestEventWithBuckets>[3];
  }
  const pending: PendingEvent[] = [];
  /** Rows the platform-overhead insert actually wrote, reported by insertEvents. */
  let platformInserted = 0;
  /** Cost on resources whose `tenant-id` label is not a tenant id. Folded into
   *  platform overhead so it is recorded rather than lost. */
  let unattributableUsd = 0;
  const unattributableLabels = new Set<string>();
  const accountIdCache = new Map<string, string | null>();

  // ── Query A: Tenant-labeled resources ─────────────────────────────

  const tenantQuery = `
    SELECT
      (SELECT value FROM UNNEST(labels) WHERE key = 'tenant-id') AS tenant_id,
      service.description AS gcp_service,
      SUM(cost) AS cost_usd,
      DATE(usage_start_time) AS usage_date
    FROM \`${billingTable}\`
    WHERE DATE(usage_start_time) = @date
      AND EXISTS (SELECT 1 FROM UNNEST(labels) WHERE key = 'tenant-id')
    GROUP BY tenant_id, gcp_service, usage_date
  `;

  try {
    const [tenantRows] = await bq.query({
      query: tenantQuery,
      params: { date },
      location: 'US',
    });

    for (const row of tenantRows as TenantBillingRow[]) {
      if (!row.tenant_id || row.cost_usd == null) continue;
      const cost = typeof row.cost_usd === 'number' ? row.cost_usd : parseFloat(String(row.cost_usd));
      if (isNaN(cost)) continue;

      // A `tenant-id` label is not necessarily a tenant id. Every labelled
      // resource in the estate today carries `tenant-id: liftoffos` — a name,
      // not a UUID — and passing that to a uuid column threw
      // `invalid input syntax for type uuid` and killed the whole day.
      //
      // The cost is real either way, so it is added to platform overhead below
      // rather than dropped: skipping it would under-report GCP spend, which is
      // the same silent loss this ingester was fixed to stop. If resources are
      // ever labelled with real tenant UUIDs, they attribute normally.
      if (!UUID_PATTERN.test(row.tenant_id)) {
        unattributableUsd += cost;
        unattributableLabels.add(row.tenant_id);
        continue;
      }

      let accountId = accountIdCache.get(row.tenant_id);
      if (accountId === undefined) {
        accountId = await resolveAccountIdForTenant(row.tenant_id);
        accountIdCache.set(row.tenant_id, accountId);
      }
      if (!accountId) continue;
      pending.push({
        accountId,
        baseSourceId: `${date}_${row.tenant_id}_${row.gcp_service}`,
        rawCostUsd: cost,
        template: {
          tenantId:    row.tenant_id,
          agentId:     null,
          purpose:     row.gcp_service,
          eventType:   'infra_compute',
          source:      'gcp_billing',
          occurredAt:  new Date(`${row.usage_date ?? date}T00:00:00Z`),
        },
      });
    }

    log.debug({ count: tenantRows.length, date }, 'gcp-billing-ingester: tenant rows fetched');
  } catch (err) {
    if (isMissingBillingTable(err)) {
      // ERROR, not info. This is a misconfiguration that stops all GCP cost
      // ingestion, and it will not fix itself — it has to be visible. Logged as
      // an info-level "not yet populated" it ran daily for six months against a
      // table name whose billing-account segments had lost their underscores,
      // while the real table held 5.3M rows.
      log.error(
        { error: (err as Error).message, date, billingTable },
        'gcp-billing-ingester: configured billing export table does not exist — check GCP_BILLING_SHARED_BQ_DATASET names a real project.dataset.table',
      );
      return { ingested: 0, skipped: 0, tableMissing: true };
    }
    log.error(
      { error: (err as Error).message, date },
      'gcp-billing-ingester: tenant query failed',
    );
    throw err;
  }

  // ── Query B: Platform overhead (unlabeled resources) ──────────────

  const platformQuery = `
    SELECT
      service.description AS gcp_service,
      SUM(cost) AS cost_usd
    FROM \`${billingTable}\`
    WHERE DATE(usage_start_time) = @date
      AND NOT EXISTS (SELECT 1 FROM UNNEST(labels) WHERE key = 'tenant-id')
      AND cost > 0
    GROUP BY gcp_service
  `;

  try {
    const [platformRows] = await bq.query({
      query: platformQuery,
      params: { date },
      location: 'US',
    });

    let platformTotalUsd = 0;
    for (const row of platformRows as PlatformOverheadRow[]) {
      if (row.cost_usd == null) continue;
      const cost = typeof row.cost_usd === 'number' ? row.cost_usd : parseFloat(String(row.cost_usd));
      if (!isNaN(cost)) {
        platformTotalUsd += cost;
      }
    }

    // Cost that carried a `tenant-id` label naming something that is not a
    // tenant. Query B excludes it (it HAS the label), and the tenant path
    // cannot use it, so without this it belongs to neither and disappears.
    if (unattributableUsd > 0) {
      platformTotalUsd += unattributableUsd;
      log.warn(
        { date, unattributableUsd, labels: [...unattributableLabels] },
        'gcp-billing-ingester: tenant-id labels that are not tenant ids — cost recorded as platform overhead',
      );
    }

    if (platformTotalUsd > 0) {
      // Platform overhead is NOT a tenant — there is no billing_controls row,
      // no OU counter to increment, no per-bucket rate to apply. Write the
      // attribution row directly (bypassing ingestEventWithBuckets, which
      // requires an accountId). ou_consumed is derived from the global
      // definition rate (matches Migration A.5 step 1); customer_cost_usd is
      // zero; cost_bucket is the explicit 'platform_overhead' value (migration
      // 208) so the same /insights filters that hide platform-internal LLM
      // consumption also hide this row from customer-facing surfaces.
      const ouConsumed = platformTotalUsd / 0.01; // ou_definition_rate_usd
      platformInserted = await insertEvents([{
        tenantId:   'platform',
        agentId:    null,
        purpose:    'GCP platform overhead',
        eventType:  'infra_compute',
        source:     'gcp_billing_platform',
        sourceId:   `${date}_platform_overhead`,
        costUsd:    platformTotalUsd,
        ouConsumed,
        customerCostUsd: 0,
        costBucket: 'platform_overhead',
        occurredAt: new Date(`${date}T00:00:00Z`),
      }]);
    }

    log.debug(
      { count: platformRows.length, platformTotalUsd, date },
      'gcp-billing-ingester: platform overhead fetched',
    );
  } catch (err) {
    if (isMissingBillingTable(err)) {
      log.error(
        { error: (err as Error).message, date, billingTable },
        'gcp-billing-ingester: configured billing export table does not exist — check GCP_BILLING_SHARED_BQ_DATASET names a real project.dataset.table',
      );
      return { ingested: 0, skipped: 0, tableMissing: true };
    }
    log.error(
      { error: (err as Error).message, date },
      'gcp-billing-ingester: platform overhead query failed',
    );
    throw err;
  }

  // ── Insert and advance cursor ──────────────────────────────────────

  let ingested = 0;
  for (const ev of pending) {
    const inserted = await ingestEventWithBuckets(
      ev.accountId, ev.baseSourceId, ev.rawCostUsd, ev.template,
    );
    if (inserted > 0) ingested += 1;
  }
  // The platform-overhead row is written directly above (no OU bucketing), and
  // insertEvents already reports how many rows it wrote.
  //
  // This used to re-read the row through an unscoped pool instead, which was
  // wrong twice. cost_attribution_events is RLS-FORCED, so the query raised
  // "unrecognized configuration parameter app.current_tenant_id" and killed the
  // run — invisible until now only because the BigQuery read above had never
  // once succeeded, so this line had never executed. And a COUNT over the table
  // cannot tell a row written by THIS run from one written by an earlier run of
  // the same date, so a re-run counted a day it had inserted nothing on.
  ingested += platformInserted;

  const skipped = pending.length - ingested;

  // Advance cursor to the end of the processed day (midnight next day)
  await updateCursor('gcp_billing', new Date(`${date}T23:59:59Z`));

  log.info({ date, ingested, skipped }, 'gcp-billing-ingester: complete');
  return { ingested, skipped };
}

// ── Internal helpers ──────────────────────────────────────────────────

/** Return the ISO date string for the day after the given YYYY-MM-DD string. */
function nextDay(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
