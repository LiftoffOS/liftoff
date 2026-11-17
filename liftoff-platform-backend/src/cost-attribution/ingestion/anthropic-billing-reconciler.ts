// Anthropic Billing Reconciler
//
// Nightly: compares what we recorded ourselves against what Anthropic reports,
// for the prior UTC day.
//
// The comparison is split, because Anthropic's two reports answer different
// questions:
//
//   PER GROUP, ON TOKENS. Each purpose group already has its own Anthropic API
//   key (ANTHROPIC_API_KEY_<GROUP>), and usage_report groups by api_key_id — so
//   a group's token totals can be compared directly. Tokens are also the
//   stronger attribution signal: a token mismatch means we mis-recorded usage,
//   with our own price table held out as a separate variable.
//
//   ORGANISATION-WIDE, ON DOLLARS. cost_report groups only by description or
//   workspace, so dollars cannot be split per key. anthropic_cost_usd therefore
//   carries the org-wide figure, repeated on each of the day's rows. Comparing a
//   single group's internal cost against it is a category error.
//
// Needs an ADMIN credential (ANTHROPIC_ADMIN_KEY). The per-group message keys
// cannot read these reports. Without it the run records what it knows and says
// plainly that the vendor side is missing, rather than reporting success.

import { withAdminScope, getPool } from '../../infrastructure/database';
import { log } from '../../infrastructure/logging';
import { fetchUsageByApiKey, fetchOrgCostUsd, type ApiKeyTokenUsage, fetchOrgApiKeys } from './anthropic-admin-api';

// Discrepancy thresholds per environment
const DISCREPANCY_THRESHOLD_PROD = 0.01; // 1%
const DISCREPANCY_THRESHOLD_DEV  = 0.10; // 10%

const PURPOSE_GROUPS = {
  agent_execution:     ['agent_execution', null],
  reflective_services: ['reflection', 'memory_consolidation', 'suggestion_applier'],
  platform_analytics:  ['caio_workforce_planning', 'caio_workforce_planning_stream', 'insights_chat', 'liftoff_chat', 'observations', 'intro'],
  background_services: ['title_generation', 'context_absorption', 'rolling_summary', 'chat-feedback-extraction', 'injection_guard'],
} as const;

type PurposeGroup = keyof typeof PURPOSE_GROUPS;

// Which Anthropic API key id belongs to which group. Anthropic reports usage
// against the key ID (`apikey_01...`), never the secret, so the mapping has to
// be configured — it cannot be derived from the keys we hold.
const GROUP_KEY_ID_ENV: Record<PurposeGroup, string> = {
  agent_execution:     'ANTHROPIC_API_KEY_ID_AGENT_EXECUTION',
  reflective_services: 'ANTHROPIC_API_KEY_ID_REFLECTIVE_SERVICES',
  platform_analytics:  'ANTHROPIC_API_KEY_ID_PLATFORM_ANALYTICS',
  background_services: 'ANTHROPIC_API_KEY_ID_BACKGROUND_SERVICES',
};

/** The key NAME each group's credential carries, which is what lets the id be
 *  discovered rather than configured: `liftoff-<group>-<environment>`, the
 *  convention every key in the organisation already follows. */
function keyNameFor(group: PurposeGroup): string {
  return `liftoff-${group.replace(/_/g, '-')}-${process.env.ENVIRONMENT ?? 'dev'}`;
}

/**
 * Group -> Anthropic API key id, discovered from the organisation rather than
 * configured.
 *
 * Anthropic reports usage against the key ID (`apikey_01...`), never the secret,
 * so something has to connect the two. Four env vars were the original answer
 * and they were never set, which is part of why the vendor half of this table
 * has been empty since it was created: the service's environment is Terraform
 * managed, so adding them is an infrastructure change that has to land before
 * the code can do anything.
 *
 * It does not need to be configured. The admin credential this reconciler
 * already holds can list the organisation's keys, and every key follows one
 * naming convention, so the id is derivable from the group and the environment.
 * That also survives ROTATION: a replacement key created under the same name is
 * picked up on the next run, where a pinned id would silently stop matching and
 * report the group as having no vendor usage.
 *
 * Two keys can share a name — the organisation holds an `active` key per group
 * in a workspace and an older `inactive` or `archived` twin outside one — so
 * status is part of the match, not a detail. Matching the archived twin returns
 * zero usage for a group that is spending.
 *
 * The env var still WINS where it is set, so an operator can pin one group
 * without a deploy. Absent, which is the normal case, discovery answers.
 */
