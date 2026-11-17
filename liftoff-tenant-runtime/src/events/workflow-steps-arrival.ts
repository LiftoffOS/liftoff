// What to persist when a runtime-config event carries workflow steps.
//
// THE DEFECT THIS CLOSES. A payload that carries `workflowStepsHash` but not the
// steps it hashes leaves the subscriber writing the hash to
// `agents.workflow_steps_hash` while `loadRuntimeConfig` reads the steps from
// `agents.workflow_steps` — a column nothing else writes. The steps are then
// always undefined, the hybrid loop's `workflowSteps?.length` branch never
// fires, and every agent the distiller designed with a deterministic backbone
// runs the conversational path instead. The distiller is told to emit steps
// whenever the responsibilities carry a numbered workflow section, "no
// exceptions", so the steps exist upstream; they must cross the boundary.
//
// `verifyWorkflowStepsHash` is inert in the same situation — it short-circuits
// to ok when there are no steps, so the tamper check it exists to perform never
// runs. Once steps arrive, that check becomes real, which is why the
// hash is verified HERE too: a mismatch caught at arrival never reaches the
// database, so no run can be started from steps we already know are wrong.
//
// FAIL CLOSED. A mismatch persists nothing rather than persisting unverified
// steps. The agent keeps running the conversational path, which is exactly what
// it does without steps, instead of executing a sequence whose integrity we
// cannot vouch for. Degrading to that behaviour is always available; executing
// the wrong steps is not reversible.

import { createHash } from 'crypto';
import type { WorkflowStep } from '../agent-execution/types';

/** What the subscriber should write for `agents.workflow_steps`. */
export type WorkflowStepsArrival =
  /** Write these steps. */
  | { action: 'set'; steps: WorkflowStep[] }
  /** Write NULL — the control plane has no steps for this agent any more. */
  | { action: 'clear' }
  /** Write nothing, keep whatever is stored. */
  | { action: 'leave'; reason: 'absent' | 'hash_mismatch'; detail?: string };

/**
 * Canonical hash of a step array.
 *
 * Byte-identical to the control plane's `computeWorkflowStepsHash` and to
 * `agent-execution/service.ts`'s: JSON with object keys sorted at every level,
 * sha256, hex. All three must agree or a correct payload is rejected as tampered,
 * so this is deliberately the same six lines rather than a cleverer equivalent.
 */
export function computeWorkflowStepsHash(steps: WorkflowStep[]): string {
  const canonical = JSON.stringify(steps, (_key: string, value: unknown) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(value as Record<string, unknown>).sort()) {
        sorted[k] = (value as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return value;
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export function decideWorkflowStepsArrival(payload: {
  workflowSteps?: WorkflowStep[] | null;
  workflowStepsHash?: string;
}): WorkflowStepsArrival {
  // Absent is not the same as empty, and the difference matters during a
  // rollout. A publisher that predates this field sends nothing, and clearing
  // on that would wipe steps every time an older instance published. An
  // explicit null is the control plane saying the agent HAS no steps, which
  // must clear, or a removed workflow would keep executing forever.
  if (payload.workflowSteps === undefined) {
    return { action: 'leave', reason: 'absent' };
  }
  if (payload.workflowSteps === null || payload.workflowSteps.length === 0) {
    return { action: 'clear' };
  }

  // No hash is a legitimate state, not a failure: the control plane pins the
  // hash in `pinWorkflowIntegrity` on review, so steps can exist before anyone
  // has reviewed them. Unverified steps are accepted here and remain unverified
  // at execution, where `verifyWorkflowStepsHash` also short-circuits without a
  // hash. That is one decision, made in one place, not two that could drift.
  if (!payload.workflowStepsHash) {
    return { action: 'set', steps: payload.workflowSteps };
  }

  const computed = computeWorkflowStepsHash(payload.workflowSteps);
  if (computed !== payload.workflowStepsHash) {
    return {
      action: 'leave',
      reason: 'hash_mismatch',
      detail: `expected ${payload.workflowStepsHash.slice(0, 12)}, computed ${computed.slice(0, 12)}`,
    };
  }
  return { action: 'set', steps: payload.workflowSteps };
}
