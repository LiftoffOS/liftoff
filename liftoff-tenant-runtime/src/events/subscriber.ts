// Event Subscriber
// Per Section 4: Tenant runtime receives events from control plane.
//
// Phase 5 (push migration): control-plane events are now delivered via Pub/Sub
// PUSH subscriptions, not streaming pull. Pub/Sub HTTPs each message to the
// coordinator's POST /internal/pubsub/:topic endpoint (see ./push-handler).
// The HTTP handler decodes the envelope and calls dispatchEvent() below.
//
// dispatchEvent is the single dispatch entry point; it schema-validates the
// raw event, enforces version + stale-after-delete gates, runs the per-event
// switch, and updates event_versions. Error classification (DlqRoutedError,
// EntityBusyError, about-to-DLQ logging) lives here so the push handler can
// stay HTTP-shaped (just translates exceptions to status codes).

import { v4 as uuidv4 } from 'uuid';
import { ControlPlaneEvent, TenantScopedEvent } from './types';
import { EventProcessor, DlqRoutedError, EntityBusyError } from './event-processor';
import { getPoolForService } from '../infrastructure/database';
import { logger } from '../infrastructure/logging';
import { setTraceContext } from '../infrastructure/safe-trace-context';
import { resolveTerminalState, THREAD_STATUS_BY_TERMINAL } from '../agent-execution/terminal-state';
import { invalidateFlagsCache } from '../integrations/web-fetch/limits-config';
import { EntitlementsRepository } from '../entitlements-client/repository';
import { decideWorkflowStepsArrival } from './workflow-steps-arrival';
import type { WorkflowStep } from '../agent-execution/types';
import type { TenantOperationalStatus } from '../entitlements-client/types';
import { internalAgentInstructionService, type Skill } from '../instruction-compiler/internal-agent-instruction-service';
import { AgentLifecycleService } from '../agent-lifecycle/service';
import { getManagedSecret } from '../infrastructure/secret-store';

const agentLifecycleService = new AgentLifecycleService();

// Dedicated pool for event subscriber — isolated from the scheduled execution
// path so message processing can never starve agent execution of connections.
// Exported so other modules in the events/ directory (event-status-router,
// push-handler classification) can query event_processing_ledger / dlq_messages
// without instantiating a second pool.
export const subscriberPool = getPoolForService('event-subscriber');

// EventProcessor for multi-step handlers
const eventProcessor = new EventProcessor(subscriberPool);

// The cached_entitlements writer. Both refresh paths (this subscriber's event
// handler and the entitlements client's TTL fetch) go through it so the column
// set is defined once and the two cannot drift.
const entitlementsRepository = new EntitlementsRepository();

// RFC-4122 UUID format used to gate the dlq_messages.tenant_id column (UUID
// NOT NULL). Mirrors the regex in src/infrastructure/repository-validation.ts.
// Exported for reuse by push-handler.ts (DLQ insert tenant_id guard).
export const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Schema validation for incoming events — no external dependencies.
//
// Validates envelope structure only. Does NOT require event_type to be in a
// hardcoded allowlist — platform-backend publishes 80+ event types through the
// single control-plane-events topic and evolves faster than this subscriber.
// Unknown event_types fall through to the switch's default case (warn + ack)
// rather than being routed to DLQ. The tradeoff: a typo'd event_type is logged
// as a warning instead of a hard error, but infra-noise from every new PB event
// type is eliminated.
export function validateEventSchema(data: unknown): ControlPlaneEvent {
  if (!data || typeof data !== 'object') throw new Error('Event must be an object');
  const obj = data as Record<string, unknown>;
  // Generate event_id if missing (legacy events from platform backend may omit it)
  if (!obj.event_id) {
    obj.event_id = uuidv4();
  }
  if (typeof obj.event_id !== 'string') throw new Error('Invalid event_id');
  if (typeof obj.entity_type !== 'string' || !obj.entity_type) throw new Error('Missing entity_type');
  if (typeof obj.entity_id !== 'string' || !obj.entity_id) throw new Error('Missing entity_id');
  if (typeof obj.event_type !== 'string' || !obj.event_type) throw new Error('Missing event_type');
  // entity_version is optional — connector events may omit it
  if (obj.entity_version !== undefined && typeof obj.entity_version !== 'number') {
    throw new Error('Invalid entity_version');
  }
  // tenant_id required for tenant-scoped events.
  //
  // Feature-flag events (`tenant.feature_flag.created|updated|deleted`) are
  // an explicit exception: feature_flags is a GLOBAL control-plane table.
  // PB's FeatureFlagService publishes those events without a tenant_id (per
  // src/feature-flags/service.ts), and the runtime's handler intentionally
  // splits processing into (a) a global sentinel-row update keyed by the
  // flag key — which always runs from event.payload — and (b) an optional
  // per-tenant fetch — which only runs when event.tenant_id is set (for
  // tenant_override changes, future-state). Requiring tenant_id on every
  // tenant.* event DLQ's the global flag mutations before they can update
  // the sentinel row that drives global vendor flags + similar settings.
  const isTenantScoped = typeof obj.event_type === 'string' &&
    !obj.event_type.startsWith('tenant.feature_flag.') &&
    (obj.event_type.startsWith('tenant.') || obj.event_type.startsWith('connector.') ||
     obj.event_type.startsWith('external_agent.'));
  if (isTenantScoped && (typeof obj.tenant_id !== 'string' || !obj.tenant_id)) {
    throw new Error('Missing tenant_id for tenant-scoped event');
  }
  if (obj.tenant_id !== undefined && typeof obj.tenant_id !== 'string') {
    throw new Error('Invalid tenant_id');
  }
  return data as ControlPlaneEvent;
}

// Authenticated fetch to control plane — fails fast when token missing
const CONTROL_PLANE_API = process.env.CONTROL_PLANE_API_URL || 'http://localhost:3000';