async function resolveGroupKeyIds(adminKey: string): Promise<Map<PurposeGroup, string>> {
  const resolved = new Map<PurposeGroup, string>();
  const groups = Object.keys(PURPOSE_GROUPS) as PurposeGroup[];

  // An explicit pin short-circuits the lookup for that group.
  for (const g of groups) {
    const pinned = process.env[GROUP_KEY_ID_ENV[g]];
    if (pinned) resolved.set(g, pinned);
  }
  if (resolved.size === groups.length) return resolved;

  const keys = await fetchOrgApiKeys(adminKey);
  if (!keys) {
    // getJson already logged the status. Say what the CONSEQUENCE is, since a
    // non-2xx on its own does not tell the next reader what stopped working.
    log.warn({},
      'anthropic-billing-reconciler: organisation key list unavailable — per-group token attribution is skipped for this run, org-wide dollars are not affected');
    return resolved;
  }

  for (const g of groups) {
    if (resolved.has(g)) continue;
    const want = keyNameFor(g);
    const match = keys.find((k) => k.name === want && k.status === 'active');
    if (match?.id) resolved.set(g, match.id);
    else {
      log.warn({ groupName: g, expectedKeyName: want, pinEnv: GROUP_KEY_ID_ENV[g] },
        'anthropic-billing-reconciler: no ACTIVE organisation key of that name — vendor tokens cannot be attributed to this group');
    }
  }
  return resolved;
}

/** discrepancy_pct is NUMERIC(6,4): anything at or above 100 overflows. */
const MAX_STORED_PCT = 99.9999;

