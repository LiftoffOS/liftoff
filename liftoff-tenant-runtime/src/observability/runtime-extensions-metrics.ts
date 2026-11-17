// Runtime-extensions metrics surface (parallel delegation + trajectory sink).
//
// Structured-log-based counters + histograms. Cloud Monitoring picks up
// emit sites via log-based metric definitions (see
// docs/dashboards/*.json and docs/alerts/runtime-extensions.yaml for the
// declarations). We avoid the per-emit GCP Monitoring API write path
// because it sustains under bursty agent execution.
//
// Each metric is a top-level export so emit sites can do
//   metrics.delegation_spawn_total.inc({ tenant_id: 't', status: 'ok' });
// and a single structured-log entry fires per call.

import { logger } from '../infrastructure/logging';

type Labels = Record<string, string | number | undefined>;

function emit(metricName: string, kind: 'counter' | 'gauge' | 'histogram', value: number, labels: Labels = {}): void {
  // Drop undefined labels so the structured-log payload stays compact and
  // Cloud Monitoring's log-based metric label-extractor sees only the
  // defined keys.
  const cleanLabels: Record<string, string> = {};
  for (const [k, v] of Object.entries(labels)) {
    if (v !== undefined && v !== null && v !== '') cleanLabels[k] = String(v);
  }
  logger.info({ metric_name: metricName, metric_kind: kind, metric_value: value, ...cleanLabels });
}

function counter(metricName: string) {
  return {
    inc: (labels: Labels = {}, value: number = 1): void => emit(metricName, 'counter', value, labels),
  };
}

function gauge(metricName: string) {
  return {
    set: (value: number, labels: Labels = {}): void => emit(metricName, 'gauge', value, labels),
  };
}

function histogram(metricName: string) {
  return {
    observe: (value: number, labels: Labels = {}): void => emit(metricName, 'histogram', value, labels),
  };
}

// ─── Part 2 ────────────────────────────────────────────────────────────
export const count_tokens_calls_total      = counter('count_tokens_calls_total');
export const count_tokens_latency_ms       = histogram('count_tokens_latency_ms');

// ─── Part 5 ────────────────────────────────────────────────────────────
export const delegation_spawn_total                  = counter('delegation_spawn_total');
export const delegation_child_duration_ms            = histogram('delegation_child_duration_ms');
export const delegation_spawn_paused                 = gauge('delegation_spawn_paused');
export const delegation_cross_tenant_blocked_total   = counter('delegation_cross_tenant_blocked_total');
export const delegation_child_anomaly_total          = counter('delegation_child_anomaly_total');
export const delegation_inflight_at_pause_total      = counter('delegation_inflight_at_pause_total');
export const delegation_soft_throttle_engaged_total  = counter('delegation_soft_throttle_engaged_total');
export const delegation_soft_throttle_backoff_ms     = histogram('delegation_soft_throttle_backoff_ms');
export const delegation_shared_db_utilization        = gauge('delegation_shared_db_utilization');
export const delegation_anthropic_pool_429_rate      = gauge('delegation_anthropic_pool_429_rate');

// ─── Part 6 ────────────────────────────────────────────────────────────
export const trajectory_sink_written_total           = counter('trajectory_sink_written_total');
export const trajectory_sink_skipped_total           = counter('trajectory_sink_skipped_total');
export const trajectory_sink_failed_total            = counter('trajectory_sink_failed_total');
export const trajectory_sink_payload_bytes           = histogram('trajectory_sink_payload_bytes');
export const trajectory_thinking_block_count         = histogram('trajectory_thinking_block_count');
// Informational: a vendor block type we have not classified was seen. Says
// nothing about whether the transcript is still replayable.
export const trajectory_unknown_block_type_total     = counter('trajectory_unknown_block_type_total');
// A BUG, and alertable: content the canonical transcript needs in order to be
// replayed was dropped by a mapper. Split from the counter above, which
// conflated "new vendor block" with "transcript is now wrong" and so could
// never gate a per-engine inverse-mapper rollout.
export const trajectory_unmapped_replay_relevant_total = counter('trajectory_unmapped_replay_relevant_total');
export const trajectory_nested_code_session_total    = counter('trajectory_nested_code_session_total');

// ─── Collab-session emitter ───────────────────────────────────────────────
export const collab_session_emit_failed_total        = counter('collab_session_emit_failed_total');
export const collab_session_emit_abandoned_total     = counter('collab_session_emit_abandoned_total');
export const collab_session_emit_dropped_total       = counter('collab_session_emit_dropped_total');

