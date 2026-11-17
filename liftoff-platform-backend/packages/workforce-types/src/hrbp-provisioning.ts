// HRBP runs orchestrate the provisioning of a committed workforce plan.
// Each step has an intent row + result row; resume re-calls with the
// same idempotency key (upstreams honor it per Phase 0t).

export type ProvisioningStepKind =
  | 'create_agent_template'
  | 'update_agent_template'
  | 'initiate_oauth_grant'
  | 'attach_connector_credentials'
  | 'emit_completion_event';

export type ProvisioningEventKind =
  | 'step_started'
  | 'step_completed'
  | 'step_failed'
  | 'step_compensated'
  | 'run_completed'
  | 'run_failed'
  | 'waiting_for_oauth'
  | 'resumed_from_oauth';

export interface HrbpProvisioningRun {
  id: string;
  tenantId: string;
  planId: string;
  status:
    | 'pending'
    | 'running'
    | 'waiting_for_oauth'
    | 'compensating'
    | 'completed'
    | 'failed';
  currentStepId: string | null;
  startedAt: Date;
  completedAt: Date | null;
  failureReason: string | null;
}

export interface HrbpProvisioningStep {
  id: string;
  runId: string;
  stepKind: ProvisioningStepKind;
  /** Opaque reference per step kind — e.g., proposed agent name. */
  intentRef: string;
  idempotencyKey: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'compensated';
  /** Resource ID created by this step (agent-template ID, etc.). */
  resultResourceId: string | null;
  attempts: number;
  lastErrorMessage: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

export interface HrbpProvisioningEvent {
  id: string;
  runId: string;
  stepId: string | null;
  eventKind: ProvisioningEventKind;
  payload: unknown;
  occurredAt: Date;
}

export interface CompensationAction {
  stepId: string;
  stepKind: ProvisioningStepKind;
  /** Inverse action applied to roll back the step's side-effect. */
  inverseStep: ProvisioningStepKind;
  resourceId: string;
  executedAt: Date | null;
  success: boolean | null;
  errorMessage: string | null;
}

export interface HrbpCompensationLogEntry {
  id: string;
  runId: string;
  action: CompensationAction;
  createdAt: Date;
}
