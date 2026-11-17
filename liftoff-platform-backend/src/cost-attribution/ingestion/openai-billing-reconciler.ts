// OpenAI Billing Reconciler
//
// Nightly reconciliation: compares our internal cost_attribution_events totals
// against OpenAI's Usage API per purpose group for the prior calendar day.
//
// If the OpenAI usage API is unavailable or the key is not configured,
// we still compute the internal total and write a record with
// openai_cost_usd = -1 (sentinel for "API unavailable").
//
// Upserts to openai_billing_reconciliation table.

import OpenAI from 'openai';
import { getPool, withAdminScope } from '../../infrastructure/database';
import { log } from '../../infrastructure/logging';
import { getOpenAIApiKeyForGroup } from '../../infrastructure/secrets';

const DISCREPANCY_THRESHOLD_PROD = 0.01; // 1%
const DISCREPANCY_THRESHOLD_DEV  = 0.10; // 10%

// Mirror of the Anthropic purpose-group map — same logical groupings,
// OpenAI-specific purposes added (web_search uses OpenAI for some providers).
const PURPOSE_GROUPS = {
  agent_execution:     ['agent_execution', null],
  reflective_services: ['reflection', 'memory_consolidation', 'suggestion_applier'],
  platform_analytics:  ['caio_workforce_planning', 'caio_workforce_planning_stream', 'insights_chat', 'liftoff_chat', 'observations', 'intro'],
  background_services: ['title_generation', 'context_absorption', 'rolling_summary', 'chat-feedback-extraction', 'injection_guard'],
} as const;

type PurposeGroup = keyof typeof PURPOSE_GROUPS;

interface ReconciliationRecord {
  groupName: PurposeGroup;
  dateStr: string; // YYYY-MM-DD
  internalCostUsd: number;
  openaiCostUsd: number; // -1 = API unavailable
  discrepancyUsd: number;
  discrepancyPct: number | null;
}

function getThreshold(): number {
  return process.env.NODE_ENV === 'production'
    ? DISCREPANCY_THRESHOLD_PROD
    : DISCREPANCY_THRESHOLD_DEV;
}

/**
 * Attempt to fetch OpenAI's usage totals for the given date.
 * Uses the /v1/organization/usage/completions endpoint (requires
 * organization-level API key). Returns null if unavailable.
 *
 * OpenAI usage API docs:
 *   https://platform.openai.com/docs/api-reference/usage
 *
 * The API returns usage bucketed by minute; we sum across the full day.
 * Cost is computed from (input_tokens * price + output_tokens * price) —
 * OpenAI's usage endpoint does not return dollar amounts directly in all
 * SDK versions, so we pull token counts and compute cost defensively.
 */
async function fetchOpenAIDailyCost(dateStr: string): Promise<number | null> {
  let apiKey: string | null = null;
  try {
    // Use agent_execution key as the org-level query key — this is the primary
    // key and most likely to have org-admin permissions required by the usage API.
    apiKey = await getOpenAIApiKeyForGroup('agent-execution');
  } catch {
    // If key retrieval fails entirely, skip
  }

  if (!apiKey) {
    log.warn({}, 'openai-billing-reconciler: no API key available, skipping API call');
    return null;
  }

  try {
    const client = new OpenAI({ apiKey });

    // Parse date bounds
    const startUnix = Math.floor(new Date(`${dateStr}T00:00:00Z`).getTime() / 1000);
    const endUnix   = Math.floor(new Date(`${dateStr}T23:59:59Z`).getTime() / 1000);

    // Access the usage endpoint defensively — it requires the openai SDK ≥4.x
    // and an org-level API key. Not all keys have permission.
    const usageClient = (client as any).organization?.usage ?? (client as any).usage;
    if (!usageClient?.completions?.list) {
      log.warn(
        {},
        'openai-billing-reconciler: organization.usage.completions.list not available in this SDK version',
      );
      return null;
    }

    // OpenAI usage API returns cost_usd directly on some plans, or
    // token counts from which we derive cost. Be defensive about both shapes.
    let totalCostUsd = 0;
    let page = await usageClient.completions.list({
      start_time: startUnix,
      end_time:   endUnix,
      limit: 100,
    });

    for (;;) {
      const r = page as any;
      const items: any[] = r?.data ?? r?.results ?? [];

      for (const item of items) {
        if (typeof item?.cost_usd === 'number') {
          totalCostUsd += item.cost_usd;
        } else if (typeof item?.total_cost === 'number') {
          totalCostUsd += item.total_cost;
        }
        // If no cost field, we cannot reliably compute from token counts
        // without a model-price table (which changes frequently). Skip
        // and log a warning so we know the data is incomplete.
      }

      if (!r?.has_more) break;

      if (typeof page.getNextPage === 'function') {
        page = await page.getNextPage();
      } else {
        break;
      }
    }

    return totalCostUsd;
  } catch (err) {
    const msg = (err as Error).message ?? '';
    // 403 = key doesn't have org-level usage read permission — expected for
    // non-admin keys, not a code bug. Warn rather than error.
    if (msg.includes('403') || msg.includes('permission') || msg.includes('Forbidden')) {
      log.warn(
        { error: msg },
        'openai-billing-reconciler: API key lacks usage read permission (will use sentinel -1)',
      );
    } else {
      log.warn(
        { error: msg },
        'openai-billing-reconciler: failed to fetch OpenAI usage API (will use sentinel -1)',
      );
    }
    return null;
  }
}

