export type WorkforceEventType =
  | 'workforce.plan.created'
  | 'workforce.plan.committed'
  | 'workforce.plan.provisioning_started'
  | 'workforce.plan.completed'
  | 'workforce.plan.failed'
  | 'workforce.capability_token.consumed'
  | 'workforce.capability_token.revoked';

export interface WorkforceEventEnvelope<TPayload = unknown> {
  eventId: string;
  eventType: WorkforceEventType;
  schemaVersion: number;
  tenantId: string;
  occurredAt: Date;
  sourceService: 'liftoff-workforce-service';
  traceId: string;
  payload: TPayload;
}

export interface PlanCommittedPayload {
  planId: string;
  approverUserId: string;
  proposedAgentCount: number;
}

export interface PlanCompletedPayload {
  planId: string;
  provisionedAgentTemplateIds: string[];
  durationMs: number;
}

export interface PlanFailedPayload {
  planId: string;
  failureReason: string;
  failedStepKind: string | null;
  compensationApplied: boolean;
}
