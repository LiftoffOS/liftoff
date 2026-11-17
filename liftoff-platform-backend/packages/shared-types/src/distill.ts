/**
 * Canonical distill types. DistillOutput is a discriminated union —
 * when agentType is 'workflow', workflowSteps is required; when 'agent',
 * workflowSteps is absent. This is the shape-level defense that prevents
 * malformed agentType/workflowSteps combinations.
 */

import type { AgentType, TriggerConfig } from './agent.js';
import type { WorkflowStep } from './workflow.js';

/** Stages the distill stream router emits via SSE `progress` events. */
export type DistillStage =
  | 'connected'
  | 'validating'
  | 'analyzing'
  | 'fetching_tools'
  | 'generating'
  | 'finalizing';

/**
 * Discriminated DistillOutput. The shape itself prevents malformed
 * combinations — workflowSteps is required iff agentType === 'workflow'
 * and absent otherwise.
 */
export type DistillOutput =
  | {
      agentType: 'agent';
      summary: string;
      systemPrompt: string;
      userInstructions: string;
      instructionsMd: string;
      triggerConfig: TriggerConfig;
    }
  | {
      agentType: 'workflow';
      summary: string;
      systemPrompt: string;
      userInstructions: string;
      instructionsMd: string;
      triggerConfig: TriggerConfig;
      workflowSteps: WorkflowStep[];
    };

/**
 * Runtime type guard for downstream consumers that need to narrow
 * the discriminated union without relying on TS inference alone.
 */
export function isWorkflowDistillOutput(
  output: DistillOutput,
): output is Extract<DistillOutput, { agentType: 'workflow' }> {
  return output.agentType === 'workflow';
}

/**
 * SSE envelope event types. distill-stream-router.ts emits these via
 * named SSE events. Frontend parses into a discriminated union and
 * runtime-validates via zod.
 */
export interface DistillProgressEvent {
  type: 'progress';
  stage: DistillStage;
}

export type DistillCompleteEvent = {
  type: 'complete';
  distillSessionId: string;
} & DistillOutput;

/**
 * Enumerated error codes for the SSE `error` event. The frontend uses
 * `errorCode` for telemetry / routing; `message` is surfaced to the user.
 */
export type DistillErrorCode =
  | 'validation_failed'
  | 'semantic_validation_failed'
  | 'structural_validation_failed'
  /** The workflow graph was still rejected on the last attempt and the hire
   *  cannot ship without one (a scheduled trigger, or a template obligation
   *  the fences check on the graph). Carries the rejection types. */
  | 'graph_not_converged'
  | 'llm_unavailable'
  | 'llm_budget_exhausted'
  | 'catalog_fetch_failed'
  | 'rate_limited'
  | 'too_many_integrations'
  | 'prompt_injection_detected'
  | 'unknown';

/**
 * Shape emitted with `structural_validation_failed` so the frontend can
 * render rule-specific guidance (e.g. "your responsibilities reference a
 * deal field that no bound connector publishes") instead of a generic
 * "distillation failed". Mirrors the analyzer's AnalyzerViolation type.
 */
export interface DistillStructuralViolation {
  rule:
    | 'case_c_mixed_primitives'
    | 'reactive_predicate_undeclared_field'
    | 'companion_predicate_undeclared_field'
    | 'schedule_followup_on_anchored_field'
    | 'manual_trigger_with_reactive_responsibilities'
    | 'cron_trigger_with_event_topic_available'
    | 'soft_directive_uncheckable'
    // A routine that would pause, disable, or delete the team member that
    // runs it. Kept in step with the analyzer's AnalyzerRule union.
    | 'self_disabling_routine'
    // A routine marked as needing no model, with no command to run instead.
    | 'no_agent_without_script'
    // The caller stated an exact cadence and the derived trigger set does not
    // contain it (derive-then-verify).
    | 'expected_cadence_missing'
    // The caller stated a STOPPED cadence and the derived trigger set still
    // contains it (the inverse check).
    | 'stopped_cadence_present';
  severity: 'reject' | 'warn';
  message: string;
  detail?: Record<string, unknown>;
}

export interface DistillErrorEvent {
  type: 'error';
  message: string;
  errorCode: DistillErrorCode;
  /** Optional seconds until retry is appropriate (rate-limiting) */
  retryAfter?: number;
  /** Present iff errorCode === 'structural_validation_failed'. */
  violations?: DistillStructuralViolation[];
}

export type DistillStreamEvent =
  | DistillProgressEvent
  | DistillCompleteEvent
  | DistillErrorEvent;

/** Expected agentType literal values (for runtime validation / grep fencing) */
export const AGENT_TYPE_VALUES: readonly AgentType[] = ['agent', 'workflow'] as const;
