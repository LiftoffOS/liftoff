// Why a trigger did not become a run.
//
// Between an event arriving and an agent executing there are a dozen places a
// trigger can be dropped, and every one of them was a `logger.info` with a
// hand-written English sentence and no counter. So "the agent stopped reacting
// to GitHub" had no answer short of reading logs one by one, and the two skips
// that mean something is WRONG (an agent paused mid-schedule, a filter that
// matches nothing) were indistinguishable from the ten that mean the system is
// working exactly as intended.
//
// A closed union plus one counter fixes both: the reasons are enumerable, and
// their rates are comparable.

import { incCounter } from '../memory/metrics';

/** Which dispatch path dropped it. Coarse on purpose — the reason carries the
 *  detail, and crossing two high-cardinality axes is how a metric becomes
 *  unqueryable. */
export type TriggerKind = 'connector_event' | 'cloud_task';

export type SkipReason =
  // ── Pre-fan-out (connector events) ─────────────────────────────────────────
  /** The same connector event was already processed. Normal: vendors re-deliver. */
  | 'duplicate_event'
  /** Nobody is registered for this topic. Normal: we subscribe broadly. */
  | 'no_registered_agents'
  // ── Per-agent (connector events) ───────────────────────────────────────────
  /** The agent was paused/archived after the in-memory registry was built. */
  | 'agent_not_active'
  /** A Gmail event for a draft this agent itself produced. Dropping it is what
   *  stops the draft → trigger → draft loop. */
  | 'gmail_self_draft'
  /** The agent's configured gmailQuery did not match. */
  | 'gmail_query_no_match'
  /** The Outlook equivalent of gmail_self_draft. */
  | 'outlook_self_draft'
  /** The agent's configured outlookFilter did not match. */
  | 'outlook_filter_no_match'
  /** repo / branch / author / draft / action narrowing rejected the PR event. */
  | 'github_filter_no_match'
  /** An issue event that is not new work (edited, closed, labeled). */
  | 'github_issue_action_not_actionable'
  // ── Cloud Tasks delivery ───────────────────────────────────────────────────
  /** Another delivery holds the per-agent advisory lock. */
  | 'concurrent_execution'
  /** Local lifecycle disagreed with the control plane and was healed. */
  | 'lifecycle_drift_healed'
  /** The agent is not ACTIVE at delivery time. */
  | 'agent_lifecycle_not_active'
  /** The run-level idempotency ledger says this trigger is already in flight. */
  | 'duplicate_delivery_in_flight';

/**
 * Count a trigger that did not become a run.
 *
 * Labels are deliberately ONLY (trigger_kind, reason). incCounter keys its
 * in-process accumulator on the label set (keyFor), so a tenant_id or agent_id
 * label would grow that map without bound for the life of the process — a
 * memory leak on top of the cardinality problem. Both ids stay on the log line
 * next to the call, where they are exactly as findable and cost nothing.
 */
export function recordTriggerSkip(triggerKind: TriggerKind, reason: SkipReason): void {
  incCounter('agent_trigger_skipped_total', { trigger_kind: triggerKind, reason });
}