interface InternalTotals {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

interface ReconciliationRecord {
  groupName: PurposeGroup;
  dateStr: string;
  internal: InternalTotals;
  /** Org-wide, not per group. -1 means the cost report was unavailable. */
  anthropicCostUsd: number;
  anthropicTokens: ApiKeyTokenUsage | null;
  discrepancyUsd: number;
  discrepancyPct: number | null;
  tokenDiscrepancyPct: number | null;
}

function getThreshold(): number {
  return process.env.NODE_ENV === 'production'
    ? DISCREPANCY_THRESHOLD_PROD
    : DISCREPANCY_THRESHOLD_DEV;
}

function clampPct(pct: number | null): number | null {
  if (pct === null || !Number.isFinite(pct)) return null;
  return Math.min(pct, MAX_STORED_PCT);
}

/**
 * Our own totals for a purpose group on a date.
 *
 * `provider = 'anthropic'` is not optional. Without it this sums every vendor's
 * platform spend and compares the total against Anthropic alone, which is wrong
 * by however much of the mix is not Anthropic — silently, and by more every time
 * a vendor is added. The OpenAI sibling has always filtered; this one did not.
 */
async function queryInternalTotals(
  groupName: PurposeGroup,
  dateStr: string,
): Promise<InternalTotals> {
  const purposes = PURPOSE_GROUPS[groupName];
  const namedPurposes = (purposes as readonly (string | null)[]).filter((p): p is string => p !== null);
  const hasNull       = (purposes as readonly (string | null)[]).some(p => p === null);

  const params: unknown[] = [`${dateStr}T00:00:00Z`, `${dateStr}T23:59:59Z`];
  let whereClause: string;
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
  // across all tenants against an organisation-level vendor report — admin
  // scope is correct.
  const result = await withAdminScope(
    {
      caller: 'cost-attribution.anthropic-billing-reconciler.queryInternalTotals',
      reason: 'cross-tenant cost-attribution rollup vs Anthropic organisation reports',
    },
    (client) =>
      client.query<{ total_cost_usd: string; input_tokens: string; output_tokens: string }>(
        `SELECT COALESCE(SUM(cost_usd), 0)                       AS total_cost_usd,
                COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(cached_tokens), 0) AS input_tokens,
                COALESCE(SUM(output_tokens), 0)                  AS output_tokens
           FROM cost_attribution_events
          WHERE occurred_at >= $1
            AND occurred_at <= $2
            AND source = 'platform_llm'
            AND provider = 'anthropic'
            ${whereClause}`,
        params,
      ),
  );

  const row = result.rows[0];
  return {
    costUsd:      parseFloat(row?.total_cost_usd ?? '0'),
    inputTokens:  parseInt(row?.input_tokens ?? '0', 10),
    outputTokens: parseInt(row?.output_tokens ?? '0', 10),
  };
}

async function upsertReconciliation(rec: ReconciliationRecord): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO anthropic_billing_reconciliation
       (group_name, date, internal_cost_usd, anthropic_cost_usd,
        discrepancy_usd, discrepancy_pct,
        internal_input_tokens, internal_output_tokens,
        anthropic_input_tokens, anthropic_output_tokens, token_discrepancy_pct,
        computed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
     ON CONFLICT (group_name, date) DO UPDATE SET
       internal_cost_usd       = EXCLUDED.internal_cost_usd,
       anthropic_cost_usd      = EXCLUDED.anthropic_cost_usd,
       discrepancy_usd         = EXCLUDED.discrepancy_usd,
       discrepancy_pct         = EXCLUDED.discrepancy_pct,
       internal_input_tokens   = EXCLUDED.internal_input_tokens,
       internal_output_tokens  = EXCLUDED.internal_output_tokens,
       anthropic_input_tokens  = EXCLUDED.anthropic_input_tokens,
       anthropic_output_tokens = EXCLUDED.anthropic_output_tokens,
       token_discrepancy_pct   = EXCLUDED.token_discrepancy_pct,
       computed_at             = NOW()`,
    [
      rec.groupName,
      rec.dateStr,
      rec.internal.costUsd,
      rec.anthropicCostUsd,
      rec.discrepancyUsd,
      clampPct(rec.discrepancyPct),
      rec.internal.inputTokens,
      rec.internal.outputTokens,
      rec.anthropicTokens?.inputTokens ?? null,
      rec.anthropicTokens?.outputTokens ?? null,
      clampPct(rec.tokenDiscrepancyPct),
    ],
  );
}

export interface ReconcilerSummary {
  dateStr: string;
  groupsWritten: number;
  groupsFailed: number;
  /** True when Anthropic's side could not be read, so nothing was comparable. */
  vendorSideMissing: boolean;
}

export async function runAnthropicBillingReconciler(): Promise<ReconcilerSummary> {
  const yesterday = new Date();
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const dateStr = yesterday.toISOString().slice(0, 10);

  log.info({ dateStr }, 'anthropic-billing-reconciler: starting');

  const adminKey = process.env.ANTHROPIC_ADMIN_KEY;
  let usageByKey: Map<string, ApiKeyTokenUsage> | null = null;
  let orgCostUsd: number | null = null;
  let groupKeyIds: Map<PurposeGroup, string> = new Map();

  if (!adminKey) {
    // Named precisely: the message keys are present and irrelevant here, so
    // "no API key" would send someone to look at the wrong secret.
    log.warn({},
      'anthropic-billing-reconciler: ANTHROPIC_ADMIN_KEY not set — the usage and cost reports need an organisation admin credential, not a message key');
  } else {
    usageByKey = await fetchUsageByApiKey(dateStr, adminKey);
    orgCostUsd = await fetchOrgCostUsd(dateStr, adminKey);
    groupKeyIds = await resolveGroupKeyIds(adminKey);
  }

  const vendorSideMissing = usageByKey === null && orgCostUsd === null;
  const threshold = getThreshold();
  let groupsWritten = 0;
  let groupsFailed  = 0;

  for (const groupName of Object.keys(PURPOSE_GROUPS) as PurposeGroup[]) {
    try {
      const internal = await queryInternalTotals(groupName, dateStr);

      const keyId = groupKeyIds.get(groupName);
      const anthropicTokens = keyId && usageByKey
        ? usageByKey.get(keyId) ?? { inputTokens: 0, outputTokens: 0 }
        : null;

      let tokenDiscrepancyPct: number | null = null;
      if (anthropicTokens) {
        const vendorTotal   = anthropicTokens.inputTokens + anthropicTokens.outputTokens;
        const internalTotal = internal.inputTokens + internal.outputTokens;
        if (vendorTotal > 0) {
          tokenDiscrepancyPct = Math.abs(internalTotal - vendorTotal) / vendorTotal;
          if (tokenDiscrepancyPct > threshold) {
            log.warn(
              {
                groupName, dateStr, internalTotal, vendorTotal,
                tokenDiscrepancyPct: (tokenDiscrepancyPct * 100).toFixed(2) + '%',
                threshold: (threshold * 100).toFixed(0) + '%',
              },
              'anthropic-billing-reconciler: token discrepancy exceeds threshold',
            );
          }
        }
      }

      const anthropicCostUsd = orgCostUsd ?? -1;
      const discrepancyUsd = 0; // org-wide dollars are not comparable per group
      const discrepancyPct = null;

      await upsertReconciliation({
        groupName, dateStr, internal, anthropicCostUsd, anthropicTokens,
        discrepancyUsd, discrepancyPct, tokenDiscrepancyPct,
      });
      groupsWritten++;

      log.info(
        { groupName, dateStr, internalCostUsd: internal.costUsd, anthropicCostUsd,
          internalTokens: internal.inputTokens + internal.outputTokens,
          vendorTokens: anthropicTokens ? anthropicTokens.inputTokens + anthropicTokens.outputTokens : null },
        'anthropic-billing-reconciler: group reconciled',
      );
    } catch (err) {
      groupsFailed++;
      log.error(
        { groupName, dateStr, error: (err as Error).message },
        'anthropic-billing-reconciler: failed to reconcile group (continuing)',
      );
    }
  }

  const summary: ReconcilerSummary = { dateStr, groupsWritten, groupsFailed, vendorSideMissing };

  // A run that wrote nothing is a failed run and must not read as a completed
  // one. Logging `complete` unconditionally is how this stayed invisible for
  // months while every group threw.
  const summaryFields = { dateStr, groupsWritten, groupsFailed, vendorSideMissing };
  if (groupsWritten === 0) {
    log.error(summaryFields, 'anthropic-billing-reconciler: FAILED — no group was recorded');
  } else if (vendorSideMissing) {
    log.warn(summaryFields, 'anthropic-billing-reconciler: recorded our own side only — Anthropic reports unavailable');
  } else {
    log.info(summaryFields, 'anthropic-billing-reconciler: complete');
  }
  return summary;
}