async function fetchFromControlPlane(path: string): Promise<Response> {
  const serviceToken = getManagedSecret('TENANT_RUNTIME_SERVICE_TOKEN');
  if (!serviceToken) {
    throw new Error('TENANT_RUNTIME_SERVICE_TOKEN not configured');
  }
  return fetch(`${CONTROL_PLANE_API}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      'X-Service-Auth': serviceToken,
    },
  });
}

// API Response types for type safety. Mirrors the platform-backend
// /api/entitlements/tenant/:id JSON shape. Phase 2: capacity caps removed,
// only credit-related fields survive.
interface EntitlementResponse {
  tenantOperationalStatus: string;
  agentExecutionAllowed: boolean;
  /** Control plane's billing_controls.suspended, LEFT JOINed onto the served
   *  snapshot. Optional: the control plane deploys ahead of the runtime, so a
   *  response without it is expected during the rollout window. */
  billingSuspended?: boolean;
  remainingIncludedCredits: number;
  overageAllowed: boolean;
  includedMonthlyCredits?: number;
  overageCeiling?: number;
}

interface PromptBundleResponse {
  artifactRef: string;
  version: number;
  status: string;
  name: string;
  templates: unknown[];
  approvedAt: string;
}

interface ModelConfigResponse {
  id: string;
  tenantId: string;
  modelId: string;
  version: number;
  /** Both fields are OPTIONAL, and that is the contract rather than laxness.
   *  The control plane no longer materialises a resolved model id into a
   *  policy — a policy states the provider and the tier, and the model is
   *  resolved from the registry at call time — so a current policy carries
   *  neither field. They stay in the type because a policy written before that
   *  change still has them and is still honoured. Typed as required, this
   *  interface would have made the removal a compile error in the wrong repo. */
  routingPolicy: { defaultModel?: string; taskOverrides?: Record<string, string> };
}

interface DeploymentResponse {
  artifactRef: string;
  version: number;
  status: string;
  approvedAt: Date;
}

// Per Section 4: Event types the tenant runtime receives.
//
// Names here match the Pub/Sub topic short names in
// YOUR_GCP_PROJECT. Each has a paired push subscription in
// tenant-runtime-template/pubsub_push.tf that targets the coordinator's
// POST /internal/pubsub/:topic endpoint.
export const SUBSCRIBED_EVENTS = [
  'tenant-entitlement-updated',
  'tenant-suspended',
  'tenant-reactivated',
  'tenant-deployment-approved',
  'tenant-model-config-updated',
  'tenant-prompt-bundle-updated',
  'tenant-feature-flag-updated',
  // tenant.deleted does NOT need a dedicated topic/subscription — every
  // control-plane event publishes to the shared 'control-plane-events' topic
  // (see liftoff-platform-backend/src/events/publisher.ts line 202). The
  // dispatchEvent switch routes by event_type attribute. Adding an entry here
  // would create a dead /internal/pubsub/tenant-deleted route with no Pub/Sub
  // subscription pushing to it.
  'control-plane-events', // Includes connector.credentials_stored events, oversight, internal_agent runtime config, tenant.deleted
] as const;

// MUST match `max_delivery_attempts = 10` in the dead_letter_policy terraform
// block (agent_creation_resilience.tf + pubsub_push.tf). If you change one,
// change the other.
export const MAX_DELIVERY_ATTEMPTS = 10;

// Test seam: dispatchEvent calls subscriberInternals.handleEvent for the
// post-validation pipeline (version gate + stale-after-delete + per-event
// switch + event_versions write). Tests that want to assert dispatchEvent's
// catch-block classification (DlqRouted ack, EntityBusy info-log, about-to-DLQ
// warn, ordinary retry) in isolation swap this field with a stub that throws
// the chosen error type.
//
// Field name preserved from the pre-push-migration code so existing test
// patterns continue to read familiarly; the parameter type changed from
// Message to ControlPlaneEvent because dispatchEvent now does the schema-
// validation outside this seam.
export const subscriberInternals = {
  handleEvent: (event: ControlPlaneEvent): Promise<void> =>
    processValidatedEvent(event),
};

// Single dispatch entry point invoked by the push handler.
//
// Inputs:
//   rawEvent          — the JSON-parsed event body extracted from the Pub/Sub
//                       push envelope (already base64-decoded by the caller).
//   deliveryAttempt   — Pub/Sub's deliveryAttempt for this redelivery (1 on
//                       first attempt; supplied by Pub/Sub when the
//                       subscription has dead_letter_policy configured).
//   subscriptionName  — the push subscription that delivered this message;
//                       included in every log line for triage.
//
// Outcomes:
//   - resolves          → push handler returns 204 (Pub/Sub acks).
//   - throws DlqRouted  → push handler returns 204 (event preserved in
//                         dlq_messages; further redelivery is pointless).
//   - throws EntityBusy → push handler returns 500 (Pub/Sub redelivers after
//                         ack_deadline; expected backpressure, logged at info).
//   - throws other      → push handler returns 500 (Pub/Sub redelivers; the
//                         "about to DLQ" warning is logged here at attempt N-1
//                         and N so operators can triage before the DLQ-nonzero
//                         alert fires).
export async function dispatchEvent(
  rawEvent: unknown,
  deliveryAttempt: number,
  subscriptionName: string,
): Promise<void> {
  // Schema validation — rejects malformed events early, routes to DLQ.
  const raw: Record<string, unknown> =
    rawEvent && typeof rawEvent === 'object'
      ? (rawEvent as Record<string, unknown>)
      : {};
  let event: ControlPlaneEvent;
  try {
    event = validateEventSchema(rawEvent);
  } catch (validationError) {
    logger.error('Invalid event schema, routing to DLQ', {
      subscription: subscriptionName,
      error: (validationError as Error).message,
      raw_keys: Object.keys(raw),
    });
    // dlq_messages.tenant_id is UUID NOT NULL. Schema-invalid events often
    // arrive with malformed/missing tenant_id (it's one of the things
    // validateEventSchema rejects), so coerce non-UUID values to the
    // all-zeros sentinel and prepend the original value to `error` for
    // forensics. Without this, the INSERT throws a Postgres DatabaseError
    // before the DlqRoutedError below — push-handler then 500s and Pub/Sub
    // redelivers a permanently-bad payload forever.
    const rawTenantId = typeof raw.tenant_id === 'string' ? raw.tenant_id : '';
    const tenantIdForDlq = UUID_REGEX.test(rawTenantId)
      ? rawTenantId
      : '00000000-0000-0000-0000-000000000000';
    const errMsgForDlq = UUID_REGEX.test(rawTenantId)
      ? (validationError as Error).message
      : `[malformed tenant_id=${rawTenantId || '<missing>'}] ${(validationError as Error).message}`;
    try {
      await subscriberPool.query(
        // failure_class 'permanent': the event failed schema validation, so no
        // number of redeliveries changes the outcome. The producer or the
        // schema has to change before a replay means anything.
        `INSERT INTO dlq_messages (id, original_topic, original_message_id, tenant_id, payload, error,
          delivery_attempt, max_delivery_attempts, first_received_at, failed_at, status, failure_class)
         VALUES ($1, $2, $3, $4, $5, $6, 1, 1, NOW(), NOW(), 'pending', 'permanent')
         ON CONFLICT (id) DO NOTHING`,
        [
          uuidv4(),
          (raw.event_type as string) || 'unknown',
          (raw.event_id as string) || uuidv4(),
          tenantIdForDlq,
          JSON.stringify(rawEvent),
          errMsgForDlq,
        ],
      );
    } catch (dlqInsertErr) {
      // DLQ row write failed (column constraint, pool exhausted, etc.).
      // Still throw DlqRoutedError so push-handler returns 204 — Pub/Sub
      // redelivering a permanently-bad payload is worse than losing the
      // forensic row, and we already emitted the error log above.
      logger.error('DLQ insert failed for schema-invalid event; acking anyway', {
        subscription: subscriptionName,
        event_id: (raw.event_id as string) || 'unknown',
        dlq_error: (dlqInsertErr as Error).message,
      });
    }
    throw new DlqRoutedError((raw.event_id as string) || 'unknown');
  }

  // WS-1.2 — bind the validated tenant_id to the logging trace context for
  // every downstream log emission. Without this, every "Permanent processing
  // error; DLQ + ack" line in the push handler's catch block would report
  // tenant_id='unknown' for failures that happened after schema validation.
  if (event.tenant_id) {
    setTraceContext({ tenantId: event.tenant_id });
  }

  try {
    await subscriberInternals.handleEvent(event);
  } catch (error) {
    // Use name-based classification (with `instanceof` as a safety belt) so
    // the dispatch pipeline still routes correctly when the same module is
    // loaded under two paths at runtime — `instanceof` then returns false
    // even for a "real" DlqRoutedError. The .name field is set in the class
    // constructor and is stable across copies.
    const errName = (error as { name?: string } | null)?.name;
    if (errName === 'DlqRoutedError' || error instanceof DlqRoutedError) {
      // Event preserved in DLQ table by the validator path above; the push
      // handler will translate this to 204 so Pub/Sub stops redelivering.
      throw error;
    }
    if (errName === 'EntityBusyError' || error instanceof EntityBusyError) {
      // Another event for the same entity is in flight. Logged at info, not
      // error, because this is expected backpressure for fast-arriving event
      // pairs. Push handler returns 500 → Pub/Sub redelivers after ack_deadline.
      const busyErr = error as { eventId?: string; entityId?: string };
      logger.info('Event deferred (entity busy), nacking for redelivery', {
        subscription: subscriptionName,
        event_id: busyErr.eventId,
        entity_id: busyErr.entityId,
      });
      throw error;
    }
    // Loud "about to be DLQ-routed" warning (plan §2.3). At attempt N-1 (and
    // at N for safety), log with full event context so operators can triage
    // before the DLQ-nonzero alert fires.
    if (deliveryAttempt >= MAX_DELIVERY_ATTEMPTS - 1) {
      logger.error('Event about to be DLQ-routed (last attempt before max_delivery_attempts)', {
        subscription: subscriptionName,
        attempt: deliveryAttempt,
        max_delivery_attempts: MAX_DELIVERY_ATTEMPTS,
        event_id: event.event_id,
        event_type: event.event_type,
        entity_type: event.entity_type,
        entity_id: event.entity_id,
        tenant_id: event.tenant_id,
        error_message: (error as Error).message,
      });
    } else {
      logger.error('Event handling failed, nacking for retry', {
        subscription: subscriptionName,
        attempt: deliveryAttempt,
        error_message: (error as Error).message,
      });
    }
    throw error;
  }
}

// Post-validation event pipeline: version gate, stale-after-delete gate,
// handler dispatch, then event_versions write. Extracted so dispatchEvent's
// catch block sits on a single inner call (and so tests can swap it via
// subscriberInternals.handleEvent).
async function processValidatedEvent(event: ControlPlaneEvent): Promise<void> {
  logger.info('Received control plane event', {
    event_id: event.event_id,
    event_type: event.event_type,
    entity_id: event.entity_id,
    entity_version: event.entity_version,
  });

  // Version gating: discard events whose entity_version has been superseded
  // by a later version that already completed. Previously multi-step handlers
  // bypassed this, relying on the EventProcessor ledger's version guard.
  // But the ledger guard has a race window: when both an activation (v74) and
  // a pause (v75) event are in-flight, the activation can be reclaimed from
  // 'failed' before the pause has completed, slipping past the ledger guard
  // and re-activating the agent. Applying checkVersion() to ALL event types
  // closes this gap: once pause (v75) completes and stores version=75,
  // redelivery of activation (v74) is rejected immediately (74 not > 75).
  if (event.entity_version != null) {
    const shouldProcess = await checkVersion(event);
    if (!shouldProcess) {
      logger.info('Discarding stale event', {
        event_id: event.event_id,
        event_type: event.event_type,
        entity_version: event.entity_version,
      });
      // A superseded event is settled — acknowledge it so the platform's
      // outbox-ack reconciler stops republishing it (see recordProcessedInLedger).
      await recordProcessedInLedger(event);
      return;
    }
  }

  // Plan §7.5: once an internal_agent is tombstoned, never resurrect it. A
  // stale `created`/`updated`/`status_changed` event arriving after a `deleted`
  // (e.g. the reconciler republishes `deleted` while a much-older `created`
  // is still on the Pub/Sub redelivery queue) must be a no-op. checkVersion
  // above protects against version regressions, but a `deleted` event may
  // carry entity_version=null (synthetic orphan-cleanup) or the create may
  // legitimately have a higher version than the eventual delete — neither case
  // is handled by the version gate. The cached_status='deleted' check is.
  if (
    (event.event_type === 'tenant.internal_agent.created' ||
      event.event_type === 'tenant.internal_agent.updated' ||
      event.event_type === 'tenant.internal_agent.status_changed' ||
      event.event_type === 'tenant.internal_agent.runtime_config_updated' ||
      event.event_type === 'tenant.internal_agent.skills_updated' ||
      event.event_type === 'tenant.ai_team.created' ||
      event.event_type === 'tenant.ai_team.updated' ||
      event.event_type === 'tenant.ai_team.status_changed') &&
    event.tenant_id &&
    event.entity_id
  ) {
    const cia = await subscriberPool.query(
      `SELECT status FROM cached_internal_agents
       WHERE tenant_id = $1 AND internal_agent_id = $2 LIMIT 1`,
      [event.tenant_id, event.entity_id],
    );
    if (cia.rows[0]?.status === 'deleted') {
      logger.info('Ignoring create/update/status_changed event for already-deleted agent', {
        event_id: event.event_id,
        event_type: event.event_type,
        entity_id: event.entity_id,
        tenant_id: event.tenant_id,
      });
      // Tombstoned target — the event is settled; acknowledge so the
      // reconciler stops republishing it.
      await recordProcessedInLedger(event);
      return;
    }
  }

  switch (event.event_type) {
    // Registering the tenant must precede every other handler's writes:
    // threads, invocations and their siblings all carry a foreign key to
    // tenants(id), so until this row exists the workspace cannot hold a
    // conversation at all.
    case 'tenant.provisioned':
    case 'tenant.activated':
      await handleTenantRegistered(event);
      break;
    case 'tenant.entitlement.updated':
      await handleEntitlementUpdated(event);
      break;
    case 'tenant.suspended':
      await handleTenantSuspended(event);
      break;
    case 'tenant.reactivated':
      await handleTenantReactivated(event);
      break;
    case 'tenant.deployment.approved':
      await handleDeploymentApproved(event);
      break;
    case 'tenant.model_config.updated':
    case 'tenant.model_config.created':
    case 'tenant.model_config.deleted':
      await handleModelConfigUpdated(event);
      break;
    // PLATFORM-WIDE, so it carries no tenant and touches no tenant's cache.
    // It says only "the platform vendor levers moved, read the snapshot again".
    // Re-reading the whole snapshot rather than trusting a payload is the same
    // choice the other overlays make: the endpoint is the source, and an event
    // that carried the values could be applied out of order.
    //
    // This is what makes a lever FAST. The backstop poll is 60s; without this
    // the two planes could route the same purpose to different vendors for that
    // long after an admin flipped it.
    case 'platform.vendor_policy.updated':
      await handlePlatformVendorPolicyUpdated();
      break;
    case 'tenant.prompt_bundle.approved':
    case 'tenant.prompt_bundle.created':
    case 'tenant.prompt_bundle.updated':
    case 'tenant.prompt_bundle.deprecated':
      await handlePromptBundleUpdated(event);
      break;
    case 'tenant.feature_flag.created':
    case 'tenant.feature_flag.updated':
    case 'tenant.feature_flag.deleted':
      await handleFeatureFlagUpdated(event);
      break;
    case 'tenant.deleted':
      await handleTenantDeletedStub(event);
      break;
    case 'tenant.migration.started':
      await handleMigrationStarted(event);
      break;
    case 'tenant.migration.completed':
      await handleMigrationCompleted(event);
      break;
    case 'connector.credentials_stored':
      await handleCredentialsStored(event);
      break;
    case 'connector.composio_trigger_fired':
      await handleComposioTriggerFired(event);
      break;
    case 'connector.webhook_event_received':
      await handleConnectorWebhookEventReceived(event);
      break;
    case 'connector.record_synced':
      await handleConnectorRecordSynced(event);
      break;
    case 'connector.deleted':
    case 'connector.disconnected':
      await handleConnectorDisconnected(event);
      break;
    // Per implementation plan: Phase 1.5 Event Subscription
    case 'tenant.oversight.updated':
      await handleOversightUpdated(event);
      break;
    case 'tenant.ai_team.runtime_config_updated':
    case 'tenant.internal_agent.runtime_config_updated':
      await handleInternalAgentRuntimeConfigUpdated(event);
      break;
    // Internal Agent lifecycle events (support both old ai_team and new internal_agent names)
    case 'tenant.ai_team.created':
    case 'tenant.internal_agent.created':
      await handleInternalAgentCreated(event);
      break;
    case 'tenant.ai_team.updated':
    case 'tenant.internal_agent.updated':
      await handleInternalAgentUpdated(event);
      break;
    case 'tenant.ai_team.deleted':
    case 'tenant.internal_agent.deleted':
      await handleInternalAgentDeleted(event);
      break;
    case 'tenant.ai_team.status_changed':
    case 'tenant.internal_agent.status_changed':
      await handleInternalAgentStatusChanged(event);
      break;
    // External agent events
    case 'external_agent.created':
    case 'external_agent.updated':
    case 'external_agent.rediscovered':
      await handleExternalAgentUpdated(event);
      break;
    case 'external_agent.deleted':
      await handleExternalAgentDeleted(event);
      break;
    case 'external_agent.credentials_stored':
      await handleExternalAgentCredentialsStored(event);
      break;
    case 'external_agent.health_failed':
      await handleExternalAgentHealthFailed(event);
      break;
    case 'tenant.internal_agent.skills_updated':
      await handleInternalAgentSkillsUpdated(event as TenantScopedEvent);
      break;
    // Custom event sources — inbound webhooks routed through control-plane outbox.
    // See: liftoff-platform-backend/src/event-sources/.
    case 'event.custom_received':
      await handleCustomEventReceived(event);
      break;
    default:
      // An event type nobody wired reaches here. Two very different things
      // land in this branch and they must not be treated alike.
      //
      // Control-plane bookkeeping the runtime has no stake in (an account
      // renamed, an audit row written) is genuinely finished the moment it
      // arrives, and recording it completed is correct.
      //
      // A tenant.* event nobody implemented is a HOLE, and recording it
      // completed hides it: were tenant.provisioned unhandled, every new
      // workspace would be acknowledged as fully provisioned while its
      // `tenants` row — the row every threads/invocations foreign key points
      // at — was never created, and the first person to open chat would get a
      // foreign key violation and an agent that never replied. Marking the gap
      // `failed` puts it in front of the platform's outbox reconciler, which
      // republishes for 24h and then reports it stuck, instead of certifying
      // it healthy.
      if (IGNORED_EVENT_TYPES.has(event.event_type)) {
        logger.info('Event type deliberately not handled by the runtime', {
          event_type: event.event_type,
        });
        break;
      }
      logger.error('Unhandled event type — no handler is wired for it', {
        event_type: event.event_type,
        event_id: event.event_id,
        tenant_id: event.tenant_id,
      });
      // Returning here deliberately skips updateProcessedVersion. Advancing the
      // stored version for an event that was never applied would make the
      // version guard above discard the republish as stale, so the moment a
      // handler shipped it could never catch up. That is not hypothetical:
      // tenant.provisioned advanced the version to 1, and tenant.activated —
      // same entity, same version — was then discarded as stale before it ever
      // reached this switch.
      await recordUnhandledInLedger(event);
      return;
  }

  // Update the entity version after successful processing
  // Only store version if the event has one (some events don't)
  if (event.entity_version != null) {
    await updateProcessedVersion(event);
  }

  await recordProcessedInLedger(event);
}

// Control-plane events the runtime deliberately does not act on. They are
// bookkeeping that concerns the platform only, so arriving IS the whole of the
// runtime's obligation and `completed` is the honest status.
//
// Membership here is a decision, not a default. Anything absent from both this
// set and the switch above is reported as a hole rather than silently accepted
// — see the `default:` branch for why that distinction matters.
const IGNORED_EVENT_TYPES = new Set<string>([
  'account.created',
  'account.updated',
  'audit.platform_event',
  'data.retention.cleanup_completed',
]);

// ADR-018 acknowledgment chokepoint. Most events in the switch above are
// handled inline without the EventProcessor, so nothing wrote
// event_processing_ledger — and the platform's outbox-ack reconciler read
// every successfully-processed event as status='unknown', republishing it
// every 5 minutes until it aged out of the 24-hour window. Recording a
// completed row here closes the acknowledgment loop for every inline
// handler, present and future. ON CONFLICT DO NOTHING so rows owned by the
// EventProcessor (which track richer step/attempt state) are never
// overwritten.
async function recordProcessedInLedger(event: ControlPlaneEvent): Promise<void> {
  const tenantId = event.tenant_id;
  // event_processing_ledger PK requires a tenant scope; non-tenant events
  // are outside the reconciler's scan (it filters tenant_id IS NOT NULL).
  if (!tenantId || !UUID_REGEX.test(tenantId)) return;
  try {
    await subscriberPool.query(
      `INSERT INTO event_processing_ledger
         (tenant_id, event_id, event_type, entity_type, entity_id, entity_version, status, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'completed', NOW())
       ON CONFLICT (tenant_id, event_id) DO NOTHING`,
      [tenantId, event.event_id, event.event_type, event.entity_type, event.entity_id, event.entity_version ?? null],
    );
  } catch (err) {
    // Acknowledgment is best-effort: a ledger write failure must not fail a
    // successfully-processed event. Worst case the reconciler republishes and
    // the handlers' own idempotency absorbs the redelivery.
    logger.warn('ledger acknowledgment write failed (non-fatal)', {
      event_id: event.event_id,
      err: (err as Error).message,
    });
  }
}

// Record an event that reached the runtime with no handler behind it.
//
// `failed`, deliberately: the platform's outbox reconciler asks this ledger
// whether an event was processed, republishes anything not processed for 24
// hours and then reports it stuck. That is exactly the treatment a missing
// handler deserves — it self-heals the moment one ships, and stays visible
// until then. Recording `completed` here is what let tenant.provisioned go
// unimplemented for five months while every check reported green.
async function recordUnhandledInLedger(event: ControlPlaneEvent): Promise<void> {
  const tenantId = event.tenant_id;
  if (!tenantId || !UUID_REGEX.test(tenantId)) return;
  try {
    await subscriberPool.query(
      `INSERT INTO event_processing_ledger
         (tenant_id, event_id, event_type, entity_type, entity_id, entity_version, status, error)
       VALUES ($1, $2, $3, $4, $5, $6, 'failed', $7)
       ON CONFLICT (tenant_id, event_id) DO NOTHING`,
      [tenantId, event.event_id, event.event_type, event.entity_type, event.entity_id,
       event.entity_version ?? null,
       `no handler wired for event type ${event.event_type}`],
    );
  } catch (err) {
    logger.warn('ledger unhandled-write failed (non-fatal)', {
      event_id: event.event_id,
      err: (err as Error).message,
    });
  }
}

// Per Section 4: The runtime stores the latest applied entity_version
// and discards stale events. This is the mechanism that protects from
// out-of-order or redelivered Pub/Sub messages.
async function checkVersion(event: ControlPlaneEvent): Promise<boolean> {
  const tenantId = event.tenant_id;
  if (!tenantId) return true; // Non-tenant events always process

  const result = await subscriberPool.query(
    `SELECT entity_version FROM event_versions
     WHERE tenant_id = $1 AND entity_type = $2 AND entity_id = $3`,
    [tenantId, event.entity_type, event.entity_id]
  );

  if (result.rows.length === 0) {
    // First event for this entity
    return true;
  }

  const storedVersion = result.rows[0].entity_version;
  return event.entity_version > storedVersion;
}

async function updateProcessedVersion(event: ControlPlaneEvent): Promise<void> {
  const tenantId = event.tenant_id;
  if (!tenantId) return;

  await subscriberPool.query(
    `INSERT INTO event_versions (tenant_id, entity_type, entity_id, entity_version, processed_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (tenant_id, entity_type, entity_id) DO UPDATE
     SET entity_version = EXCLUDED.entity_version, processed_at = NOW()
     WHERE event_versions.entity_version < EXCLUDED.entity_version`,
    [tenantId, event.entity_type, event.entity_id, event.entity_version]
  );
}

// Register the workspace in the runtime's own database.
//
// Every tenant-scoped table here (threads, invocations, and the rest) carries
// `tenant_id UUID REFERENCES tenants(id)`, so this row is the precondition for
// the runtime doing anything at all for a workspace. Without this handler,
// tenant.provisioned matches no case and is recorded as completed, so a
// workspace looks provisioned from every angle until someone opens chat and
// the invocation INSERT hits invocations_tenant_id_fkey.
//
// external_id is UNIQUE NOT NULL and nothing in the runtime reads it, so the
// tenant's own id is used: unique by construction, and it cannot collide with
// a row seeded any other way.
//
// Idempotent, and safe on either event: both tenant.provisioned and
// tenant.activated route here, and a redelivery of either is a no-op.
async function handleTenantRegistered(event: ControlPlaneEvent): Promise<void> {
  const tenantId = event.tenant_id;
  if (!tenantId) {
    logger.error('tenant registration event carried no tenant_id', {
      event_id: event.event_id,
      event_type: event.event_type,
    });
    return;
  }

  const result = await subscriberPool.query(
    `INSERT INTO tenants (id, external_id)
     VALUES ($1, $2)
     ON CONFLICT (id) DO NOTHING`,
    [tenantId, tenantId],
  );

  logger.info('Tenant registered in runtime', {
    tenant_id: tenantId,
    event_type: event.event_type,
    created: (result.rowCount ?? 0) > 0,
  });
}

async function handleEntitlementUpdated(event: ControlPlaneEvent): Promise<void> {
  const tenantId = event.tenant_id!;

  // Fetch full entitlement from control plane
  const response = await fetchFromControlPlane(`/api/internal/entitlements/tenant/${tenantId}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch entitlement: ${response.status}`);
  }

  const entitlement = await response.json() as EntitlementResponse;

  // Through the repository's EVENT variant, not hand-rolled SQL.
  //
  // Two things were wrong with the inline statement this replaces. It carried
  // no version guard at all, so a redelivered or out-of-order event overwrote a
  // newer snapshot; and it listed its own column set, which meant every column
  // added to cached_entitlements (billing_suspended, most recently) had to be
  // remembered in two places and silently went stale here when it was not.
  // Both write paths now share one statement body — see
  // entitlements-client/repository.ts — and differ only in the ordering guard
  // that belongs on this one.
  await entitlementsRepository.upsertEntitlementFromEvent({
    tenantId,
    operationalStatus: entitlement.tenantOperationalStatus as TenantOperationalStatus,
    agentExecutionAllowed: entitlement.agentExecutionAllowed,
    // Absent while the control plane is mid-rollout; absent means "no billing
    // suspension known", never "suspended".
    billingSuspended: entitlement.billingSuspended ?? false,
    remainingIncludedCredits: entitlement.remainingIncludedCredits,
    overageAllowed: entitlement.overageAllowed,
    includedMonthlyCredits: entitlement.includedMonthlyCredits ?? 1000,
    overageCeiling: entitlement.overageCeiling ?? 0,
    entityVersion: event.entity_version,
    updatedAt: new Date(),
  });

  logger.info('Updated cached entitlement', { tenant_id: tenantId, entity_version: event.entity_version });
}

async function handleTenantSuspended(event: ControlPlaneEvent): Promise<void> {
  const tenantId = event.tenant_id!;

  // Update local status to suspended, stop new work.
  //
  // entity_version is deliberately NOT written here. This is a `tenant`-entity
  // event and its entity_version belongs to the tenant, not the entitlement —
  // the control plane publishes a constant 1 on it. Stamping that onto the
  // cached ENTITLEMENT row would reset the entitlement's version counter and
  // corrupt the ordering guard on handleEntitlementUpdated, which is the one
  // thing that keeps a stale entitlement event from clobbering a newer one.
  // The columns below are a direct forced override; ordering does not apply.
  await subscriberPool.query(
    `UPDATE cached_entitlements
     SET operational_status = 'suspended',
         agent_execution_allowed = false,
         updated_at = NOW()
     WHERE tenant_id = $1`,
    [tenantId]
  );

  // Cancel any pending tasks
  await subscriberPool.query(
    `UPDATE workflow_tasks
     SET status = 'canceled', updated_at = NOW()
     WHERE tenant_id = $1 AND status IN ('pending', 'queued')`,
    [tenantId]
  );

  // Mark active workflows as suspended
  await subscriberPool.query(
    `UPDATE workflows
     SET status = 'suspended', updated_at = NOW()
     WHERE tenant_id = $1 AND status = 'running'`,
    [tenantId]
  );

  logger.info('Tenant suspended, stopped all work', { tenantId });
}

async function handleTenantReactivated(event: ControlPlaneEvent): Promise<void> {
  const tenantId = event.tenant_id!;

  // Update local status to active, allow new work. entity_version is not
  // written here for the same reason as handleTenantSuspended: it is the
  // TENANT's version (a constant 1 on the wire), and writing it would reset the
  // entitlement row's ordering counter.
  await subscriberPool.query(
    `UPDATE cached_entitlements
     SET operational_status = 'active',
         agent_execution_allowed = true,
         updated_at = NOW()
     WHERE tenant_id = $1`,
    [tenantId]
  );

  // Resume suspended workflows
  await subscriberPool.query(
    `UPDATE workflows
     SET status = 'running', updated_at = NOW()
     WHERE tenant_id = $1 AND status = 'suspended'`,
    [tenantId]
  );

  logger.info('Tenant reactivated, resumed work', { tenantId });
}

async function handleDeploymentApproved(event: ControlPlaneEvent): Promise<void> {
  const tenantId = event.tenant_id!;
  const deploymentId = event.entity_id;

  // Fetch deployment details from control plane
  const response = await fetchFromControlPlane(`/api/internal/deployments/${deploymentId}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch deployment: ${response.status}`);
  }

  const deployment = await response.json() as DeploymentResponse;

  // Update local cache with new deployment
  await subscriberPool.query(
    `INSERT INTO cached_deployments (tenant_id, deployment_id, artifact_ref, version,
      status, approved_at, entity_version, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
     ON CONFLICT (tenant_id, deployment_id) DO UPDATE SET
       artifact_ref = EXCLUDED.artifact_ref,
       version = EXCLUDED.version,
       status = EXCLUDED.status,
       approved_at = EXCLUDED.approved_at,
       entity_version = EXCLUDED.entity_version,
       updated_at = NOW()`,
    [
      tenantId,
      deploymentId,
      deployment.artifactRef,
      deployment.version,
      deployment.status,
      deployment.approvedAt,
      event.entity_version,
    ]
  );

  logger.info('Cached approved deployment', { tenant_id: tenantId, deployment_id: deploymentId, version: deployment.version });
}

/** The platform vendor levers moved. Re-read the registry snapshot.
 *
 *  NOT fail-open-silently: a refresh that throws leaves the last-known policy
 *  installed, which is the previous vendor rather than no vendor, and the
 *  backstop poll will try again within a minute. So the worst case of a lost or
 *  failed refresh is a lever that takes up to a minute, never a call with
 *  nowhere to go.
 *
 *  Deliberately takes no event argument: the payload says nothing this needs.
 *  The snapshot is the source. */
export async function handlePlatformVendorPolicyUpdated(): Promise<void> {
  const { refreshModelRegistry } = await import('../llm/model-registry-loader');
  try {
    const counts = await refreshModelRegistry();
    logger.info({ ...counts }, 'platform vendor policy refreshed from a push');
  } catch (err) {
    logger.warn(
      { err: (err as Error).message },
      'platform vendor policy push refresh failed; the last-known policy stands and the poll will retry',
    );
  }
}

export async function handleModelConfigUpdated(event: ControlPlaneEvent): Promise<void> {
  const tenantId = event.tenant_id!;

  const response = await fetchFromControlPlane(`/api/internal/model-registry/tenant/${tenantId}/configs`);
  if (!response.ok) {
    throw new Error(`Failed to fetch model configs: ${response.status}`);
  }

  const configs = await response.json() as ModelConfigResponse[];

  // Replace cached configs for this tenant
  await subscriberPool.query(`DELETE FROM cached_model_configs WHERE tenant_id = $1`, [tenantId]);

  for (const config of configs) {
    await subscriberPool.query(
      `INSERT INTO cached_model_configs (id, tenant_id, model_id, routing_policy, version, entity_version)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [config.id, tenantId, config.modelId, JSON.stringify(config.routingPolicy), config.version, event.entity_version]
    );
  }

  logger.info('Updated cached model configs', { tenant_id: tenantId, config_count: configs.length });
}

async function handlePromptBundleUpdated(event: ControlPlaneEvent): Promise<void> {
  const tenantId = event.tenant_id!;
  const bundleId = event.entity_id;

  // Fetch bundle details from control plane
  const response = await fetchFromControlPlane(`/api/internal/prompt-registry/bundles/${bundleId}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch prompt bundle: ${response.status}`);
  }

  const bundle = await response.json() as PromptBundleResponse;

  // Update local cache
  await subscriberPool.query(
    `INSERT INTO cached_prompt_bundles (tenant_id, bundle_id, name, version, status,
      templates, approved_at, entity_version, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
     ON CONFLICT (tenant_id, bundle_id) DO UPDATE SET
       name = EXCLUDED.name,
       version = EXCLUDED.version,
       status = EXCLUDED.status,
       templates = EXCLUDED.templates,
       approved_at = EXCLUDED.approved_at,
       entity_version = EXCLUDED.entity_version,
       updated_at = NOW()`,
    [
      tenantId,
      bundleId,
      bundle.name,
      bundle.version,
      bundle.status,
      JSON.stringify(bundle.templates),
      bundle.approvedAt,
      event.entity_version,
    ]
  );

  logger.info('Updated cached prompt bundle', { tenant_id: tenantId, bundle_id: bundleId, status: bundle.status });
}

