// What each metric is allowed to be sliced by.
//
// `incCounter` keys its process-local accumulator on the full label set, so a
// label with one value per tenant, agent or invocation does not merely make the
// metric unqueryable — it grows an in-memory Map without bound for the life of
// the process. Both problems have the same fix and the same shape: declare the
// labels up front, and refuse to boot if the declaration is wrong.
//
// The assert is deliberately at STARTUP rather than at emit time. A metric with
// a bad label is a mistake made once, in source, by someone who will not see a
// runtime warning buried in a log; failing the boot puts it in front of them
// while they still have the change in hand.

import { RESOLVED_PROVIDERS } from '../agent-execution/adapter/types';

export const FORBIDDEN_METRIC_LABELS: ReadonlySet<string> = new Set([
  'tenant_id',
  'agent_id',
  'invocation_id',
  'thread_id',
  'session_id',
  // Included because they are the same mistake wearing different names.
  'user_id',
  'account_id',
  'trigger_key',
  'task_id',
  'workflow_id',
]);

/** `__name` duplicates the metric name into the log line for the Cloud Logging
 *  extractor. Allowed on every metric; it adds no cardinality. */
const UNIVERSAL_LABELS: ReadonlySet<string> = new Set(['__name']);

/** Placeholder for a label value outside its declared set. Bounds cardinality at
 *  the emit site instead of hoping every caller stays disciplined. */
export const OTHER_LABEL_VALUE = 'other';

interface MetricLabelSpec {
  /** Label keys this metric may carry. Anything else is dropped. */
  labels: readonly string[];
  /** Optional closed value set per label. A value outside it becomes 'other'.
   *  Omit for a label whose values are already bounded by something external —
   *  a model id comes from the rate table, a provider from the adapter list. */
  values?: Readonly<Record<string, readonly string[]>>;
}

export const METRIC_LABELS: Readonly<Record<string, MetricLabelSpec>> = {
  // ── Trigger dispatch ───────────────────────────────────────────────────────
  agent_trigger_skipped_total: {
    labels: ['trigger_kind', 'reason'],
    values: {
      trigger_kind: ['connector_event', 'cloud_task'],
      reason: [
        'duplicate_event', 'no_registered_agents', 'agent_not_active',
        'gmail_self_draft', 'gmail_query_no_match',
        'outlook_self_draft', 'outlook_filter_no_match',
        'github_filter_no_match', 'github_issue_action_not_actionable',
        'concurrent_execution', 'lifecycle_drift_healed',
        'agent_lifecycle_not_active', 'duplicate_delivery_in_flight',
      ],
    },
  },
  // Tenant and agent are on the log line beside each call, which is where
  // anyone chasing a single instance looks anyway.
  event_execution_dropped_total: { labels: [] },
  event_execution_defer_payload_too_large_total: { labels: [] },
  event_execution_defer_enqueue_failed_total: { labels: [] },
  event_execution_deferred_total: { labels: [] },

  // ── Attribution coverage ───────────────────────────────────────────────────
  // The precision split is the point: a derived owner and a real one must not be
  // counted as the same quality of fact.
  invocation_attribution_total: {
    labels: ['attribution_source', 'precision'],
    values: {
      // Exactly the AttributionSource union — a value the resolver cannot
      // produce would be a series that is structurally always zero, which reads
      // as "we attribute nothing that way" rather than "that way does not exist".
      attribution_source: ['direct_human', 'delegation', 'unattributed'],
      precision: ['precise', 'degraded'],
    },
  },

  // ── Chat delivery ──────────────────────────────────────────────────────────
  chat_delivery_rule_violation_total: {
    labels: ['rule'],
    values: { rule: ['file_url', 'workspace_path'] },
  },

  // ── Cost ───────────────────────────────────────────────────────────────────
  // provider is the adapter list; model is the rate table. Both bounded, both
  // needed to identify WHICH entry is missing.
  llm_unpriced_tokens_total: { labels: ['provider', 'model'] },
  // A nested code_session that reported NO usage at all. Distinct from unpriced
  // tokens, which are tokens we know about and cannot rate: this is spend we
  // cannot even see. Non-zero means a vendor stopped reporting usage (or never
  // did on that path), and the invocation's cost is understated by whatever the
  // coding agent burned. Bounded labels: 4 providers x 3 exit reasons.
  code_session_unmetered_total: {
    labels: ['provider', 'exit_reason'],
    values: {
      provider: [...RESOLVED_PROVIDERS],
      exit_reason: ['success', 'timeout', 'error'],
    },
  },

  // ── Memory ─────────────────────────────────────────────────────────────────
  memory_l1_summaries_written_total: { labels: [] },
  memory_l0_superseded_by_summary_total: { labels: [] },
  memory_retrieval_by_source: {
    labels: ['source'],
    values: { source: ['conversation', 'semantic', 'peer-learning'] },
  },
  memory_summary_group_size: {
    labels: ['tier'],
    values: { tier: ['l0', 'l1', 'l2'] },
  },
  influence_score: {
    // The MemoryLayer union (src/memory/types.ts), which is also the CHECK on
    // memories.layer.
    labels: ['layer'],
    values: { layer: ['global', 'role', 'individual', 'conversation'] },
  },

  // Lag between a memory qualifying for graduation and actually graduating.
  // Emitted per tenant per tick, which is exactly why tenant_id cannot ride on
  // it: the extractor would carry one series per tenant forever.
  graduation_lag_seconds: {
    labels: ['layer'],
    values: { layer: ['global', 'role', 'individual', 'conversation'] },
  },

  // ── Embedding ──────────────────────────────────────────────────────────────
  embedding_cache_hit_total: { labels: ['model'] },
  embedding_cache_miss_total: { labels: ['model'] },
};

/**
 * Refuse to boot on a declaration that would leak cardinality.
 *
 * Throws rather than logs: a process that starts with a per-tenant label starts
 * leaking immediately, and by the time anyone reads the warning the Map is
 * already large and the metric already useless.
 */
export function assertMetricLabelDiscipline(): void {
  const problems: string[] = [];
  for (const [metric, spec] of Object.entries(METRIC_LABELS)) {
    for (const label of spec.labels) {
      if (FORBIDDEN_METRIC_LABELS.has(label)) {
        problems.push(`${metric} declares forbidden high-cardinality label '${label}'`);
      }
    }
    for (const label of Object.keys(spec.values ?? {})) {
      if (!spec.labels.includes(label)) {
        problems.push(`${metric} declares values for '${label}', which is not one of its labels`);
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `Metric label discipline violated (see src/memory/metric-labels.ts):\n  ${problems.join('\n  ')}`,
    );
  }
}

/**
 * Reduce a caller's labels to the declared set, normalising any value outside a
 * declared set to 'other'.
 *
 * An UNDECLARED metric passes through untouched. Registering every metric is the
 * goal, but silently zeroing the labels of one somebody forgot to declare would
 * lose data with no signal — and the startup assert cannot see a metric that
 * exists only at a call site.
 */
export function normalizeMetricLabels(
  name: string,
  labels: Record<string, string | number>,
): Record<string, string | number> {
  const spec = METRIC_LABELS[name];
  if (!spec) return labels;
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(labels)) {
    if (UNIVERSAL_LABELS.has(key)) { out[key] = value; continue; }
    if (!spec.labels.includes(key)) continue;
    const allowed = spec.values?.[key];
    out[key] = allowed && !allowed.includes(String(value)) ? OTHER_LABEL_VALUE : value;
  }
  return out;
}
