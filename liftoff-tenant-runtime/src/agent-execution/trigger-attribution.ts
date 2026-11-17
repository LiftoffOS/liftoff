// Who a run is attributed to, as ONE value.
//
// A run writes several audit rows — `agent_invocation_started` at the top and a
// terminal `agent_execution` at the bottom, on both the success and the
// error-salvage path — and they used to disagree, because the start row computed
// a conforming string while the terminal rows passed the raw four-value enum and
// let the outbox coerce it. `human` and `event` have no conforming bare form, so
// the coercion invented `human:unknown` / `event:unknown`, and that is what the
// Activity page rendered.
//
// Computing it once, here, is what makes the rows agree. Kept out of the
// execution service so it can be table-tested without standing up a pool.

import { conformTriggeredBy } from '../audit/service';

/** The fields of an ExecuteTaskInput that decide attribution. Narrowed to a
 *  structural type so a test does not have to build a whole task input. */
export interface TriggerAttributionInput {
  triggeredBy?: 'human' | 'agent' | 'cron' | 'event';
  /** Runtime agent id of the agent this run belongs to — which, for an
   *  agent-triggered run (self-wake, follow-up, verify continuation, child-task
   *  resume), is also the agent that started it. */
  agentId: string;
  /** Granular source label, e.g. `reactive:<rule>` or `workflow_delay:<id>`. */
  triggeredByLabel?: string;
  /** The triggering human. May be a `slack:<uid>` form, which the `human:` slot
   *  accepts (it is the audit `userId` field that must not carry one). */
  triggeredByUserId?: string;
}

/**
 * Resolve a run's `triggeredBy` into a string the control plane's SE-007 grammar
 * already accepts. Conformed once at the end, so `conformTriggeredBy(result) ===
 * result` holds for every input and the outbox's coercion warning only ever
 * fires for a genuinely new offender.
 */
export function resolveStartTriggeredBy(input: TriggerAttributionInput): string {
  return conformTriggeredBy((() => {
    const tb: 'human' | 'agent' | 'cron' | 'event' = input.triggeredBy || 'cron';
    if (tb === 'cron') return 'cron';
    // Carry WHICH agent. Bare 'agent' gave the control plane nothing to look up,
    // so triggeredByAgentName resolved to null and the Activity row showed no
    // name. The outbox translates this runtime id to the platform's
    // internal_agents.id before it leaves (audit/service.ts).
    if (tb === 'agent') return `agent:${input.agentId}`;
    // Carry the real topic. 'event:scheduled' was hardcoded, so every reactive
    // rule, workflow delay and computed metric reported the same trigger. The
    // label's ':' becomes the '.' hierarchy separator via the conform above.
    if (tb === 'event') return `event:${input.triggeredByLabel || 'scheduled'}`;
    // A human trigger with no human on it is the platform acting on the agent's
    // behalf, not a person. The previous fallback put the AGENT's own uuid in the
    // human: slot, which reads as a user who does not exist.
    return input.triggeredByUserId
      ? `human:${input.triggeredByUserId}`
      : 'system:agent_execution';
  })());
}