// Phase 7 §7.2: scrubs vendor sessions/identities/profiles for the deleted tenant.
async function handleTenantDeletedStub(event: ControlPlaneEvent): Promise<void> {
  const tenantId = event.tenant_id!;
  const { anchorClient } = await import('../tools/standard-tool-handler');

  const sessions = await subscriberPool.query(
    `SELECT id, vendor, vendor_session_id FROM web_sessions
     WHERE tenant_id = $1 AND closed_at IS NULL`,
    [tenantId],
  );
  const { closeSession: closeVendorSession } = await import('../browser-sessions/session-vendor-proxy');
  for (const s of sessions.rows) {
    try {
      // Tenant-deletion scope — we're already scoped to a single tenant_id
      // from the caller, so the per-tenant credential resolver finds the
      // right key for the close call.
      //
      // Through the vendor proxy rather than an if/else naming vendors. That
      // chain listed anchor and browser_use, so a browserbase session survived
      // its tenant's deletion: still running at the vendor, still costing the
      // workspace's account, and no longer referenced by anything that could
      // stop it. A list of vendors written by hand is a list that goes stale
      // the day a vendor is added, which is exactly what happened.
      await closeVendorSession(s.vendor, s.vendor_session_id, tenantId);
    } catch (err) {
      logger.warn('tenant-deletion: vendor session teardown failed', {
        tenant_id: tenantId, session_id: s.id, vendor: s.vendor, error: (err as Error).message,
      });
    }
  }
  await subscriberPool.query(`DELETE FROM web_sessions WHERE tenant_id = $1`, [tenantId]);

  const identities = await subscriberPool.query(
    `SELECT vendor_identity_id, vendor FROM web_identities WHERE tenant_id = $1`,
    [tenantId],
  );
  for (const id of identities.rows) {
    try {
      if (id.vendor === 'anchor') await anchorClient.deleteIdentity(id.vendor_identity_id, tenantId);
    } catch (err) {
      logger.warn('tenant-deletion: vendor identity scrub failed', {
        tenant_id: tenantId, vendor_identity_id: id.vendor_identity_id, error: (err as Error).message,
      });
    }
  }
  await subscriberPool.query(`DELETE FROM web_identities WHERE tenant_id = $1`, [tenantId]);

  // Saved logins, at the VENDOR and not only locally.
  //
  // Dropping the rows alone left the profiles themselves standing, and a
  // profile IS the cookie jar: the whole point of it is that a login survives.
  // On a workspace's own key that is their data on their own account, which
  // teardown already erases for identities. On the PLATFORM key it is a deleted
  // customer's session cookies sitting on an account we run and share with
  // every other workspace, which nothing would ever have removed.
  const profiles = await subscriberPool.query(
    `SELECT profile_name, vendor_profile_id, vendor FROM web_profiles WHERE tenant_id = $1`,
    [tenantId],
  );
  if (profiles.rows.length > 0) {
    const { deleteProfile, PROFILE_VENDORS } = await import('../browser-sessions/session-vendor-proxy');
    for (const row of profiles.rows) {
      if (!PROFILE_VENDORS.includes(row.vendor)) continue;
      try {
        await deleteProfile(row.vendor, row.vendor_profile_id, tenantId);
      } catch (err) {
        // Logged, never fatal: a vendor that will not let go of one profile
        // must not stop the rest of the teardown, and the local rows go either
        // way so the tenant is gone from every surface a person can see.
        logger.warn('tenant-deletion: vendor profile scrub failed', {
          tenant_id: tenantId, vendor: row.vendor,
          vendor_profile_id: row.vendor_profile_id, error: (err as Error).message,
        });
      }
    }
  }
  await subscriberPool.query(`DELETE FROM web_profiles WHERE tenant_id = $1`, [tenantId]);

  // Purge the memory family. Memories hold connector-harvested PII, so under the
  // single-shared-database, delete-at-tenant-granularity model (ADR-002) they
  // MUST be erased when a tenant is deleted — the DB is not dropped, so nothing
  // else removes them (memory-cleanup-service is TTL-only; provenance delete is
  // by-id). Satellites carry their own tenant_id FK to tenants(id) rather than
  // cascading from memories(id), so each is deleted explicitly. Satellites
  // first, then memories last, so no memory_id FK is left dangling regardless of
  // its ON DELETE rule. embedding_cache is content-addressed (global, no
  // tenant_id) and is intentionally excluded.
  await subscriberPool.query(`DELETE FROM memory_audit_log WHERE tenant_id = $1`, [tenantId]);
  await subscriberPool.query(`DELETE FROM memory_retrieval_events WHERE tenant_id = $1`, [tenantId]);
  await subscriberPool.query(`DELETE FROM memory_influence_rollup WHERE tenant_id = $1`, [tenantId]);
  await subscriberPool.query(`DELETE FROM memories_pending_deep_scan WHERE tenant_id = $1`, [tenantId]);
  await subscriberPool.query(`DELETE FROM dlp_quarantine_audit WHERE tenant_id = $1`, [tenantId]);
  const memoriesDeleted = await subscriberPool.query(
    `DELETE FROM memories WHERE tenant_id = $1`,
    [tenantId],
  );

  logger.info({
    tenant_id: tenantId,
    sessions_deleted: sessions.rows.length,
    identities_deleted: identities.rows.length,
    memories_deleted: memoriesDeleted.rowCount ?? 0,
  }, 'tenant-deletion web + memory cleanup complete');
}

export async function handleFeatureFlagUpdated(event: ControlPlaneEvent): Promise<void> {
  const SENTINEL = '00000000-0000-0000-0000-000000000000';

  // Delete branch: PB's delete() publishes payload.key so we can drop the
  // key from the sentinel row's flags JSONB. Tolerate missing payload.key
  // for back-compat with events PB emitted before the A1a rollout.
  if (event.event_type === 'tenant.feature_flag.deleted') {
    const delKey = (event.payload as Record<string, unknown> | undefined)?.key as string | undefined;
    if (!delKey) return;
    await subscriberPool.query(
      `UPDATE cached_feature_flags
       SET flags = (flags - $2::text) - ($2::text || '_value'), updated_at = NOW()
       WHERE tenant_id = $1`,
      [SENTINEL, delKey],
    );
    // Drop the limits-config in-memory cache so the next web-tool admission
    // re-reads from the sentinel row. Without this the operator would wait
    // up to FLAGS_CACHE_TTL_MS (10s) for the delete to take effect on the
    // hot path.
    invalidateFlagsCache();
    logger.info('Deleted sentinel feature-flag key', { key: delKey });
    return;
  }

  // 1. Mirror the changed flag onto the all-zero sentinel row used for
  //    global (non-tenant-scoped) flags. PB's event payload carries
  //    { key, enabled, value_num? } for the changed key. This MUST run before
  //    the per-tenant fetch below because global flag events are published
  //    without event.tenant_id, and the per-tenant fetch path would 404
  //    on `/api/feature-flags/tenant/undefined` and throw — preventing the
  //    sentinel update from ever happening.
  //
  //    Uses atomic JSONB `||` merge so concurrent updates to different keys
  //    cannot lose writes — the old read-modify-write pattern collapsed
  //    parallel updates via last-writer-wins.
  const key = (event.payload as Record<string, unknown> | undefined)?.key as string | undefined;
  const enabled = (event.payload as Record<string, unknown> | undefined)?.enabled;
  const valueNum = (event.payload as Record<string, unknown> | undefined)?.value_num;
  if (key && typeof enabled === 'boolean') {
    const merge: Record<string, unknown> = { [key]: enabled };
    if (typeof valueNum === 'number') merge[`${key}_value`] = valueNum;
    const partial = JSON.stringify(merge);
    await subscriberPool.query(
      `INSERT INTO cached_feature_flags (tenant_id, flags, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (tenant_id) DO UPDATE
         SET flags = cached_feature_flags.flags || EXCLUDED.flags,
             updated_at = NOW()`,
      [SENTINEL, partial],
    );
    // Drop the limits-config in-memory cache so the next web-tool admission
    // sees the new value at event-delivery latency rather than waiting up to
    // FLAGS_CACHE_TTL_MS (10s).
    invalidateFlagsCache();
    logger.info('Updated sentinel feature-flag row', { key, enabled, value_num: valueNum });
  }

  // 2. If the event is tenant-scoped, also refresh the tenant's cached row.
  //    PB only publishes per-tenant feature flag events when a tenant_override
  //    is created/updated/removed; global flag updates carry no tenant_id and
  //    skip this branch entirely.
  if (!event.tenant_id) return;
  const tenantId = event.tenant_id;

  const response = await fetchFromControlPlane(`/api/internal/feature-flags/tenant/${tenantId}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch feature flags: ${response.status}`);
  }
  const flags = await response.json() as Record<string, unknown>;
  await subscriberPool.query(
    `INSERT INTO cached_feature_flags (tenant_id, flags, entity_version, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (tenant_id) DO UPDATE SET
       flags = EXCLUDED.flags,
       entity_version = EXCLUDED.entity_version,
       updated_at = NOW()`,
    [tenantId, JSON.stringify(flags), event.entity_version]
  );
  logger.info('Updated cached feature flags', { tenant_id: tenantId, flag_count: Object.keys(flags).length });
}

async function handleMigrationStarted(event: ControlPlaneEvent): Promise<void> {
  const tenantId = event.tenant_id!;

  // Update local migration status
  await subscriberPool.query(
    `INSERT INTO cached_migration_status (tenant_id, status, started_at, entity_version, updated_at)
     VALUES ($1, 'in_progress', NOW(), $2, NOW())
     ON CONFLICT (tenant_id) DO UPDATE SET
       status = 'in_progress',
       started_at = NOW(),
       completed_at = NULL,
       entity_version = EXCLUDED.entity_version,
       updated_at = NOW()`,
    [tenantId, event.entity_version]
  );

  logger.info('Migration started', { tenant_id: tenantId, entity_version: event.entity_version });
}

async function handleMigrationCompleted(event: ControlPlaneEvent): Promise<void> {
  const tenantId = event.tenant_id!;

  // Update local migration status
  await subscriberPool.query(
    `UPDATE cached_migration_status
     SET status = 'completed',
         completed_at = NOW(),
         entity_version = $2,
         updated_at = NOW()
     WHERE tenant_id = $1`,
    [tenantId, event.entity_version]
  );

  logger.info('Migration completed', { tenant_id: tenantId, entity_version: event.entity_version });
}

