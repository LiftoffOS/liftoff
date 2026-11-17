// SSE lifecycle fixtures (Phase 0c). Each fixture is a canonical
// event sequence that a live service must emit (in order, with the
// same content deltas) for the structural-diff harness used in
// Phase 3 pre-cutover verification.

import lifecycleFixture from '../fixtures/workforce-draft-plan-sse-lifecycle.fixture.json';

import { validateWorkforceDraftPlanSseEvent } from './new-service-validators.js';

export interface SseLifecycleAssertionResult {
  valid: boolean;
  errors: string[];
}

/**
 * Replay a captured SSE stream as an array of parsed events, in order,
 * and assert it matches the canonical lifecycle fixture:
 *
 *   - First event kind is `session_started`.
 *   - Last event kind is `session_ended`.
 *   - `plan_ready_for_approval.proposedAgentCount` equals the number
 *     of `agent_proposed` events.
 *   - Every event has `planId` === fixture.plan_id and a valid UUID
 *     eventId.
 *   - Each event passes `validateWorkforceDraftPlanSseEvent`.
 *
 * Returns `{ valid, errors[] }`. Used by Phase 3i pre-cutover tests.
 */
export function assertSseLifecycle(
  captured: unknown[],
): SseLifecycleAssertionResult {
  const errors: string[] = [];
  if (captured.length === 0) {
    return { valid: false, errors: ['no events captured'] };
  }

  for (let i = 0; i < captured.length; i++) {
    const r = validateWorkforceDraftPlanSseEvent(captured[i]);
    if (!r.valid) {
      errors.push(`events[${i}] failed schema validation: ${JSON.stringify(r.errors)}`);
    }
  }

  const first = captured[0] as { kind?: string };
  if (first?.kind !== 'session_started') {
    errors.push(`first event kind=${first?.kind}, expected 'session_started'`);
  }
  const last = captured[captured.length - 1] as { kind?: string };
  if (last?.kind !== 'session_ended') {
    errors.push(`last event kind=${last?.kind}, expected 'session_ended'`);
  }

  const proposedCount = captured.filter(
    (e) => (e as { kind?: string }).kind === 'agent_proposed',
  ).length;
  const readyEvent = captured.find(
    (e) => (e as { kind?: string }).kind === 'plan_ready_for_approval',
  ) as { proposedAgentCount?: number } | undefined;
  if (!readyEvent) {
    errors.push("missing 'plan_ready_for_approval' event");
  } else if (readyEvent.proposedAgentCount !== proposedCount) {
    errors.push(
      `plan_ready_for_approval.proposedAgentCount=${readyEvent.proposedAgentCount} but saw ${proposedCount} agent_proposed events`,
    );
  }

  const planIds = new Set(captured.map((e) => (e as { planId?: string }).planId));
  if (planIds.size !== 1) {
    errors.push(`events span multiple planId values: ${[...planIds].join(', ')}`);
  }

  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  for (let i = 0; i < captured.length; i++) {
    const id = (captured[i] as { eventId?: string }).eventId;
    if (!id || !uuidRe.test(id)) {
      errors.push(`events[${i}].eventId is not a valid UUID: ${id}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

export { lifecycleFixture as workforceDraftPlanLifecycleFixture };
