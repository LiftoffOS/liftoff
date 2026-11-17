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
      triggerConfig: TriggerConfig;
    }
  | {
      agentType: 'workflow';
      summary: string;
      systemPrompt: string;
      userInstructions: string;
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
  | 'llm_unavailable'
  | 'llm_budget_exhausted'
  | 'catalog_fetch_failed'
  | 'rate_limited'
  | 'too_many_integrations'
  | 'prompt_injection_detected'
  | 'unknown';

export interface DistillErrorEvent {
  type: 'error';
  message: string;
  errorCode: DistillErrorCode;
  /** Optional seconds until retry is appropriate (rate-limiting) */
  retryAfter?: number;
}

export type DistillStreamEvent =
  | DistillProgressEvent
  | DistillCompleteEvent
  | DistillErrorEvent;

/** Expected agentType literal values (for runtime validation / grep fencing) */
export const AGENT_TYPE_VALUES: readonly AgentType[] = ['agent', 'workflow'] as const;