// Handle connector credentials stored event
// Security: Tokens are already stored in Secret Manager by the control plane
// This handler only updates local metadata - NO tokens are transmitted via Pub/Sub
//
// Atomicity contract: all four INSERTs (connectors, connector_credentials,
// connector_manifests, action_allowlists) commit together or not at all.
//
// Why this matters: an earlier implementation used `subscriberPool.query()` for
// each statement separately. Each call grabs a fresh connection from the pool,
// and any failure on the third or fourth statement left the first ones
// committed with no way to recover — Pub/Sub doesn't redeliver a message after
// the handler has surfaced a synchronous error mid-way, and the connection
// pool gives no rollback affordance.
//
// The observable end-state of that partial-failure mode: `connectors` row
// present, manifest row missing, every downstream `connector.<type>__*` tool
// call permanently denied by the validator because alias resolution yields no
// row.
//
// All four INSERTs are idempotent (ON CONFLICT DO UPDATE / DO NOTHING), so
// re-delivery after a ROLLBACK is safe.
async function handleCredentialsStored(event: ControlPlaneEvent): Promise<void> {
  const tenantId = event.tenant_id!;
  const connectorId = event.entity_id;
  const payload = event.payload as {
    connectorType: string;
    secretVersion: string; // Reference to Secret Manager version (no actual tokens)
    expiresAt?: string;
    scopes: string[];
    // Composio cutover-completion (C5): for composio_managed connectors,
    // CS's OAuth callback writes connectors.config.composioConnectedAccountId
    // and publishes it here so TR can persist it on the manifest row.
    // tenant-runtime/src/tool-gateway/composio-dispatcher.ts reads it
    // from manifest.externalAccountId and passes it as
    // composio.tools.execute({ connectedAccountId: ... }) to disambiguate
    // multi-account tenants. Absent for native connectors.
    composioConnectedAccountId?: string;
  };

  const secretName = `connector-${connectorId}-${tenantId}`;
  // Auto-provision alias + display name for the manifest.
  //
  // Alias format: `<type-hyphenated>-<first-8-hex-of-connector_id>`. The
  // 8-hex discriminator is required so two OAuth grants of the same type
  // (multi-account: support@ Gmail + sales@ Gmail) end up at different
  // alias keys. The manifest table has UNIQUE (tenant_id, alias) — if both
  // accounts produced the bare `google-mail`, the second connection's
  // manifest UPSERT would `ON CONFLICT DO UPDATE SET id = EXCLUDED.id`
  // and silently overwrite the first manifest's connector_id, breaking
  // the tool catalog for the original account.
  //
  // Compatible with the LLM tool-name regex `^[a-zA-Z0-9_-]+$` so tool
  // names like `google-mail-eaec0c30__list_messages` parse cleanly. The
  // agent-execution parser already splits on `__` and uses the prefix
  // verbatim as the connector key, which buildBindingsByType maps to the
  // bound connector_id.
  //
  // Migration 252 backfilled this format for all existing manifests and
  // the matching action_allowlists rows.
  const aliasBase = payload.connectorType.replace(/_/g, '-');
  const aliasSuffix = connectorId.substring(0, 8);
  const alias = `${aliasBase}-${aliasSuffix}`;
  const displayName = payload.connectorType.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

  const client = await subscriberPool.connect();
  try {
    await client.query('BEGIN');

    // 1. connector row — FK target for credentials below
    await client.query(
      // status is restored on conflict, not only on first insert. Without it a
      // connector that was disconnected and reconnected under the same id kept
      // `disconnected` forever while its manifest and credentials were both
      // correctly refreshed — drift that reads exactly like a connector that
      // never came back, and that migration 385 acted on as though it were one.
      `INSERT INTO connectors (id, tenant_id, type, name, status)
       VALUES ($1, $2, $3, $4, 'active')
       ON CONFLICT (id) DO UPDATE SET type = EXCLUDED.type, status = 'active', updated_at = NOW()`,
      [connectorId, tenantId, payload.connectorType, payload.connectorType]
    );

    // 2. credentials metadata — tokens themselves live in Secret Manager;
    //    this row is just the local mirror for revocation + expiry tracking.
    await client.query(
      `INSERT INTO connector_credentials (
        connector_id, credential_type, secret_name, scopes, expires_at,
        last_refreshed_at, status, created_at, updated_at
      )
      VALUES ($1, 'oauth2', $2, $3, $4, NOW(), 'active', NOW(), NOW())
      ON CONFLICT (connector_id) DO UPDATE SET
        secret_name = EXCLUDED.secret_name,
        scopes = EXCLUDED.scopes,
        expires_at = EXCLUDED.expires_at,
        last_refreshed_at = NOW(),
        status = 'active',
        updated_at = NOW()`,
      [
        connectorId,
        secretName,
        JSON.stringify(payload.scopes),
        payload.expiresAt ? new Date(payload.expiresAt) : null,
      ]
    );

    // 3. manifest — agent tool catalogs are built from this table; without
    //    a row, every tool call for this connector is denied at the
    //    validator's alias-resolution step (see permission-validator.ts).
    //    Function schemas are NOT stored here; they live in
    //    src/connectors/tool-schema-cache.ts and are looked up by
    //    connectorType at execution time.
    await client.query(
      `INSERT INTO connector_manifests (id, tenant_id, connector_type, alias, display_name, enabled, external_account_id)
       VALUES ($1, $2, $3, $4, $5, true, $6)
       ON CONFLICT (tenant_id, alias) DO UPDATE SET
         id = EXCLUDED.id,
         connector_type = EXCLUDED.connector_type,
         display_name = EXCLUDED.display_name,
         enabled = true,
         -- COALESCE preserves an existing external_account_id when the
         -- redelivered event payload doesn't carry one (e.g. a token refresh
         -- without a Composio account-id republish). Composio reconnect
         -- sends a fresh value that overwrites.
         external_account_id = COALESCE(EXCLUDED.external_account_id, connector_manifests.external_account_id),
         updated_at = NOW()`,
      [connectorId, tenantId, payload.connectorType, alias, displayName, payload.composioConnectedAccountId ?? null]
    );

    // 4. action allowlist — all actions allowed by default; per-agent
    //    restriction happens via instruction.allowedConnectors at compile
    //    time, not at this table.
    await client.query(
      `INSERT INTO action_allowlists (tenant_id, connector, action_type, enabled)
       VALUES ($1, $2, '*', true)
       ON CONFLICT DO NOTHING`,
      [tenantId, alias]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {
      // best-effort — the connection is already in an aborted state; the
      // outer throw is what signals Pub/Sub to redeliver.
    });
    throw err;
  } finally {
    client.release();
  }

  logger.info('Auto-provisioned connector + credentials + manifest + allowlist (atomic)', {
    tenant_id: tenantId,
    connector_id: connectorId,
    connector_type: payload.connectorType,
    alias,
    secret_version: payload.secretVersion,
  });

  // Auto-arm Gmail users.watch on connect. Without this, the first push
  // notification never fires and the rearm cron (which only refreshes
  // EXISTING subscriptions) never picks up the connector. Best-effort —
  // a failure here doesn't roll back the credential store; the bulk-arm
  // script (src/scripts/arm-missing-gmail-watches.ts) catches stragglers
  // and the rearm cron keeps it alive once armed.
  if (payload.connectorType === 'google_mail') {
    try {
      const { armGmailWatchFor } = await import('../connectors/gmail-watch');
      await armGmailWatchFor(connectorId, tenantId);
      logger.info('gmail-watch: armed on connector.credentials_stored', {
        tenant_id: tenantId,
        connector_id: connectorId,
      });
    } catch (err) {
      logger.warn(
        {
          tenant_id: tenantId,
          connector_id: connectorId,
          err: (err as Error).message,
        },
        'gmail-watch: initial arm failed (non-fatal — bulk-arm script will retry)',
      );
    }
  }
}

/**
 * Handle connector.composio_trigger_fired events. Platform-backend's
 * /api/internal/composio-webhook receives Composio trigger payloads,
 * verifies HMAC, and republishes them as this event type. The payload
 * carries the Composio metadata (trigger_slug, connected_account_id) +
 * the vendor data. We map each supported trigger_slug to a (source,
 * entityType) tuple that resolveEventTopics() understands via the
 * COMPOSIO_TRIGGER_DISPATCH registry in scheduling/composio-trigger-
 * registry.ts, then delegate to the shared dispatchConnectorEventDirect
 * path so the same lifecycle / per-binding filter / executeTask flow
 * runs as for Pub/Sub-delivered connector events.
 *
 * Adding a new Composio trigger slug means adding one row to the
 * registry here AND a paired row in connector-service's
 * src/oauth/composio-trigger-registry.ts (slug + triggerConfig).
 */
async function handleComposioTriggerFired(event: ControlPlaneEvent): Promise<void> {
  const tenantId = event.tenant_id;
  if (!tenantId) {
    logger.warn('composio_trigger_fired event missing tenant_id, skipping', {
      event_id: event.event_id,
    });
    return;
  }
  const payload = (event.payload ?? {}) as {
    triggerSlug?: string;
    composioConnectedAccountId?: string;
    data?: Record<string, unknown>;
  };
  const triggerSlug = payload.triggerSlug;
  if (!triggerSlug) {
    logger.warn('composio_trigger_fired event missing triggerSlug, skipping', {
      event_id: event.event_id,
      tenant_id: tenantId,
    });
    return;
  }
  const { resolveComposioTriggerDispatch } = await import('../scheduling/composio-trigger-registry');
  const dispatch = resolveComposioTriggerDispatch(triggerSlug);
  if (!dispatch) {
    logger.info('composio_trigger_fired: unknown trigger slug, ignoring', {
      event_id: event.event_id,
      tenant_id: tenantId,
      trigger_slug: triggerSlug,
    });
    return;
  }
  // We're running inside coordinator-service (owner of the
  // control-plane-events subscriber per src/index.ts). The event-trigger
  // in-memory registry lives in agent-service (loaded by
  // startEventTriggerSubscriber), so dispatching directly from here
  // would always hit an empty registry and silently drop the event.
  //
  // Republish to `connector-events-${env}` (same Pub/Sub topic the
  // gmail-history-push-handler uses, see handlers/gmail-history-push-
  // handler.ts) so agent-service's existing subscriber picks it up and
  // runs dispatchConnectorEventDirect with the real registry. Payload
  // + attribute shape matches the existing contract — agent-service
  // doesn't need to know the event came from Composio vs Gmail watch.
  const environment = process.env.ENVIRONMENT ?? 'dev';
  const topicName = `connector-events-${environment}`;
  const { PubSub } = await import('@google-cloud/pubsub');
  const publisher = new PubSub().topic(topicName);
  try {
    await publisher.publishMessage({
      data: Buffer.from(JSON.stringify({
        eventId: event.event_id,
        eventUUID: event.event_id,
        tenantId,
        connectorId: payload.composioConnectedAccountId,
        entityType: dispatch.entityType,
        // Vendor record id isn't always available in the trigger payload
        // and we don't need it for routing — agents see the full data
        // blob under payload.data.
        entityId: event.event_id,
        eventType: 'connector.record.synced',
        occurredAt: event.occurred_at,
        payload: { source: dispatch.source, data: payload.data ?? {} },
      })),
      attributes: {
        tenantId,
        entityType: dispatch.entityType,
        source: dispatch.source,
        eventType: 'connector.record.synced',
        delivery: 'composio',
      },
    });
  } catch (err) {
    logger.error(
      { err: (err as Error).message, event_id: event.event_id, tenant_id: tenantId, trigger_slug: triggerSlug },
      'composio_trigger_fired: republish to connector-events failed',
    );
    throw err; // surface so dispatchEvent nacks → Pub/Sub redelivers
  }
  logger.info('composio_trigger_fired republished to connector-events', {
    event_id: event.event_id,
    tenant_id: tenantId,
    trigger_slug: triggerSlug,
    source: dispatch.source,
    entity_type: dispatch.entityType,
    topic: topicName,
  });
}

/**
 * Handle `connector.webhook_event_received` — a vendor webhook a connector
 * received on its OWN endpoint (GitHub App `pull_request` / `issues`, Slack
 * Events API), on its way to an agent.
 *
 * WHY IT ARRIVES THIS WAY ROUND. connector-service runs in the control project,
 * so what it publishes lands on
 * `YOUR_GCP_PROJECT/connector-events-${env}`, whose only
 * subscriber is harvest-service. The `connector-events-${env}` this runtime
 * reads is a different topic of the same name in the tenant project, and no
 * subscription bridges them. So the delivery comes over control-plane-events
 * instead, and this handler puts it on the topic agent-service listens to —
 * same shape and same reason as `handleComposioTriggerFired` above.
 *
 * Paired producer: liftoff-connector-service
 * `src/events/connector-webhook-event.ts`. The payload keys read here are the
 * keys written there; a rename on either side lands in the `default:` branch of
 * the switch above, which reports the event as an unhandled hole.
 */
async function handleConnectorWebhookEventReceived(event: ControlPlaneEvent): Promise<void> {
  const tenantId = event.tenant_id;
  if (!tenantId) {
    logger.warn('connector_webhook_event missing tenant_id, skipping', {
      event_id: event.event_id,
    });
    return;
  }

  const payload = (event.payload ?? {}) as {
    source?: string;
    subtype?: string;
    connectorId?: string;
    entityType?: string;
    entityId?: string;
    eventId?: string;
    occurredAt?: string;
    data?: unknown;
  };
  const { source, entityType } = payload;
  if (!source || !entityType) {
    logger.warn('connector_webhook_event missing source/entityType, skipping', {
      event_id: event.event_id,
      tenant_id: tenantId,
      source,
      entity_type: entityType,
    });
    return;
  }

  // `control-plane-events` fans out to EVERY tenant's coordinator, so most
  // deliveries here are for somebody else. Republishing one would put another
  // workspace's pull-request body on this workspace's topic. Nothing would run
  // — dispatchConnectorEventDirect finds no agent for that tenant — but the
  // data would have crossed a boundary it has no business crossing.
  //
  // A membership question, the same one `isKnownTenant` asks: a runtime serves
  // every tenant in its database, so an equality check against any single "own"
  // tenant would drop all the others.
  const known = await subscriberPool.query('SELECT 1 FROM tenants WHERE id = $1 LIMIT 1', [tenantId]);
  if (known.rowCount === 0) {
    logger.debug('connector_webhook_event for another tenant, ignoring', {
      event_id: event.event_id,
      tenant_id: tenantId,
      source,
    });
    return;
  }

  const environment = process.env.ENVIRONMENT ?? 'dev';
  const topicName = `connector-events-${environment}`;
  const { PubSub } = await import('@google-cloud/pubsub');
  const publisher = new PubSub().topic(topicName);

  // The vendor's own delivery id, NOT event.event_id. agent-service dedupes on
  // this via markEventSeen, and the control-plane event_id is minted fresh on
  // every publish — keyed on that, a vendor redelivery of the same pull request
  // runs the agent a second time.
  const eventId = payload.eventId ?? event.event_id;

  try {
    await publisher.publishMessage({
      data: Buffer.from(JSON.stringify({
        eventId,
        eventUUID: event.event_id,
        tenantId,
        connectorId: payload.connectorId,
        entityType,
        entityId: payload.entityId ?? eventId,
        eventType: 'connector.record.synced',
        occurredAt: payload.occurredAt ?? event.occurred_at,
        // `data` verbatim: githubEventMatches reads GitHub's native
        // `action` / `pull_request.draft` / `pull_request.merged` /
        // `repository.full_name` off exactly this object.
        payload: { source, subtype: payload.subtype, data: payload.data ?? {} },
      })),
      attributes: {
        tenantId,
        entityType,
        source,
        eventType: 'connector.record.synced',
        delivery: 'push',
      },
    });
  } catch (err) {
    logger.error(
      { err: (err as Error).message, event_id: event.event_id, tenant_id: tenantId, source },
      'connector_webhook_event: republish to connector-events failed',
    );
    throw err; // surface so dispatchEvent nacks → Pub/Sub redelivers
  }

  logger.info('connector_webhook_event republished to connector-events', {
    event_id: event.event_id,
    tenant_id: tenantId,
    source,
    subtype: payload.subtype,
    entity_type: entityType,
    entity_id: payload.entityId,
    dedupe_event_id: eventId,
    topic: topicName,
  });
}

/**
 * Handle `connector.record_synced` — a record a connector POLLED, on its way to
 * an agent.
 *
 * WHY IT ARRIVES THIS WAY ROUND. Identical to
 * `handleConnectorWebhookEventReceived` above: connector-service runs in the
 * control project, so its `connector-events-${env}` publish lands on a topic
 * whose only subscriber is harvest-service, and the `connector-events-${env}`
 * this runtime reads is a different topic of the same name in the tenant
 * project. No subscription bridges them.
 *
 * That is why every poll-reactive connector in the catalog advertised event
 * topics that could never fire: the records reached harvest and stopped. The
 * webhook and Composio paths were given this relay; the poll path was not.
 *
 * Paired producer: liftoff-connector-service
 * `src/events/connector-record-synced.ts`. The payload keys read here are the
 * keys written there; a rename on either side lands in the `default:` branch of
 * the switch above, which reports the event as an unhandled hole.
 */
