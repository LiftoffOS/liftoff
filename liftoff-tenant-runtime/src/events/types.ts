// Event Types
// Per Section 4: Control-plane ↔ tenant-runtime contract

// Per Section 4: Every event must include these fields
// Field names use snake_case per event contract specification
// Note: tenant_id is optional for account-level events, required for tenant events
export interface ControlPlaneEvent {
  event_id: string;
  tenant_id?: string;  // Optional at interface level; tenant events always include it
  entity_type: string;
  entity_id: string;
  event_type: ControlPlaneEventType;
  entity_version: number;
  event_version: number;
  occurred_at: string;
  payload?: Record<string, unknown>;
}

// Helper type for events that require tenant_id
export interface TenantScopedEvent extends ControlPlaneEvent {
  tenant_id: string;
}

// Per Section 4: Events received from control plane
export type ControlPlaneEventType =
  // Workspace registration. These create the `tenants` row that every
  // tenant-scoped foreign key in this database points at, so they precede
  // everything else a workspace can do here.
  | 'tenant.provisioned'
  | 'tenant.activated'
  | 'tenant.entitlement.updated'
  | 'tenant.suspended'
  | 'tenant.reactivated'
  | 'tenant.deployment.approved'
  | 'tenant.model_config.created'
  | 'tenant.model_config.updated'
  // Platform-wide, not tenant-scoped: which vendor powers Liftoff's own
  // assistants, team-shaping, background and safety work. Carries no
  // payload — the snapshot is the source, this only says 'read it again'.
  | 'platform.vendor_policy.updated'
  | 'tenant.model_config.deleted'
  | 'tenant.prompt_bundle.created'
  | 'tenant.prompt_bundle.updated'
  | 'tenant.prompt_bundle.approved'
  | 'tenant.prompt_bundle.deprecated'
  | 'tenant.feature_flag.created'
  | 'tenant.feature_flag.updated'
  | 'tenant.feature_flag.deleted'
  | 'tenant.deleted'
  | 'tenant.migration.started'
  | 'tenant.migration.completed'
  | 'connector.credentials_stored' // Credential metadata event (tokens stored directly in Secret Manager by control plane)
  | 'connector.deleted' // Connector deleted by connector-service — alias for connector.disconnected
  | 'connector.disconnected' // Connector disconnected by user — disable manifest, revoke credentials, mark connector disconnected
  | 'connector.composio_trigger_fired' // Composio webhook delivery — PB receives + verifies HMAC, republishes here; per-slug dispatch in handleComposioTriggerFired
  // A vendor webhook a connector received on its OWN endpoint (GitHub App
  // pull_request/issues, Slack Events API). The `connector-events-${env}`
  // connector-service can publish to is a different topic from the one this
  // runtime subscribes to, so a delivery reaches an agent only through here.
  // Producer: liftoff-connector-service src/events/connector-webhook-event.ts.
  | 'connector.webhook_event_received'
  // A record a connector POLLED, on the same journey and for the same reason as
  // the webhook event above: the poller's own `connector-events-${env}` publish
  // reaches harvest-service and stops, so a polled record wakes an agent only
  // through here. Producer: liftoff-connector-service
  // src/events/connector-record-synced.ts.
  | 'connector.record_synced'
  | 'tenant.oversight.updated' // Per implementation plan Phase 1.5
  // Internal Agent events (support both old ai_team and new internal_agent names)
  | 'tenant.ai_team.created'
  | 'tenant.ai_team.updated'
  | 'tenant.ai_team.deleted'
  | 'tenant.ai_team.status_changed'
  | 'tenant.ai_team.runtime_config_updated'
  | 'tenant.internal_agent.created'
  | 'tenant.internal_agent.updated'
  | 'tenant.internal_agent.deleted'
  | 'tenant.internal_agent.status_changed'
  | 'tenant.internal_agent.runtime_config_updated'
  | 'tenant.internal_agent.skills_backfilled'
  | 'tenant.internal_agent.skills_updated'
  | 'external_agent.created' // External agent A2A events
  | 'external_agent.updated'
  | 'external_agent.rediscovered'
  | 'external_agent.deleted'
  | 'external_agent.credentials_stored'
  | 'external_agent.health_failed' // Health check failure notification (EA-001)
  // Custom event sources (per-agent inbound webhooks). One event per matched
  // trigger rule; payload carries the resolved agentId + sanitized envelope.
  | 'event.custom_received';