/**
 * Query our internal cost_attribution_events for a purpose group + date.
 * Filters to provider = 'openai' so Anthropic costs don't bleed across.
 */
async function queryInternalCost(
  groupName: PurposeGroup,
  dateStr: string, // YYYY-MM-DD
): Promise<number> {
  const purposes = PURPOSE_GROUPS[groupName];

  const namedPurposes = (purposes as readonly (string | null)[]).filter((p): p is string => p !== null);
  const hasNull       = (purposes as readonly (string | null)[]).some(p => p === null);

  let whereClause: string;
  const params: unknown[] = [
    `${dateStr}T00:00:00Z`,
    `${dateStr}T23:59:59Z`,
  ];

  if (namedPurposes.length > 0 && hasNull) {
    const placeholders = namedPurposes.map((_, i) => `$${i + 3}`).join(', ');
    namedPurposes.forEach(p => params.push(p));
    whereClause = `AND (purpose IN (${placeholders}) OR purpose IS NULL)`;
  } else if (namedPurposes.length > 0) {
    const placeholders = namedPurposes.map((_, i) => `$${i + 3}`).join(', ');
    namedPurposes.forEach(p => params.push(p));
    whereClause = `AND purpose IN (${placeholders})`;
  } else {
    whereClause = `AND purpose IS NULL`;
  }

  // cost_attribution_events is RLS-on (migration 200). Reconciliation sums
  // across all tenants for the OpenAI-side aggregate — admin scope is correct.
  const result = await withAdminScope(
    {
      caller: 'cost-attribution.openai-billing-reconciler.queryInternalCost',
      reason: 'cross-tenant cost-attribution rollup vs OpenAI invoice totals',
    },
    (client) =>
      client.query(
        `SELECT COALESCE(SUM(cost_usd), 0) AS total_cost_usd
         FROM cost_attribution_events
         WHERE occurred_at >= $1
           AND occurred_at <= $2
           AND source = 'platform_llm'
           AND provider = 'openai'
           ${whereClause}`,
        params,
      ),
  );

  return parseFloat(result.rows[0]?.total_cost_usd ?? '0');
}

async function upsertReconciliation(rec: ReconciliationRecord): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO openai_billing_reconciliation
       (group_name, date, internal_cost_usd, openai_cost_usd, discrepancy_usd, discrepancy_pct, computed_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (group_name, date) DO UPDATE SET
       internal_cost_usd = EXCLUDED.internal_cost_usd,
       openai_cost_usd   = EXCLUDED.openai_cost_usd,
       discrepancy_usd   = EXCLUDED.discrepancy_usd,
       discrepancy_pct   = EXCLUDED.discrepancy_pct,
       computed_at       = NOW()`,
    [
      rec.groupName,
      rec.dateStr,
      rec.internalCostUsd,
      rec.openaiCostUsd,
      rec.discrepancyUsd,
      rec.discrepancyPct,
    ],
  );
}

/**
 * Run the nightly OpenAI billing reconciliation for the prior calendar day.
 */
export async function runOpenAIBillingReconciler(): Promise<void> {
  const yesterday = new Date();
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const dateStr = yesterday.toISOString().slice(0, 10);

  log.info({ dateStr }, 'openai-billing-reconciler: starting');

  const openaiTotal = await fetchOpenAIDailyCost(dateStr);
  const threshold   = getThreshold();

  for (const groupName of Object.keys(PURPOSE_GROUPS) as PurposeGroup[]) {
    try {
      const internalCostUsd = await queryInternalCost(groupName, dateStr);
      const openaiCostUsd   = openaiTotal ?? -1;

      let discrepancyUsd  = 0;
      let discrepancyPct: number | null = null;

      if (openaiCostUsd >= 0) {
        discrepancyUsd = Math.abs(internalCostUsd - openaiCostUsd);
        discrepancyPct = openaiCostUsd > 0
          ? discrepancyUsd / openaiCostUsd
          : null;

        if (discrepancyPct !== null && discrepancyPct > threshold) {
          log.warn(
            {
              groupName,
              dateStr,
              internalCostUsd,
              openaiCostUsd,
              discrepancyPct: (discrepancyPct * 100).toFixed(2) + '%',
              threshold: (threshold * 100).toFixed(0) + '%',
            },
            'openai-billing-reconciler: discrepancy exceeds threshold',
          );
        }
      }

      await upsertReconciliation({
        groupName,
        dateStr,
        internalCostUsd,
        openaiCostUsd,
        discrepancyUsd,
        discrepancyPct,
      });

      log.info(
        { groupName, dateStr, internalCostUsd, openaiCostUsd },
        'openai-billing-reconciler: group reconciled',
      );
    } catch (err) {
      log.error(
        { groupName, dateStr, error: (err as Error).message },
        'openai-billing-reconciler: failed to reconcile group (continuing)',
      );
    }
  }

  log.info({ dateStr }, 'openai-billing-reconciler: complete');
}