async function handleConnectorRecordSynced(event: ControlPlaneEvent): Promise<void> {
  const tenantId = event.tenant_id;
  if (!tenantId) {
    logger.warn('connector_record_synced missing tenant_id, skipping', {
      event_id: event.event_id,
    });
    return;
  }

  const payload = (event.payload ?? {}) as {
    source?: string;
    connectorId?: string;
    entityType?: string;
    entityId?: string;
    eventId?: string;
    occurredAt?: string;
    data?: unknown;
  };
  const { source, entityType } = payload;
  if (!source || !entityType) {
    logger.warn('connector_record_synced missing source/entityType, skipping', {
      event_id: event.event_id,
      tenant_id: tenantId,
      source,
      entity_type: entityType,
    });
    return;
  }

  // `control-plane-events` fans out to EVERY tenant's coordinator, so most
  // deliveries here are for somebody else. Republishing one would put another
  // workspace's CRM records on this workspace's topic. Same membership question
  // as the webhook handler, and for the same reason.
  const known = await subscriberPool.query('SELECT 1 FROM tenants WHERE id = $1 LIMIT 1', [tenantId]);
  if (known.rowCount === 0) {
    logger.debug('connector_record_synced for another tenant, ignoring', {
      event_id: event.event_id,
      tenant_id: tenantId,
      source,
    });
    return;
  }

  const environment = process.env.ENVIRONMENT ?? 'dev';
  const topicName = `connector-events-${environment}`;
  const { PubSub } = await import('@google-cloud/pubsub');
  const publisher = new PubSub().topic(topicName);

  // `${externalId}-${version}` from the poller, NOT event.event_id. The poller
  // re-emits every record it can still see on EVERY cycle, so keyed on a
  // freshly-minted control-plane id this would wake an agent once a minute per
  // record forever. Keyed on the producer's id it is stable while the record is
  // unchanged, and agent-service's markEventSeen drops the repeat.
  const eventId = payload.eventId ?? event.event_id;

  try {
    await publisher.publishMessage({
      data: Buffer.from(JSON.stringify({
        eventId,
        eventUUID: event.event_id,
        tenantId,
        connectorId: payload.connectorId,
        entityType,
        entityId: payload.entityId ?? eventId,
        eventType: 'connector.record.synced',
        occurredAt: payload.occurredAt ?? event.occurred_at,
        // `data` verbatim — the normalized record the poller emitted, which is
        // what the event filters and the agent's input template read.
        payload: { source, data: payload.data ?? {} },
      })),
      attributes: {
        tenantId,
        entityType,
        source,
        eventType: 'connector.record.synced',
        delivery: 'poll',
      },
    });
  } catch (err) {
    logger.error(
      { err: (err as Error).message, event_id: event.event_id, tenant_id: tenantId, source },
      'connector_record_synced: republish to connector-events failed',
    );
    throw err; // surface so dispatchEvent nacks → Pub/Sub redelivers
  }

  logger.info('connector_record_synced republished to connector-events', {
    event_id: event.event_id,
    tenant_id: tenantId,
    source,
    entity_type: entityType,
    entity_id: payload.entityId,
    dedupe_event_id: eventId,
    topic: topicName,
  });
}

