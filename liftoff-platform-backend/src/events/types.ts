// Event Types
// Per Section 4: Control-plane ↔ tenant-runtime contract

// Per Section 4: Every event must include these fields
// Field names use snake_case per event contract specification
//
// Phase 1b: schema_version field added as part of the Pub/Sub envelope
// versioning for the agent taxonomy collapse. Subscribers must tolerate
// receiving events with OR without schema_version (older publishers may
// still be mid-rollout). Unversioned envelopes are treated as version 0;
// versioned envelopes carry schema_version: 1 for all internal_agent.*
// and related events shipped after Phase 1b.
export interface ControlPlaneEvent {
  event_id: string;
  /** Envelope schema version. Optional for backwards compatibility with
   *  pre-Phase-1b publishers. Post-Phase-1c this becomes required. */
  schema_version?: number;
  tenant_id?: string;
  entity_type: string;
  entity_id: string;
  event_type: string;
  entity_version?: number;
  event_version: number;
  occurred_at: string;
  payload?: Record<string, unknown>;
}

// Per Section 4: Control plane publishes these events
export type ControlPlaneEventType =
  // Account events
  | 'account.created'
  | 'account.updated'
  | 'account.deleted'
  // Tenant lifecycle events
  | 'tenant.provisioned'
  | 'tenant.activated'
  | 'tenant.suspended'
  | 'tenant.reactivated'
  // Entitlement events
  | 'tenant.entitlement.updated'
  // Deployment events
  | 'tenant.deployment.created'
  | 'tenant.deployment.approved'
  | 'tenant.deployment.deployed'
  | 'tenant.deployment.rolled_back'
  // Model registry events
  | 'model.registered'
  | 'model.approved'
  | 'model.deprecated'
  | 'model.disabled'
  // Model config events
  | 'tenant.model_config.created'
  | 'tenant.model_config.updated'
  | 'tenant.model_config.deleted'
  // Prompt bundle events
  | 'tenant.prompt_bundle.created'
  | 'tenant.prompt_bundle.updated'
  | 'tenant.prompt_bundle.approved'
  | 'tenant.prompt_bundle.deprecated'
  // Prompt template events
  | 'tenant.prompt_template.created'
  | 'tenant.prompt_template.updated'
  // Feature flag events
  | 'tenant.feature_flag.created'
  | 'tenant.feature_flag.updated'
  | 'tenant.feature_flag.deleted'
  // Subscription events
  | 'subscription.created'
  | 'subscription.canceled'
  | 'subscription.paused'
  | 'subscription.resumed'
  // Invoice events
  | 'invoice.paid'
  | 'invoice.payment_failed'
  // Billing events
  | 'billing.usage_reported'
  | 'refund.processed'
  // Admin/kill switch events
  | 'platform.connector.disabled'
  | 'platform.connector.enabled'
  | 'platform.workflow_type.disabled'
  | 'platform.workflow_type.enabled'
  | 'platform.writes_frozen'
  | 'platform.writes_unfrozen'
  // Migration events
  | 'tenant.migration.started'
  | 'tenant.migration.completed'
  // Compliance events
  | 'compliance.residency_policy_created'
  | 'compliance.residency_policy_updated'
  | 'compliance.residency_violation'
  | 'compliance.transfer_requested'
  | 'compliance.transfer_approved'
  | 'compliance.evidence_collected'
  | 'compliance.evidence_collection_failed'
  // Notification events
  | 'notification.rollout'
  // Internal Agent events
  | 'tenant.internal_agent.created'
  | 'tenant.internal_agent.updated'
  | 'tenant.internal_agent.deleted'
  | 'tenant.internal_agent.status_changed'
  | 'tenant.internal_agent.runtime_config_updated'
  // Internal Agent chat lifecycle events
  | 'tenant.internal_agent.chat_started'
  | 'tenant.internal_agent.chat_feedback_received'
  | 'tenant.internal_agent.redist_recommended'
  // Oversight events
  | 'tenant.oversight.updated'
  // Correction events
  | 'correction.requested'
  | 'correction.bulk_requested'
  // Workforce Plan events (Phase 4 HRBP Agent subscribes to these)
  | 'workforce_plan.created'
  | 'workforce_plan.submitted'
  | 'workforce_plan.approved'
  | 'workforce_plan.rejected'
  | 'workforce_plan.reopened'
  | 'workforce_plan.provisioning_started'
  | 'workforce_plan.provisioning_progress'
  | 'workforce_plan.completed'
  | 'workforce_plan.failed'
  // Workflow engine events
  | 'workflow.run.started'
  | 'workflow.run.completed'
  | 'workflow.run.failed'
  | 'workflow.step.dispatched'
  | 'workflow.step.completed'
  | 'workflow.step.failed'
  // Cross-service human-action audit bridge — producers (liftoff-connector-service,
  // liftoff-billing) publish a single envelope type and embed the workspace-facing
  // event_type inside the AuditPlatformEventPayload.
  | 'audit.platform_event';

// Cross-service audit envelope. Producers in liftoff-connector-service and
// liftoff-billing wrap each human-initiated mutation as an `audit.platform_event`
// envelope onto the shared control-plane topic; platform-backend's subscriber
// arm forwards these into `audit_log` so they show up in the unified workspace
// audit feed.
export interface AuditPlatformEventPayload {
  tenantId: string;
  userId: string | null;          // null only for system/cron events (filtered out)
  eventType: string;              // e.g. 'connector.connected', 'billing.payment_method_updated'
  resourceType: string;
  resourceId: string;
  action: string;
  previousState?: Record<string, unknown> | null;
  newState?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
  occurredAt: string;
  traceId?: string;
}

// Input interface uses camelCase for TypeScript convention
// but converts to snake_case when publishing
export interface PublishEventInput {
  entityType: string;
  entityId: string;
  eventType: string;
  /** null omits entity_version from the wire event, bypassing the coordinator's
   *  version gate. Use only for backfill republish where the stored version may
   *  be ahead of the event being replayed. */
  entityVersion: number | null;
  eventVersion: number;
  /** Phase 1b: envelope schema version. Defaults to 1 when publishing
   *  internal_agent.* events. Subscribers tolerate unversioned envelopes
   *  for backwards compatibility with pre-Phase-1b publishers. */
  schemaVersion?: number;
  /** Explicit null is allowed and lands in control_plane_outbox.tenant_id as
   *  NULL. Required for cross-tenant events (account.*, model.approved, …) and
   *  for tenant.deleted (the tenants row is gone by the time the outbox row
   *  inserts; a non-null FK would violate). */
  tenantId?: string | null;
  payload?: Record<string, unknown>;
}

// Migration event payload schemas
export interface MigrationStartedPayload {
  source_version?: string;
  target_version?: string;
  initiated_by?: string;
}

export interface MigrationCompletedPayload {
  source_version?: string;
  target_version?: string;
  duration_ms?: number;
  records_migrated?: number;
}

export interface PromptBundleUpdatedPayload {
  name: string;
  version: number;
  templates?: string[];
}