// ─── Adapter regression guards ──────────────────────────────────────────
export const adapter_invoke_threw_total              = counter('adapter_invoke_threw_total');
export const adapter_anomaly_in_stream_total         = counter('adapter_anomaly_in_stream_total');
export const openai_adapter_missing_usage_event_total = counter('openai_adapter_missing_usage_event_total');
export const workflow_step_usage_not_published_total = counter('workflow_step_usage_not_published_total');

// ─── Part 3 ────────────────────────────────────────────────────────────
export const tenant_config_clamped_total             = counter('tenant_config_clamped_total');

// ─── DAG child executor + async delegation ──────────────────────────────
// Labels flow through .inc({ ... }); counter() (this file) is the canonical
// constructor — there is no prom-client `Counter` in this module.
export const child_task_dispatched_total      = counter('child_task_dispatched_total');
export const child_task_completed_total       = counter('child_task_completed_total');
export const task_graph_completed_total       = counter('task_graph_completed_total');
export const task_graph_timeout_total         = counter('task_graph_timeout_total');
export const delegation_fanout_rejected_total = counter('delegation_fanout_rejected_total');
export const delegation_pause_total           = counter('delegation_pause_total');

// ─── Invocation outcomes (failure taxonomy — migration 308) ──────────────
// Failed runs by failure_class. Grouping by the `failure_class` label in the
// dashboard IS the failure-class distribution (transient_infra vs agent_declined
// vs stalled vs tool_error …) — the aggregate consumer of migration 308. Emitted
// at the error-path completeInvocation and by the stalled-run reconciler.
export const invocation_failed_total          = counter('invocation_failed_total');
export const delegation_resume_total          = counter('delegation_resume_total');

// ─── External-agent tool freshness ───────────────────────────────────────
// A live `tools/list` failed and the run fell back to the stored
// raw_mcp_tools snapshot. Non-zero means some agent may again be seeing tools
// its server no longer exposes — the exact condition that made CoinGecko serve
// 48 phantom tools — so this is the signal that the fallback is load-bearing.
export const external_agent_tool_list_degraded_total = counter('external_agent_tool_list_degraded_total');

// ─── Durable pause/resume telemetry ──────────────────────────
// The engine-sliced reliability of Liftoff's durable suspension/continuation
// protocol. attempt/outcome counters give the denominators the failure counter
// needs; failure carries the classified point of failure; fallback marks a
// certified degraded continuation; duration measures resume-signal → terminal.
// All labels are closed, bounded enums — see pause-resume-telemetry.ts. Emit ONLY
// via that module's helpers so classification + closed labels + the no-double-count
// ownership rule are enforced in one place.
export const agent_pause_total = counter('agent_pause_total');
export const agent_resume_total = counter('agent_resume_total');
export const agent_pause_resume_failure_total = counter('agent_pause_resume_failure_total');
export const agent_resume_fallback_total = counter('agent_resume_fallback_total');
export const agent_resume_duration_ms = histogram('agent_resume_duration_ms');

// ─── Admission + entitlement freshness ───────────────────────────────────
// Every admission denial, labelled by the gate that fired: `reason` carries the
// AdmissionResult.quotaType (operational_status, billing_suspended,
// agent_execution, agent_lifecycle, global_freeze, workflow_type_disabled,
// connector_type_disabled). The deny path emitted nothing at all before this,
// so a wrongly-denied tenant stayed invisible until an agent escalated — four
// months, in the case that motivated it. Grouping by `reason` IS the
// denial-cause distribution.
export const admission_denied_total = counter('admission_denied_total');

// Age of the cached entitlement row at the moment a refresh is triggered. The
// fetch path once wrote nothing for months while logging success; the only
// evidence was a cached row nobody looked at. This makes that a graph rather
// than archaeology.
export const entitlement_cache_age_ms = histogram('entitlement_cache_age_ms');

// ─── Gateway session coverage ────────────────────────────────────────────
// Whether a turn ran with something in front of the vendor's own response.
//
// A session that fails to open is DELIBERATELY not fatal — a control-plane
// problem must not stop a customer's agent — and that is exactly what makes it
// invisible. On the two engines whose own summary cannot be priced, a bypassed
// session is an under-charge on every turn it happens to, and nothing anywhere
// said so: the run succeeds, the tokens are booked from a summary that is short,
// and the difference shows up only in a vendor invoice nobody reconciles by hand.
//
// `fidelity` is the label that matters. `complete` means the engine's own summary
// is priceable and the missing session costs a second witness; `incomplete` means
// the engine cannot report what it spent and the missing session costs money.
// Emit ONLY via `engine-usage-fidelity.ts`, which owns both the label and the
// list of engines that under-report.
export const gateway_session_total = counter('gateway_session_total');