// Handle connector.disconnected event from control plane.
// Transactional: all three updates (manifest disable, credentials revoke,
// connector status) must commit atomically. Partial state would leave the
// tool gateway calling APIs with dead tokens. On any failure the entire
// event is rolled back and Pub/Sub will redeliver.
//
// Dual-mirror note (Composio migration cutover):
// connector-service is the AUTHORITATIVE store for the connector row; this
// table is tenant-runtime's local mirror used to gate manifest enablement
// and credential revocation. The two can intentionally diverge on
// `status`:
//
//   connector-service.connectors.status         tenant-runtime.connectors.status
//   ───────────────────────────────────         ─────────────────────────────────
//   'error' (composio-migrate-reconnect set)    'disconnected' (this handler)
//   'disconnected' (user-initiated disconnect)  'disconnected' (this handler)
//
// The 'error' value upstream is what flips the frontend's
// `useIntegrations` hook to `needs_reconnect` (renders a Reconnect button).
// The tool gateway reads ONLY this local mirror, where 'disconnected' is
// the right signal — it short-circuits manifest lookups so the agent
// doesn't keep hitting an inactive connector. Both states are correct
// for their reader; they're not meant to be reconciled.
async function handleConnectorDisconnected(event: ControlPlaneEvent): Promise<void> {
  const tenantId = event.tenant_id!;
  const connectorId = event.entity_id;
  const payload = event.payload as { connectorType: string };

  if (!tenantId) {
    logger.error('Connector disconnected event missing tenantId', { connectorId });
    return;
  }

  const client = await subscriberPool.connect();
  try {
    await client.query('BEGIN');

    // Disable the connector manifest so tool gateway won't attempt calls.
    //
    // Keyed on the connector id, like the two writes below it. It used to
    // derive an alias — `connectorType.replace(/_/g, '-')` — and match on that,
    // which no row has carried since migration 252: connect writes
    // `<type>-<first-8-of-connector-id>` so two grants of one type cannot
    // collide on UNIQUE (tenant_id, alias). The bare form matched nothing, in
    // every environment, for every connector, from the day the suffix landed.
    //
    // An UPDATE that matches no row is not an error, and the success log below
    // named the alias it had just failed to find, so the only available signal
    // said the manifest had been disabled. What it left behind is a manifest
    // that stays `enabled` forever while `connectors` says disconnected and
    // `connector_credentials` says revoked — and the manifest is the table the
    // agent's tool catalog is built from, so every agent bound to that type
    // kept being offered a dead connector's tools. Migration 385 disables the
    // rows this left behind.
    const manifestRes = await client.query(
      `UPDATE connector_manifests SET enabled = false, updated_at = NOW()
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, connectorId]
    );
    // Say so when it matches nothing. The whole defect above was survivable
    // only because this was silent.
    if (manifestRes.rowCount === 0) {
      logger.warn('Connector disconnected but no manifest row matched; tool catalog may still offer it', {
        tenant_id: tenantId,
        connector_id: connectorId,
        connector_type: payload.connectorType,
      });
    }

    // Mark connector credentials as revoked
    await client.query(
      `UPDATE connector_credentials SET status = 'revoked', updated_at = NOW()
       WHERE connector_id = $1`,
      [connectorId]
    );

    // Update connector status to disconnected
    await client.query(
      `UPDATE connectors SET status = 'disconnected', updated_at = NOW()
       WHERE id = $1 AND tenant_id = $2`,
      [connectorId, tenantId]
    );

    await client.query('COMMIT');

    logger.info('Connector disconnected: manifest disabled, credentials revoked', {
      tenant_id: tenantId,
      connector_id: connectorId,
      connector_type: payload.connectorType,
      manifests_disabled: manifestRes.rowCount,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('Failed to process connector.disconnected event, rolled back', {
      tenant_id: tenantId,
      connector_id: connectorId,
      error: (error as Error).message,
    });
    throw error; // Let Pub/Sub redeliver
  } finally {
    client.release();
  }
}

// Per implementation plan: Phase 1.5 Event Subscription
// Handle oversight settings updated event from control plane
async function handleOversightUpdated(event: ControlPlaneEvent): Promise<void> {
  const tenantId = event.tenant_id!;
  const payload = event.payload as {
    autonomy: 'autonomous' | 'balanced' | 'controlled';
    escalation: 'exceptions' | 'important' | 'sensitive';
    sensitiveWork: Record<string, boolean>;
    communication: 'draft' | 'auto' | 'review';
    /** Which meaning of each setting the workspace chose under (platform-backend
     *  migration 508). Absent from an older control plane; stored as absent,
     *  which the reader treats as 1. */
    escalationSemantics?: number;
    communicationSemantics?: number;
  };

  // Update tenant_oversight_cache
  await subscriberPool.query(
    `INSERT INTO tenant_oversight_cache (tenant_id, entity_version, autonomy, escalation, sensitive_work, communication,
       escalation_semantics, communication_semantics, synced_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
     ON CONFLICT (tenant_id) DO UPDATE SET
       entity_version = EXCLUDED.entity_version,
       autonomy = EXCLUDED.autonomy,
       escalation = EXCLUDED.escalation,
       sensitive_work = EXCLUDED.sensitive_work,
       communication = EXCLUDED.communication,
       escalation_semantics = EXCLUDED.escalation_semantics,
       communication_semantics = EXCLUDED.communication_semantics,
       synced_at = NOW()`,
    [
      tenantId,
      event.entity_version,
      payload.autonomy,
      payload.escalation,
      JSON.stringify(payload.sensitiveWork),
      payload.communication,
      typeof payload.escalationSemantics === 'number' ? payload.escalationSemantics : null,
      typeof payload.communicationSemantics === 'number' ? payload.communicationSemantics : null,
    ]
  );

  logger.info('Updated tenant oversight cache', {
    tenant_id: tenantId,
    entity_version: event.entity_version,
    autonomy: payload.autonomy,
    escalation: payload.escalation,
  });
}

// Handle internal agent runtime config updated event from control plane
async function handleInternalAgentRuntimeConfigUpdated(event: ControlPlaneEvent): Promise<void> {
  const tenantId = event.tenant_id!;
  const internalAgentId = event.entity_id;
  const payload = event.payload as {
    // Carried in payload (not envelope) so the version gate in
    // processValidatedEvent bypasses this event — see service.ts comment for
    // rationale. Falls back to event.entity_version for legacy publishers that
    // haven't migrated.
    entityVersion?: number;
    agentType: 'agent' | 'workflow';
    hitlLevel?: number;
    modelConfig: Record<string, unknown>;
    execConfig: Record<string, unknown>;
    memoryScope: Record<string, unknown>;
    workflowSteps?: WorkflowStep[] | null;    // the steps the hash describes
    workflowStepsHash?: string;              // hash for tamper detection
  };
  const effectiveEntityVersion = payload.entityVersion ?? event.entity_version ?? null;

  // WS-4.1: read existing hitl_level so a payload without the field doesn't
  // null-write into a NOT NULL column. Default 3 only on first write (which
  // happens via the create path, not this update path — but kept here as a
  // safety belt). `||` would falsy-coerce 0/undefined to null and DLQ the
  // message.
  const existingHitl = await subscriberPool.query(
    `SELECT hitl_level FROM agents
     WHERE id = (SELECT agent_id FROM internal_agent_runtime_mapping WHERE internal_agent_id = $1)
       AND tenant_id = $2`,
    [internalAgentId, tenantId],
  );
  const effectiveHitlLevel = payload.hitlLevel ?? existingHitl.rows[0]?.hitl_level ?? 3;

  // Decide what to do with the steps BEFORE writing anything. A hash mismatch
  // must never reach the database: `verifyWorkflowStepsHash` would catch it at
  // execution, but only after a run had already started from steps we already
  // knew were wrong. Rejecting here keeps the agent on the conversational path
  // it has been running all along, which is a safe state rather than a new one.
  const stepsArrival = decideWorkflowStepsArrival(payload);
  if (stepsArrival.action === 'leave' && stepsArrival.reason === 'hash_mismatch') {
    logger.error('Rejected workflow steps: hash does not match the steps it travelled with', {
      tenant_id: tenantId,
      internal_agent_id: internalAgentId,
      detail: stepsArrival.detail,
    });
  }

  // Update agent's runtime config cache
  // This updates the local agent config that the execution engine uses
  await subscriberPool.query(
    `UPDATE agents SET
       agent_type = $3,
       hitl_level = $4,
       model_config = $5,
       exec_config = $6,
       memory_scope = $7,
       entity_version = COALESCE($8, entity_version),
       workflow_steps_hash = COALESCE($9, workflow_steps_hash),
       -- Three outcomes, not two: SET writes the steps, CLEAR writes NULL
       -- because the control plane no longer has any, and LEAVE keeps what is
       -- stored. COALESCE alone cannot express clear, and a publisher that
       -- predates this field sends nothing at all — treating that as clear
       -- would wipe steps on every event from an older instance.
       workflow_steps = CASE WHEN $11::boolean THEN $10::jsonb ELSE workflow_steps END,
       updated_at = NOW()
     WHERE id = (SELECT agent_id FROM internal_agent_runtime_mapping WHERE internal_agent_id = $2)
       AND tenant_id = $1`,
    [
      tenantId,
      internalAgentId,
      payload.agentType,
      effectiveHitlLevel,
      JSON.stringify(payload.modelConfig),
      JSON.stringify(payload.execConfig),
      JSON.stringify(payload.memoryScope),
      effectiveEntityVersion,
      payload.workflowStepsHash || null,
      stepsArrival.action === 'set' ? JSON.stringify(stepsArrival.steps) : null,
      stepsArrival.action !== 'leave',
    ]
  );

  logger.info('Updated internal agent runtime config', {
    tenant_id: tenantId,
    internal_agent_id: internalAgentId,
    entity_version: event.entity_version,
    agent_type: payload.agentType,
    hitl_level: payload.hitlLevel,
  });
}

// Handle internal agent created event
// BE-001, BE-002: Creates agent and mapping in transaction
// Exported so canonical-reconciler.ts can call this with a synthesized event
// when its self-heal path detects an internal_agent with no local mapping
// (the original Pub/Sub creation event was lost — DLQ exhausted, subscriber
// crashed mid-handler, schema-drift dropped it, etc.). The reconciler builds
// a ControlPlaneEvent envelope around the full payload it fetched from
// platform-backend's /canonical-agents/:id/full endpoint and invokes this
// directly, so the creation path stays single-source.
export async function handleInternalAgentCreated(event: ControlPlaneEvent): Promise<void> {
  const tenantId = event.tenant_id!;
  const internalAgentId = event.entity_id;

  const payload = event.payload as {
    id?: string;
    name?: string;
    role?: string;
    status: string;
    agentType?: string;
    hitlLevel?: number;
    modelConfig?: Record<string, unknown>;
    execConfig?: Record<string, unknown>;
    memoryScope?: Record<string, unknown>;
    triggerConfig?: { type: string; cronExpr?: string } | null;
    systemPrompt?: string;
    userInstructions?: string;
    integrations?: Array<{ id: string; selectedObjects: string[] }>;
    workflowSteps?: WorkflowStep[] | null;    // the steps the hash describes
    workflowStepsHash?: string;              // hash for tamper detection
    instructionsMd?: string;                 // DB-backed CLAUDE.md content
    capabilityTier?: 'connector_only' | 'execution_enabled';  // R5: shell/file tool gating
    // Per-tool result-handling policy from distillation. Travels beside
    // capabilityTier because it is the same kind of thing: a per-agent policy the
    // platform decides and the tool gateway obeys.
    resultRules?: Array<{ toolName: string; requiresComplete: boolean }>;
    /** Per-tool rules the control plane decided at distillation. Full-replace
     *  on every publish, exactly like resultRules above. */
    toolDescriptionOverrides?: Record<string, string>;
    /** Declared grounding rules, same lifecycle. */
    groundsOn?: Array<{ label: string; terms: string[]; cues: string[]; toolName: string; enabled: boolean }>;
    /** Per-capability tri-state, same lifecycle. */
    capabilityStates?: Record<string, 'live' | 'unwired' | 'absent'>;
    skills?: Skill[];                        // Discrete semantically-selectable instruction modules
    pinnedKnowledgeIds?: string[];           // Knowledge items pinned via [[knowledge:...]] markers
    // Reconciler-emitted republishes carry entity_version=null on the envelope
    // (to bypass the version gate) and provide the real version here in the
    // payload. Live publishers leave this undefined and the handler falls
    // back to event.entity_version.
    entityVersion?: number;
  };
  const effectiveEntityVersion = payload.entityVersion ?? event.entity_version ?? 0;

  // Idempotency: check if agent already exists via mapping (includes JOIN for lifecycle)
  const existingMapping = await subscriberPool.query(
    `SELECT m.agent_id, a.lifecycle FROM internal_agent_runtime_mapping m
     JOIN agents a ON a.id = m.agent_id
     WHERE m.internal_agent_id = $1 AND m.tenant_id = $2`,
    [internalAgentId, tenantId]
  );

  if (existingMapping.rows.length > 0) {
    const existingAgentId = existingMapping.rows[0].agent_id as string;
    const existingLifecycle = existingMapping.rows[0].lifecycle as string;

    // Check whether instructions were compiled on the first attempt.
    const existingInstruction = await subscriberPool.query(
      `SELECT id FROM compiled_instructions
       WHERE agent_id = $1 AND tenant_id = $2 AND status = 'active'
       LIMIT 1`,
      [existingAgentId, tenantId],
    );
    const hasInstruction = existingInstruction.rows.length > 0;

    const needsCompilation = !hasInstruction;
    const needsActivation = payload.status === 'active' && existingLifecycle === 'DRAFT';

    if (needsCompilation || needsActivation) {
      logger.info('Agent exists but needs compilation or activation — retrying', {
        internal_agent_id: internalAgentId,
        agent_id: existingAgentId,
        tenant_id: tenantId,
        needsCompilation,
        needsActivation,
      });
      await internalAgentInstructionService.createAndActivateForInternalAgent({
        tenantId,
        agentId: existingAgentId,
        idempotencyKey: event.event_id + '_activation',
        systemPrompt: payload.systemPrompt,
        userInstructions: payload.userInstructions,
        hitlLevel: payload.hitlLevel,
        integrations: payload.integrations,
        triggerConfig: payload.triggerConfig ? {
          type: payload.triggerConfig.type as 'cron' | 'event',
          cronExpr: payload.triggerConfig.cronExpr,
        } : undefined,
        instructionsMd: payload.instructionsMd ?? null,
        capabilityTier: payload.capabilityTier,
        resultRules: payload.resultRules,
        toolDescriptionOverrides: payload.toolDescriptionOverrides,
        groundsOn: payload.groundsOn,
        capabilityStates: payload.capabilityStates,
        skills: payload.skills,
        pinnedKnowledgeIds: payload.pinnedKnowledgeIds ?? [],
      });
      if (needsActivation) {
        await agentLifecycleService.activate(existingAgentId);
        await agentLifecycleService.ensureSchedulerJob(existingAgentId);
      }
      logger.info('Compilation/activation completed on retry', {
        internal_agent_id: internalAgentId,
        agent_id: existingAgentId,
        tenant_id: tenantId,
      });
      return;
    }

    logger.info('Agent already exists for internal agent (idempotent skip)', {
      internal_agent_id: internalAgentId,
      agent_id: existingAgentId,
      tenant_id: tenantId,
    });
    return;
  }

  // Validate tenant isolation (SE-002)
  if (!tenantId) {
    logger.error('Internal agent created event missing tenantId', { internalAgentId });
    return;
  }

  const dbPool = subscriberPool;
  const client = await dbPool.connect();

  // Hoist agentId so it is accessible after the try/finally block for inline activation.
  const agentId = uuidv4();

  try {
    // Use transaction to ensure atomicity (BE-001, BE-002)
    await client.query('BEGIN');

    // 1. Create agent record FIRST
    // Phase 1c: platform-backend now sends only canonical literals ('agent'|'workflow')
    // post-migration-089. The normalizer is removed; payload.agentType passes through directly.
    //
    // Steps are decided the same way as on the update path, and for the same
    // reason: an agent created with steps whose hash does not match them is
    // created WITHOUT steps rather than with unverified ones.
    const createArrival = decideWorkflowStepsArrival(payload);
    if (createArrival.action === 'leave' && createArrival.reason === 'hash_mismatch') {
      logger.error('Rejected workflow steps on agent create: hash does not match the steps', {
        tenant_id: tenantId,
        internal_agent_id: internalAgentId,
        detail: createArrival.detail,
      });
    }
    await client.query(
      `INSERT INTO agents
       (id, tenant_id, name, lifecycle, runtime_status, agent_type, hitl_level,
        model_config, exec_config, memory_scope, trigger_config, system_prompt,
        user_instructions, workflow_steps_hash, workflow_steps,
        instructions_md, role, messaging_nickname, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, NOW(), NOW())`,
      [
        agentId,
        tenantId,
        payload.name || payload.role || 'Unnamed Agent',
        'DRAFT',
        'IDLE',
        payload.agentType || 'agent',
        payload.hitlLevel ?? 3,
        JSON.stringify(payload.modelConfig || {}),
        JSON.stringify(payload.execConfig || {}),
        JSON.stringify(payload.memoryScope || {}),
        payload.triggerConfig ? JSON.stringify(payload.triggerConfig) : null,
        payload.systemPrompt || '',
        payload.userInstructions || '',
        payload.workflowStepsHash || null,
        createArrival.action === 'set' ? JSON.stringify(createArrival.steps) : null,
        payload.instructionsMd || null,
        // role mirrors agents.name (set from internal_agents.role via PB event payload.name)
        payload.name || payload.role || 'Unnamed Agent',
        // messaging_nickname: short chat alias; null until PB starts including it in events
        (payload as Record<string, unknown>).messagingNickname as string | null ?? null,
      ]
    );

    // 2. Create mapping SECOND (FK constraint satisfied)
    await client.query(
      `INSERT INTO internal_agent_runtime_mapping (internal_agent_id, agent_id, tenant_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (internal_agent_id) DO NOTHING`,
      [internalAgentId, agentId, tenantId]
    );

    // 3. Also cache internal agent metadata for local lookups
    await client.query(
      `INSERT INTO cached_internal_agents (internal_agent_id, tenant_id, role, status, integrations, entity_version, synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (internal_agent_id) DO UPDATE SET
         role = EXCLUDED.role,
         status = EXCLUDED.status,
         integrations = EXCLUDED.integrations,
         entity_version = EXCLUDED.entity_version,
         synced_at = NOW()`,
      [internalAgentId, tenantId, payload.name || payload.role, payload.status, JSON.stringify(payload.integrations || []), effectiveEntityVersion]
    );

    await client.query('COMMIT');

    logger.info('Created agent and mapping for internal agent', {
      internal_agent_id: internalAgentId,
      agent_id: agentId,
      tenant_id: tenantId,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('Failed to create agent for internal agent', {
      internal_agent_id: internalAgentId,
      tenant_id: tenantId,
      error: (error as Error).message,
    });
    throw error;
  } finally {
    client.release();
  }

  // Always compile instructions from the creation payload — draft and active agents alike
  // need compiled_instructions so chat works regardless of launch state.  The ONLY
  // difference between LAUNCH NOW (status=active) and MAYBE LATER (status=draft) is
  // whether the lifecycle is activated so the agent can execute autonomously.
  try {
    await internalAgentInstructionService.createAndActivateForInternalAgent({
      tenantId,
      agentId,
      idempotencyKey: event.event_id + '_activation',
      systemPrompt: payload.systemPrompt,
      userInstructions: payload.userInstructions,
      hitlLevel: payload.hitlLevel,
      integrations: payload.integrations,
      triggerConfig: payload.triggerConfig ? {
        type: payload.triggerConfig.type as 'cron' | 'event',
        cronExpr: payload.triggerConfig.cronExpr,
      } : undefined,
      instructionsMd: payload.instructionsMd ?? null,
      capabilityTier: payload.capabilityTier,
      resultRules: payload.resultRules,
      toolDescriptionOverrides: payload.toolDescriptionOverrides,
      groundsOn: payload.groundsOn,
      capabilityStates: payload.capabilityStates,
      skills: payload.skills,
      pinnedKnowledgeIds: payload.pinnedKnowledgeIds ?? [],
    });
    if (payload.status === 'active') {
      await agentLifecycleService.activate(agentId);
      await agentLifecycleService.ensureSchedulerJob(agentId);
    }
    logger.info('Compiled instructions created for newly created agent', {
      internal_agent_id: internalAgentId,
      agent_id: agentId,
      tenant_id: tenantId,
      lifecycleActivated: payload.status === 'active',
    });
  } catch (compilationError) {
    logger.error('Instruction compilation failed for newly created agent — nacking for retry', {
      internal_agent_id: internalAgentId,
      agent_id: agentId,
      tenant_id: tenantId,
      error: (compilationError as Error).message,
    });
    throw compilationError;
  }
}

// Handle internal agent updated event
// Syncs updated internal agent config to local cache
export async function handleInternalAgentUpdated(event: ControlPlaneEvent): Promise<void> {
  const tenantId = event.tenant_id!;
  const internalAgentId = event.entity_id;
  const payload = event.payload as {
    name?: string;                           // Display name (= role for now)
    role?: string;
    integrations?: Array<{ id: string; selectedObjects?: string[]; type?: string }>;
    rollbackFromVersion?: number;
    instructionsMd?: string;                 // DB-backed CLAUDE.md content
    // Distilled content — included when the agent is re-distilled or rolled back.
    // When present, we rebuild the compiled_instructions row so the chat/execution
    // layers see the new systemPrompt, userInstructions, hitlLevel, and tool list.
    systemPrompt?: string;
    userInstructions?: string;
    hitlLevel?: number;
    // Runtime configuration columns — when present in payload, must mirror onto
    // the agents table so secondary read paths (chat-turn-handler, provider
    // resolution, scheduling, memory routing) see fresh state instead of
    // bootstrap-time stale values.
    modelConfig?: Record<string, unknown>;
    execConfig?: Record<string, unknown>;
    memoryScope?: Record<string, unknown>;
    capabilityTier?: 'connector_only' | 'execution_enabled';  // R5: shell/file tool gating
    // Per-tool result-handling policy from distillation. Travels beside
    // capabilityTier on every payload that compiles an instruction, because a
    // policy that reaches only some of those paths is a policy the agent has on
    // some days.
    resultRules?: Array<{ toolName: string; requiresComplete: boolean }>;
    /** Per-tool rules the control plane decided at distillation. Full-replace
     *  on every publish, exactly like resultRules above. */
    toolDescriptionOverrides?: Record<string, string>;
    /** Declared grounding rules, same lifecycle. */
    groundsOn?: Array<{ label: string; terms: string[]; cues: string[]; toolName: string; enabled: boolean }>;
    /** Per-capability tri-state, same lifecycle. */
    capabilityStates?: Record<string, 'live' | 'unwired' | 'absent'>;
    triggerConfig?: {
      type: 'cron' | 'event' | 'manual';
      cronExpr?: string;
      eventTopic?: string;
    } | null;
    skills?: Skill[];
    // The deterministic backbone, and the hash that vouches for it. Absent from
    // this type until now, which is exactly why the update path never mirrored
    // them onto `agents` — the field could not be read because it was never
    // declared, so it was silently dropped from the one handler that ordinary
    // agent edits actually reach.
    workflowSteps?: WorkflowStep[] | null;
    workflowStepsHash?: string;
    pinnedKnowledgeIds?: string[];           // Knowledge items pinned via [[knowledge:...]] markers
    // Reconciler republishes set envelope entity_version=null and carry the
    // real version here so cached_internal_agents.entity_version is still
    // populated correctly. Live publishers leave this undefined.
    entityVersion?: number;
  };
  const effectiveEntityVersion = payload.entityVersion ?? event.entity_version ?? null;

  // Update cached internal agent metadata
  const updates: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (payload.role !== undefined) {
    updates.push(`role = $${paramIndex++}`);
    values.push(payload.role);
  }
  if (payload.integrations !== undefined) {
    updates.push(`integrations = $${paramIndex++}`);
    values.push(JSON.stringify(payload.integrations));
  }
  // COALESCE preserves existing value if effectiveEntityVersion is null
  // (happens when a legacy event has no envelope entity_version AND no payload
  // entityVersion). Otherwise we write the real version.
  updates.push(`entity_version = COALESCE($${paramIndex++}, entity_version)`);
  values.push(effectiveEntityVersion);
  updates.push(`synced_at = NOW()`);

  values.push(internalAgentId);
  values.push(tenantId);

  await subscriberPool.query(
    `UPDATE cached_internal_agents SET ${updates.join(', ')}
     WHERE internal_agent_id = $${paramIndex++} AND tenant_id = $${paramIndex}`,
    values
  );

  // Mirror every payload-carried agent column onto the local agents table
  // when present. The trigger_config mirror is load-bearing — scheduler and
  // event-registration code read agents.trigger_config — but every other
  // column also has live read paths:
  //   * system_prompt / user_instructions: chat-turn-handler, suggestion
  //     applier, agent-lifecycle/repository, validation-rig.
  //   * model_config: provider-resolution (selects LLM tier), chat-turn-handler.
  //   * exec_config: research-scheduler.
  //   * memory_scope: chat-turn-handler, tool-proxy-router.
  //   * role / name: tool-gateway/mcp-server (delegate name listings),
  //     internal-agent-handler, notifications-send-handler, agent-execution.
  //   * instructions_md: prompt assembly, audit context.
  //
  // Previously only instructions_md / trigger_config were mirrored,
  // so every other column stayed at its bootstrap value forever. Any
  // user edit (rename, model swap, prompt refresh, memory-scope change,
  // research-interval change) silently failed to take effect on those paths.
  // PB's buildInternalAgentEventPayload already emits all these fields on
  // every internal_agent.updated event (see event-payload.ts).
  const agentUpdates: string[] = [];
  const agentValues: unknown[] = [tenantId, internalAgentId];
  let agentParamIdx = 3;

  if (payload.name !== undefined || payload.role !== undefined) {
    // name and role are both derived from agent.role on the PB side
    // (event-payload.ts emits `name: agent.role, role: agent.role`).
    agentUpdates.push(`name = $${agentParamIdx++}`);
    agentValues.push(payload.name ?? payload.role);
    agentUpdates.push(`role = $${agentParamIdx++}`);
    agentValues.push(payload.role ?? payload.name);
  }
  if (payload.systemPrompt !== undefined) {
    agentUpdates.push(`system_prompt = $${agentParamIdx++}`);
    agentValues.push(payload.systemPrompt);
  }
  if (payload.userInstructions !== undefined) {
    agentUpdates.push(`user_instructions = $${agentParamIdx++}`);
    agentValues.push(payload.userInstructions);
  }
  if (payload.modelConfig !== undefined) {
    agentUpdates.push(`model_config = $${agentParamIdx++}`);
    agentValues.push(JSON.stringify(payload.modelConfig));
  }
  if (payload.execConfig !== undefined) {
    agentUpdates.push(`exec_config = $${agentParamIdx++}`);
    agentValues.push(JSON.stringify(payload.execConfig));
  }
  if (payload.memoryScope !== undefined) {
    agentUpdates.push(`memory_scope = $${agentParamIdx++}`);
    agentValues.push(JSON.stringify(payload.memoryScope));
  }
  if (payload.hitlLevel !== undefined) {
    agentUpdates.push(`hitl_level = $${agentParamIdx++}`);
    agentValues.push(payload.hitlLevel);
  }
  // Workflow steps, on the path that actually fires.
  //
  // `force-republish` and every ordinary agent edit publish
  // `internal_agent.updated`, which lands here — not on the
  // `runtime_config_updated` handler. Adding the column there and not here left
  // `agents.workflow_steps` NULL through a republish that returned 200, which is
  // how this was caught: 11 steps upstream, nothing downstream, no error
  // anywhere.
  //
  // Same three-outcome decision as the other sites, and the same refusal on a
  // hash mismatch, so an agent cannot end up with verified steps by one route
  // and unverified steps by another.
  const updateArrival = decideWorkflowStepsArrival(payload);
  if (updateArrival.action === 'leave' && updateArrival.reason === 'hash_mismatch') {
    logger.error('Rejected workflow steps on agent update: hash does not match the steps', {
      tenant_id: tenantId,
      internal_agent_id: internalAgentId,
      detail: updateArrival.detail,
    });
  }
  if (updateArrival.action !== 'leave') {
    agentUpdates.push(`workflow_steps = $${agentParamIdx++}`);
    agentValues.push(updateArrival.action === 'set' ? JSON.stringify(updateArrival.steps) : null);
  }
  if (payload.workflowStepsHash !== undefined) {
    agentUpdates.push(`workflow_steps_hash = $${agentParamIdx++}`);
    agentValues.push(payload.workflowStepsHash);
  }
  if (payload.instructionsMd !== undefined) {
    agentUpdates.push(`instructions_md = $${agentParamIdx++}`);
    agentValues.push(payload.instructionsMd);
  }
  if (payload.triggerConfig !== undefined) {
    agentUpdates.push(`trigger_config = $${agentParamIdx++}`);
    agentValues.push(
      payload.triggerConfig === null ? null : JSON.stringify(payload.triggerConfig),
    );
  }

  if (agentUpdates.length > 0) {
    agentUpdates.push('updated_at = NOW()');
    await subscriberPool.query(
      `UPDATE agents SET ${agentUpdates.join(', ')}
       WHERE id = (SELECT agent_id FROM internal_agent_runtime_mapping WHERE internal_agent_id = $2)
         AND tenant_id = $1`,
      agentValues
    );
  }

  // Map internal_agent_id → agent_id. If updated arrived before created (out-of-order
  // Pub/Sub delivery with no ordering keys), bootstrap the full agent record now so the
  // agent is immediately usable. The created event will arrive later and be handled
  // idempotently — existing mapping found → skip (or activate if still DRAFT).
  const mappingResult = await subscriberPool.query(
    `SELECT agent_id FROM internal_agent_runtime_mapping
     WHERE internal_agent_id = $1 AND tenant_id = $2`,
    [internalAgentId, tenantId]
  );

  let resolvedAgentId: string | null = null;
  let bootstrapped = false;

  if (mappingResult.rows.length === 0) {
    logger.warn('No runtime mapping for agent on update — bootstrapping from updated payload', {
      tenant_id: tenantId,
      internal_agent_id: internalAgentId,
    });
    const bootstrapId = uuidv4();
    const bootstrapClient = await subscriberPool.connect();
    try {
      await bootstrapClient.query('BEGIN');
      await bootstrapClient.query(
        `INSERT INTO agents
         (id, tenant_id, name, lifecycle, runtime_status, agent_type, hitl_level,
          model_config, exec_config, memory_scope, trigger_config, system_prompt,
          user_instructions, workflow_steps_hash, workflow_steps,
          instructions_md, role, messaging_nickname, created_at, updated_at)
         VALUES ($1,$2,$3,'DRAFT','IDLE','agent',$4,'{}','{}','{}',$5,$6,$7,$10,$11,$8,$9,NULL,NOW(),NOW())
         ON CONFLICT (id) DO NOTHING`,
        [
          bootstrapId, tenantId,
          payload.role || 'Unnamed Agent',
          payload.hitlLevel ?? 3,
          payload.triggerConfig ? JSON.stringify(payload.triggerConfig) : null,
          payload.systemPrompt || '',
          payload.userInstructions || '',
          payload.instructionsMd || null,
          payload.role || 'Unnamed Agent',
          // The hash was hardcoded NULL here and the steps were not carried at
          // all. This branch only fires on out-of-order delivery — an update
          // arriving before its create — and the later create is skipped
          // idempotently once the mapping exists, so an agent bootstrapped this
          // way would have sat without steps until some unrelated future update
          // happened to carry them.
          updateArrival.action === 'set' ? payload.workflowStepsHash ?? null : null,
          updateArrival.action === 'set' ? JSON.stringify(updateArrival.steps) : null,
        ]
      );
      await bootstrapClient.query(
        `INSERT INTO internal_agent_runtime_mapping (internal_agent_id, agent_id, tenant_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (internal_agent_id) DO NOTHING`,
        [internalAgentId, bootstrapId, tenantId]
      );
      // Upsert cached row — the UPDATE above was a no-op since no row existed yet.
      await bootstrapClient.query(
        `INSERT INTO cached_internal_agents
         (internal_agent_id, tenant_id, role, status, integrations, entity_version, synced_at)
         VALUES ($1, $2, $3, 'active', $4, $5, NOW())
         ON CONFLICT (internal_agent_id) DO UPDATE SET
           role = EXCLUDED.role, status = EXCLUDED.status,
           integrations = EXCLUDED.integrations, entity_version = EXCLUDED.entity_version,
           synced_at = NOW()`,
        [internalAgentId, tenantId, payload.role, JSON.stringify(payload.integrations || []), effectiveEntityVersion ?? 0]
      );
      await bootstrapClient.query('COMMIT');
      resolvedAgentId = bootstrapId;
      bootstrapped = true;
      logger.info('Bootstrapped agent record from updated payload', {
        tenant_id: tenantId,
        internal_agent_id: internalAgentId,
        agent_id: bootstrapId,
      });
    } catch (bootstrapError) {
      await bootstrapClient.query('ROLLBACK');
      logger.error('Failed to bootstrap agent from updated payload', {
        tenant_id: tenantId,
        internal_agent_id: internalAgentId,
        error: (bootstrapError as Error).message,
      });
    } finally {
      bootstrapClient.release();
    }
  } else {
    resolvedAgentId = mappingResult.rows[0].agent_id;
  }

  // Rebuild compiled_instructions when distilled content changes (re-distill, rollback, or bootstrap).
  const hasDistilledContent =
    payload.systemPrompt !== undefined ||
    payload.userInstructions !== undefined ||
    payload.hitlLevel !== undefined;

  if (hasDistilledContent && resolvedAgentId) {
    try {
      // createAndActivateForInternalAgent supersedes any existing active row and
      // inserts a new one with incremented version + status='active'.
      const newInstructionId = await internalAgentInstructionService.createAndActivateForInternalAgent({
        tenantId,
        agentId: resolvedAgentId,
        idempotencyKey: event.event_id,
        systemPrompt: payload.systemPrompt ?? '',
        userInstructions: payload.userInstructions ?? '',
        hitlLevel: payload.hitlLevel ?? 3,
        // Spread (...i) preserves per-binding config (gmailQuery,
        // outlookFilter, sendAs) so it reaches compiled_instructions and the
        // tool-gateway's binding resolver. Destructuring to { id, type,
        // selectedObjects } here previously stripped .config on every
        // .updated event (including every redistill), leaving Gmail/Outlook
        // agents polling unscoped. `selectedObjects: ... ?? []` satisfies the
        // receiver's required-field type without losing other payload fields.
        integrations: (payload.integrations ?? []).map((i) => ({
          ...i,
          selectedObjects: i.selectedObjects ?? [],
        })),
        triggerConfig: payload.triggerConfig
          ? {
              type: payload.triggerConfig.type as 'cron' | 'event',
              cronExpr: payload.triggerConfig.cronExpr,
              eventTopic: payload.triggerConfig.eventTopic,
            }
          : undefined,
        instructionsMd: payload.instructionsMd ?? null,
        capabilityTier: payload.capabilityTier as 'connector_only' | 'execution_enabled' | undefined,
        resultRules: payload.resultRules,
        toolDescriptionOverrides: payload.toolDescriptionOverrides,
        groundsOn: payload.groundsOn,
        capabilityStates: payload.capabilityStates,
        skills: payload.skills,
        pinnedKnowledgeIds: payload.pinnedKnowledgeIds ?? [],
      });

      // Activate the lifecycle if the agent is still DRAFT.  This covers two cases:
      // 1. We bootstrapped the agent from the updated payload (created event not yet seen).
      // 2. The inline-activation on the created event lost the concurrent-INSERT race.
      //    The race is now handled gracefully in createAndActivateForInternalAgent
      //    (ON CONFLICT DO NOTHING), so the inline path will also call activate().
      //    Calling activate() here as well is safe — it is idempotent on ACTIVE agents.
      const agentRow = await subscriberPool.query(
        `SELECT lifecycle FROM agents WHERE id = $1`,
        [resolvedAgentId],
      );
      const agentLifecycle = agentRow.rows[0]?.lifecycle as string | undefined;
      if (agentLifecycle === 'DRAFT') {
        await agentLifecycleService.activate(resolvedAgentId);
        await agentLifecycleService.ensureSchedulerJob(resolvedAgentId);
      } else if (payload.triggerConfig !== undefined && agentLifecycle === 'ACTIVE') {
        // Trigger flipped on an already-ACTIVE agent (typical case: re-distill
        // produced a new primary trigger — e.g. cron → event after the prompt
        // bias fix landed). Re-run ensureSchedulerJob so the runtime side
        // converges: registers the agent on the new event topic, or creates
        // /resumes the cron job for the new cadence. Without this, the cron
        // scheduler stayed at the prior cadence forever and event-trigger
        // registration never happened — re-distill silently became a no-op
        // for the scheduling layer.
        try {
          await agentLifecycleService.ensureSchedulerJob(resolvedAgentId);
        } catch (err) {
          logger.warn(
            { tenant_id: tenantId, agent_id: resolvedAgentId, err: (err as Error).message },
            'ensureSchedulerJob after trigger update failed (reconciler will retry next tick)',
          );
        }
      }

      logger.info('Rebuilt compiled_instructions on agent update', {
        tenant_id: tenantId,
        internal_agent_id: internalAgentId,
        agent_id: resolvedAgentId,
        new_instruction_id: newInstructionId,
        rollback: payload.rollbackFromVersion !== undefined,
        bootstrapped,
        lifecycleActivated: agentLifecycle === 'DRAFT',
      });
    } catch (err) {
      logger.error('Failed to rebuild compiled_instructions on agent update', {
        tenant_id: tenantId,
        internal_agent_id: internalAgentId,
        agent_id: resolvedAgentId,
        error: (err as Error).message,
      });
      // Don't throw — the cached_internal_agents / agents table updates already
      // succeeded. The compiled_instructions rebuild failing is retryable via backfill.
    }
  }

  logger.info('Cached internal agent updated', {
    tenant_id: tenantId,
    internal_agent_id: internalAgentId,
    entity_version: event.entity_version,
    rollback: payload.rollbackFromVersion !== undefined,
    compiledInstructionsRebuilt: hasDistilledContent,
    bootstrapped,
  });
}

// Handle skills backfill event — inserts skills for an existing agent without
// touching compiled_instructions. Fired by the platform-backend backfill runner.
// Handle internal agent deleted event
// SE-002: Archives agent with tenant validation
async function handleInternalAgentDeleted(event: ControlPlaneEvent): Promise<void> {
  const tenantId = event.tenant_id!;
  const internalAgentId = event.entity_id;

  // Validate tenant isolation (SE-002)
  if (!tenantId) {
    logger.error('Internal agent deleted event missing tenantId', { internalAgentId });
    return;
  }

  const dbPool = subscriberPool;

  // Look up agent via mapping with tenant validation
  const mappingResult = await dbPool.query(
    `SELECT agent_id FROM internal_agent_runtime_mapping
     WHERE internal_agent_id = $1 AND tenant_id = $2`,
    [internalAgentId, tenantId]
  );

  if (mappingResult.rows.length === 0) {
    logger.warn('No agent mapping found for deleted internal agent', { internal_agent_id: internalAgentId, tenant_id: tenantId });
    // Still mark cache as deleted
    await dbPool.query(
      `UPDATE cached_internal_agents SET status = 'deleted', synced_at = NOW()
       WHERE internal_agent_id = $1 AND tenant_id = $2`,
      [internalAgentId, tenantId]
    );
    return;
  }

  const agentId = mappingResult.rows[0].agent_id;

  try {
    // Archive agent (deletes Cloud Scheduler job)
    await agentLifecycleService.archive(agentId);

    // Mark cache as deleted
    await dbPool.query(
      `UPDATE cached_internal_agents SET status = 'deleted', synced_at = NOW()
       WHERE internal_agent_id = $1 AND tenant_id = $2`,
      [internalAgentId, tenantId]
    );

    logger.info('Internal agent deleted and agent archived', {
      internal_agent_id: internalAgentId,
      agent_id: agentId,
      tenant_id: tenantId,
    });

    // R5 Fix 1: trigger an immediate chat-workspace reaper sweep. The reaper's
    // tombstone TOCTOU guard skips live threads and evicts stale workspaces
    // under /tmp/chat-threads/<tenantId>/. This accelerates cleanup that the
    // periodic reaper would otherwise catch within 30 minutes.
    try {
      const { reapStaleChatWorkspaces } = await import('../agent-execution/engine/workspace-reaper');
      const { scrubLogger } = await import('../observability/scrub-logger');
      // Fire-and-forget; failures non-fatal
      reapStaleChatWorkspaces(
        { maxDurationMs: 15_000 },
        { pool: dbPool, logger: scrubLogger },
      ).catch((err: Error) => {
        logger.warn('Post-delete chat workspace sweep failed (non-fatal)', {
          tenant_id: tenantId,
          error: err.message,
        });
      });
    } catch {
      // Non-fatal
    }
  } catch (error) {
    logger.error('Failed to archive agent for deleted internal agent', {
      internal_agent_id: internalAgentId,
      agent_id: agentId,
      tenant_id: tenantId,
      error: (error as Error).message,
    });
    throw error;
  }
}

/** The status a status_changed event carries, under either name the control
 *  plane uses for it (see the payload type below).
 *
 *  Throws when neither name holds a status this handler knows. An event whose
 *  meaning cannot be read must not be acked as handled: nacking redelivers it
 *  and, failing that, parks it in the DLQ where a person sees it. A silent ack
 *  is what let a broken pause/resume path run for three months. The control
 *  plane's status column is exactly these three values, so anything else is a
 *  contract break, not a status this runtime should shrug at. */
function resolveInternalAgentStatus(
  payload: { newStatus?: unknown; status?: unknown },
  internalAgentId: string,
): 'active' | 'paused' | 'draft' {
  const raw = payload.newStatus ?? payload.status;
  if (raw === 'active' || raw === 'paused' || raw === 'draft') return raw;
  throw new Error(
    `internal_agent.status_changed for ${internalAgentId} carries no readable status ` +
    `(newStatus=${JSON.stringify(payload.newStatus)}, status=${JSON.stringify(payload.status)})`,
  );
}

// Handle internal agent status changed event
// BE-002, BE-006: Activate/pause with rollback support
async function handleInternalAgentStatusChanged(event: ControlPlaneEvent): Promise<void> {
  const tenantId = event.tenant_id!;
  const internalAgentId = event.entity_id;
  const payload = event.payload as {
    previousStatus?: string;
    // Two names for one fact. The control plane published `newStatus` until it
    // moved this event onto the transactional outbox, after which its payload
    // builder has called the field `status`. Reading only `newStatus` made
    // every pause and every resume a silent no-op here: the branches below
    // both missed, the handler returned, and Pub/Sub got a clean ack. The only
    // surviving sync was the 5-minute canonical reconciler, so a person who
    // pressed Resume and immediately opened chat was told the agent was still
    // paused. Accept both names; `resolveStatus` below refuses to guess when
    // neither is present.
    newStatus?: 'active' | 'paused' | 'draft';
    status?: 'active' | 'paused' | 'draft';
    agentType?: string;
    hitlLevel?: number;
    modelConfig?: Record<string, unknown>;
    execConfig?: Record<string, unknown>;
    memoryScope?: Record<string, unknown>;
    systemPrompt?: string;
    userInstructions?: string;
    capabilityTier?: 'connector_only' | 'execution_enabled';  // R5: shell/file tool gating
    // Per-tool result-handling policy from distillation. Travels beside
    // capabilityTier on every payload that compiles an instruction, because a
    // policy that reaches only some of those paths is a policy the agent has on
    // some days.
    resultRules?: Array<{ toolName: string; requiresComplete: boolean }>;
    /** Per-tool rules the control plane decided at distillation. Full-replace
     *  on every publish, exactly like resultRules above. */
    toolDescriptionOverrides?: Record<string, string>;
    /** Declared grounding rules, same lifecycle. */
    groundsOn?: Array<{ label: string; terms: string[]; cues: string[]; toolName: string; enabled: boolean }>;
    /** Per-capability tri-state, same lifecycle. */
    capabilityStates?: Record<string, 'live' | 'unwired' | 'absent'>;
    instructionsMd?: string;
    triggerConfig?: { type: string; cronExpr?: string; eventTopic?: string } | null;
    integrations?: Array<{ id: string; selectedObjects: string[] }>;
    pinnedKnowledgeIds?: string[];           // Knowledge items pinned via [[knowledge:...]] markers
    // Reconciler republishes envelope entity_version=null + payload.entityVersion=N.
    entityVersion?: number;
  };
  const effectiveEntityVersion = payload.entityVersion ?? event.entity_version ?? null;

  if (!tenantId) {
    logger.error('Internal agent status changed event missing tenantId', { internalAgentId });
    return;
  }

  const newStatus = resolveInternalAgentStatus(payload, internalAgentId);

  // Look up agent via mapping (no FOR UPDATE — ledger claim handles serialization)
  const mappingResult = await subscriberPool.query(
    `SELECT agent_id FROM internal_agent_runtime_mapping
     WHERE internal_agent_id = $1 AND tenant_id = $2`,
    [internalAgentId, tenantId]
  );

  if (mappingResult.rows.length === 0) {
    logger.error('No agent mapping found for internal agent', { internal_agent_id: internalAgentId, tenant_id: tenantId });
    await subscriberPool.query(
      `UPDATE cached_internal_agents SET status = $1, entity_version = COALESCE($2, entity_version), synced_at = NOW()
       WHERE internal_agent_id = $3 AND tenant_id = $4`,
      [newStatus, effectiveEntityVersion, internalAgentId, tenantId]
    );
    return;
  }

  const agentId = mappingResult.rows[0].agent_id;

  if (newStatus === 'active') {
    // Activation: 5 idempotent steps tracked by EventProcessor
    const result = await eventProcessor.process(event, [
      {
        name: 'create_instruction',
        execute: async (ctx) => {
          // Check for existing active instruction (handles control-plane re-publish)
          const existingActive = await ctx.pool.query(
            `SELECT id FROM compiled_instructions
             WHERE agent_id = $1 AND tenant_id = $2 AND status = 'active'
             ORDER BY version DESC LIMIT 1`,
            [agentId, tenantId]
          );
          if (existingActive.rows.length > 0) {
            ctx.metadata.instructionId = existingActive.rows[0].id;
            return;
          }
          const instructionId = await internalAgentInstructionService.createAndActivateForInternalAgent({
            tenantId,
            agentId,
            idempotencyKey: event.event_id,
            systemPrompt: payload.systemPrompt,
            userInstructions: payload.userInstructions,
            hitlLevel: payload.hitlLevel,
            integrations: payload.integrations,
            triggerConfig: payload.triggerConfig ? {
              type: payload.triggerConfig.type as 'cron' | 'event',
              cronExpr: payload.triggerConfig.cronExpr,
              eventTopic: payload.triggerConfig.eventTopic,
            } : undefined,
            instructionsMd: payload.instructionsMd ?? null,
            capabilityTier: payload.capabilityTier as 'connector_only' | 'execution_enabled' | undefined,
            resultRules: payload.resultRules,
            toolDescriptionOverrides: payload.toolDescriptionOverrides,
            groundsOn: payload.groundsOn,
            capabilityStates: payload.capabilityStates,
            pinnedKnowledgeIds: payload.pinnedKnowledgeIds ?? [],
          });
          ctx.metadata.instructionId = instructionId;
        },
      },
      {
        name: 'persist_trigger_config',
        execute: async (ctx) => {
          if (payload.triggerConfig) {
            await ctx.pool.query(
              `UPDATE agents SET trigger_config = $1, updated_at = NOW() WHERE id = $2`,
              [JSON.stringify(payload.triggerConfig), agentId]
            );
          }
        },
      },
      {
        name: 'activate_lifecycle',
        execute: async () => {
          await agentLifecycleService.activate(agentId);
        },
      },
      {
        name: 'ensure_scheduler',
        execute: async () => {
          await agentLifecycleService.ensureSchedulerJob(agentId);
        },
      },
      {
        name: 'update_cache',
        execute: async (ctx) => {
          await ctx.pool.query(
            `UPDATE cached_internal_agents SET status = $1, entity_version = COALESCE($2, entity_version), synced_at = NOW()
             WHERE internal_agent_id = $3 AND tenant_id = $4`,
            [newStatus, effectiveEntityVersion, internalAgentId, tenantId]
          );
        },
      },
    ]);

    // result === false means the SAME event_id is already being processed
    // by a sibling instance — that instance is doing the work, so we ack
    // (return from this handler, subscriber acks). The DIFFERENT-event-for-
    // same-entity case is now signalled by EntityBusyError which the
    // subscriber-level catch nacks for redelivery.
    if (result === false) return;

  } else if (newStatus === 'paused') {
    // Pause: 3 idempotent steps tracked by EventProcessor
    const result = await eventProcessor.process(event, [
      {
        name: 'pause_lifecycle',
        execute: async () => {
          await agentLifecycleService.pause(agentId);
        },
      },
      {
        name: 'cancel_tasks',
        execute: async (ctx) => {
          await ctx.pool.query(
            `UPDATE workflow_tasks SET status = 'cancelled',
             cancelled_at = NOW(), cancellation_reason = 'Agent paused'
             WHERE agent_id = $1 AND tenant_id = $2 AND status IN ('pending', 'running')`,
            [agentId, tenantId]
          );
        },
      },
      {
        name: 'update_cache',
        execute: async (ctx) => {
          await ctx.pool.query(
            `UPDATE cached_internal_agents SET status = $1, entity_version = COALESCE($2, entity_version), synced_at = NOW()
             WHERE internal_agent_id = $3 AND tenant_id = $4`,
            [newStatus, effectiveEntityVersion, internalAgentId, tenantId]
          );
        },
      },
    ]);

    if (result === false) return;
  }
}

// Handle external agent created/updated/rediscovered events
// Clears local config cache to force re-fetch from control plane
async function handleExternalAgentUpdated(event: ControlPlaneEvent): Promise<void> {
  const tenantId = event.tenant_id!;
  const externalAgentId = event.entity_id;

  // Import handler to clear cache
  const { externalAgentHandler } = await import('../tool-gateway/external-agent-handler');

  // Clear config cache for this external agent
  const cacheKey = `${tenantId}:${externalAgentId}`;
  externalAgentHandler.clearConfigCache(cacheKey);

  logger.info('Cleared external agent config cache on update event', {
    tenant_id: tenantId,
    external_agent_id: externalAgentId,
    event_type: event.event_type,
    entity_version: event.entity_version,
  });
}

// Handle external agent deleted event
async function handleExternalAgentDeleted(event: ControlPlaneEvent): Promise<void> {
  const tenantId = event.tenant_id!;
  const externalAgentId = event.entity_id;

  // Import handler to clear cache
  const { externalAgentHandler } = await import('../tool-gateway/external-agent-handler');

  // Clear config cache for this external agent
  const cacheKey = `${tenantId}:${externalAgentId}`;
  externalAgentHandler.clearConfigCache(cacheKey);

  logger.info('Cleared external agent config cache on delete event', {
    tenant_id: tenantId,
    external_agent_id: externalAgentId,
    entity_version: event.entity_version,
  });
}

// Handle external agent credentials stored event
// Security: Credentials are already stored in Secret Manager by the control plane
// This handler stores credential reference metadata (NOT the actual credentials)
async function handleExternalAgentCredentialsStored(event: ControlPlaneEvent): Promise<void> {
  const tenantId = event.tenant_id!;
  const externalAgentId = event.entity_id;
  const payload = event.payload as {
    secretName: string;
  };

  // Store credential reference in external_agent_metadata table
  // Per implementation plan: "credentials_stored event contains only the secret reference"
  await subscriberPool.query(
    `INSERT INTO external_agent_metadata (
      external_agent_id, tenant_id, secret_name, updated_at
    )
    VALUES ($1, $2, $3, NOW())
    ON CONFLICT (external_agent_id) DO UPDATE SET
      secret_name = EXCLUDED.secret_name,
      updated_at = NOW()`,
    [externalAgentId, tenantId, payload.secretName]
  );

  // Clear config cache to ensure fresh credential fetch
  const { externalAgentHandler } = await import('../tool-gateway/external-agent-handler');
  const cacheKey = `${tenantId}:${externalAgentId}`;
  externalAgentHandler.clearConfigCache(cacheKey);

  logger.info('External agent credentials metadata updated (credentials in Secret Manager)', {
    tenant_id: tenantId,
    external_agent_id: externalAgentId,
    secret_name: payload.secretName,
  });
}

// Handle skills_updated event — re-ingests updated skills for an agent without
// bumping the compiled instruction version. Fired by platform-backend after the
// skills flywheel produces refinements.
//
// The event payload's agentId is the PLATFORM-BACKEND internal_agent_id, NOT
// the tenant-runtime agents.id. internalAgentInstructionService queries
// compiled_instructions.agent_id which references the runtime agents.id, so
// we must map first via internal_agent_runtime_mapping. Without this lookup,
// updateAgentSkillsOnly silently skips with "no active instruction" because
// the platform-backend UUID doesn't match any compiled_instructions row.
//
// (handleInternalAgentCreated does the same lookup at line 1326 — this is
// the same pattern, just previously missing here.)
async function handleInternalAgentSkillsUpdated(event: TenantScopedEvent): Promise<void> {
  const { agentId: internalAgentId, skills } = event.payload as {
    agentId: string;
    skills: unknown[];
  };
  if (!internalAgentId || !Array.isArray(skills)) {
    logger.warn({ event_id: event.event_id }, 'skills_updated: missing agentId or skills');
    return;
  }

  const mappingResult = await subscriberPool.query<{ agent_id: string }>(
    `SELECT agent_id FROM internal_agent_runtime_mapping
     WHERE internal_agent_id = $1 AND tenant_id = $2 LIMIT 1`,
    [internalAgentId, event.tenant_id],
  );
  if (mappingResult.rows.length === 0) {
    logger.warn(
      { event_id: event.event_id, internal_agent_id: internalAgentId, tenant_id: event.tenant_id },
      'skills_updated: no internal_agent_runtime_mapping for agent — skipping (agent never created in runtime?)',
    );
    return;
  }
  const runtimeAgentId = mappingResult.rows[0].agent_id;

  await internalAgentInstructionService.updateAgentSkillsOnly({
    tenantId: event.tenant_id,
    agentId: runtimeAgentId,
    idempotencyKey: event.event_id,
    skills: skills as Skill[],
  });
}

// Handle external agent health check failed event (EA-001)
// Clears local config cache when health check fails
async function handleExternalAgentHealthFailed(event: ControlPlaneEvent): Promise<void> {
  const tenantId = event.tenant_id!;
  const externalAgentId = event.entity_id;
  const payload = event.payload as {
    reason: string;
    timestamp: string;
  };

  // Import handler to clear cache
  const { externalAgentHandler } = await import('../tool-gateway/external-agent-handler');

  // Clear config cache for this external agent to prevent stale config usage
  const cacheKey = `${tenantId}:${externalAgentId}`;
  externalAgentHandler.clearConfigCache(cacheKey);

  logger.warn('External agent health check failed, cleared config cache', {
    tenant_id: tenantId,
    external_agent_id: externalAgentId,
    reason: payload.reason,
    failed_at: payload.timestamp,
  });
}

/**
 * Custom inbound webhook → agent invocation.
 *
 * Platform-backend's inbound router (POST /api/events/custom/:token) records
 * the delivery, scrubs/filters the envelope, and enqueues one outbox event
 * per matched trigger rule. Each event carries the resolved `agentId` plus
 * the sanitized envelope. We just need to invoke the agent with
 * `trustLevel: 'untrusted_inbound'` so the executor and tool gateway can
 * gate destructive operations and SSRF-prone tool calls regardless of the
 * agent's autonomy config.
 *
 * Mirrors the connector-event-trigger path in src/scheduling/event-trigger.ts.
 */
async function handleCustomEventReceived(event: ControlPlaneEvent): Promise<void> {
  const tenantId = event.tenant_id;
  if (!tenantId) {
    logger.warn('event.custom_received missing tenant_id, skipping', {
      event_id: event.event_id,
    });
    return;
  }

  // Wire shape produced by platform-backend's inbound router (plan §4):
  // top-level tenantId/agentId/trustLevel/harvestEligible PLUS the source
  // metadata + sanitized webhook event inside `event`.
  const payload = event.payload as {
    tenantId?: string;
    agentId?: string;
    trustLevel?: 'untrusted_inbound' | 'trusted';
    harvestEligible?: boolean;
    sourceId?: string;
    sourceName?: string;
    triggerRuleId?: string;
    deliveryId?: string;
    event?: {
      eventId: string;
      eventType: string;
      occurredAt: string;
      subject?: unknown;
      actor?: unknown;
      data?: unknown;
      contentRedacted?: boolean;
    };
    receivedAt?: string;
  } | undefined;

  const internalAgentId = payload?.agentId;
  const webhookEvent = payload?.event;
  if (!internalAgentId || !webhookEvent) {
    logger.warn('event.custom_received missing agentId or event payload, skipping', {
      event_id: event.event_id,
      tenant_id: tenantId,
      has_agent_id: !!internalAgentId,
      has_event: !!webhookEvent,
    });
    return;
  }

  // The payload's `agentId` is the PLATFORM-BACKEND internal_agent_id.
  // The runtime's `agents` table is keyed on a DIFFERENT id (the runtime
  // agent_id), bridged by `internal_agent_runtime_mapping`. The
  // executor's executeTask() and lifecycle queries both take the runtime
  // id, so we resolve here before either. See sync-state-router.ts for
  // the same JOIN pattern.
  const mapping = await subscriberPool.query<{ agent_id: string; lifecycle: string }>(
    `SELECT m.agent_id, a.lifecycle
       FROM internal_agent_runtime_mapping m
       JOIN agents a ON a.id = m.agent_id
      WHERE m.internal_agent_id = $1 AND m.tenant_id = $2
      LIMIT 1`,
    [internalAgentId, tenantId],
  );
  const mappingRow = mapping.rows[0];
  if (!mappingRow) {
    logger.info(
      'event.custom_received: no runtime mapping for internal_agent (drift); dropping',
      { event_id: event.event_id, internal_agent_id: internalAgentId, tenant_id: tenantId },
    );
    return;
  }
  const runtimeAgentId = mappingRow.agent_id;

  // Defense-in-depth: control plane already filters by agent.status='active'
  // before publishing, but the agent may have been paused since the event
  // was queued. Re-check before invoking the executor.
  if (mappingRow.lifecycle !== 'ACTIVE') {
    logger.info('event.custom_received: target agent not ACTIVE, dropping', {
      event_id: event.event_id,
      internal_agent_id: internalAgentId,
      runtime_agent_id: runtimeAgentId,
      tenant_id: tenantId,
      lifecycle: mappingRow.lifecycle,
    });
    return;
  }

  // Lazy import to avoid circular dependency
  // (event-subscriber → agent-execution → agent-lifecycle → subscriber).

  const { agentExecutionService } = require('../agent-execution/service');

  const { invocationsService } = require('../invocations/service');

  // initiatedByType uses the existing 'scheduler' value — same choice
  // src/scheduling/event-trigger.ts makes for connector-event triggers. A
  // dedicated 'webhook' value can be added once we have audit-UI affordances
  // that distinguish webhook-triggered runs from cron/event ones.
  const thread = await invocationsService.createThread({
    tenantId,
    agentId: runtimeAgentId,
    initiatedByType: 'scheduler',
    title: `Webhook: ${webhookEvent.eventType} — ${new Date().toISOString()}`,
  });

  // workflow_id / action_id columns in usage_events, workflow_escalations,
  // and the workflows table itself are typed UUID. A `webhook-wf-…` string
  // prefix made downstream INSERTs fail with `invalid input syntax for type
  // uuid`, causing the Pub/Sub push to be nacked into an infinite retry loop.
  // Use bare UUIDs; the trigger.kind discriminant is what identifies these
  // runs as webhook-originated.
  const workflowId = uuidv4();
  const taskId = uuidv4();

  // Build the objective as a short summary; the full envelope rides on
  // inputData so the executor can render it into the prompt as data, not
  // instructions. The actor field is rendered with an explicit "untrusted"
  // prefix per the plan — self-declared identity is never authoritative.
  const objective = `Process incoming ${webhookEvent.eventType} webhook event`;

  const result = await agentExecutionService.executeTask({
    tenantId,
    agentId: runtimeAgentId,
    workflowId,
    taskId,
    // Run-level idempotency (§4.7): the control-plane event_id is stable across
    // Pub/Sub redelivery, so a redelivered webhook does not re-run the agent.
    // (workflowId/taskId above are fresh per delivery and are NOT usable here.)
    triggerKey: `evt:${event.event_id}:${runtimeAgentId}`,
    onConflict: 'defer',
    objective,
    threadId: thread.id,
    triggeredBy: 'event',
    // Plan §4: forward the trigger as a discriminated-union value so the
    // executor can derive trustLevel, log the trigger kind on every audit
    // row, and (in future) apply per-kind behavior without re-checking
    // an opaque trustLevel field.
    trigger: {
      kind: 'custom_event',
      trustLevel: 'untrusted_inbound',
      source: {
        sourceId: payload?.sourceId ?? '',
        sourceName: payload?.sourceName ?? '',
        triggerRuleId: payload?.triggerRuleId ?? '',
        deliveryId: payload?.deliveryId ?? '',
      },
      event: {
        eventId: webhookEvent.eventId,
        eventType: webhookEvent.eventType,
        occurredAt: webhookEvent.occurredAt,
        subject: webhookEvent.subject ?? null,
        actor: webhookEvent.actor ?? null,
        data: webhookEvent.data ?? null,
        contentRedacted: webhookEvent.contentRedacted ?? false,
      },
      receivedAt: payload?.receivedAt ?? new Date().toISOString(),
    },
    inputData: {
      webhookEvent: {
        eventId: webhookEvent.eventId,
        eventType: webhookEvent.eventType,
        occurredAt: webhookEvent.occurredAt,
        subject: webhookEvent.subject ?? null,
        actor: webhookEvent.actor ?? null,
        data: webhookEvent.data ?? null,
        contentRedacted: webhookEvent.contentRedacted ?? false,
      },
      sourceId: payload?.sourceId ?? null,
      sourceName: payload?.sourceName ?? null,
      triggerRuleId: payload?.triggerRuleId ?? null,
      deliveryId: payload?.deliveryId ?? null,
      // Harvest pipeline MUST skip webhook-triggered runs — plan §6.4.
      harvestEligible: payload?.harvestEligible ?? false,
    },
  });

  if (!result.deferred) {
    await invocationsService.updateThreadStatus(
      thread.id,
      tenantId,
      THREAD_STATUS_BY_TERMINAL[resolveTerminalState(result, false)],
    );
  }

  logger.info('event.custom_received: agent invocation completed', {
    event_id: event.event_id,
    tenant_id: tenantId,
    internal_agent_id: internalAgentId,
    runtime_agent_id: runtimeAgentId,
    delivery_id: payload?.deliveryId,
    thread_id: thread.id,
    success: result.success,
  });
}
