// Governance events Pub/Sub subscriber.
//
// Phase 3: governance-engine publishes a family of events to the multiplexed
// topic `governance-events-{ENV}`. Messages carry an `eventType` attribute
// so subscribers can demultiplex a single shared topic. Tenant-runtime owns
// the reflection + learning loop, so it subscribes here and fans out to the
// right handler based on eventType.
//
// Supported event types (dispatch table below):
//   governance.kill_switch_changed   → invalidate preflight cache
//   governance.correction_captured   → learning/correction-capture
//   governance.late_feedback_flagged → reflection trigger (flagged_feedback)
//   governance.action_compensated    → unsubscribed; see the handler map
//
// Any other event type is acked and logged at warn level. The parent topic
// is shared across services — unknown types are not an error, they're just
// "not ours".

import { PubSub, Message } from '@google-cloud/pubsub';
import { invalidatePreflight } from './preflight-cache';
import { captureFromGovernanceEvent } from '../learning/correction-capture';
import { reflectionTriggerService } from '../reflection-engine/trigger-service';
import { logger } from '../infrastructure/logging';

// Event type literals — kept in sync with the governance-engine publisher.
export const GOVERNANCE_EVENT_TYPES = {
  KILL_SWITCH_CHANGED: 'governance.kill_switch_changed',
  CORRECTION_CAPTURED: 'governance.correction_captured',
  LATE_FEEDBACK_FLAGGED: 'governance.late_feedback_flagged',
  ACTION_COMPENSATED: 'governance.action_compensated',
} as const;

export type GovernanceEventType =
  (typeof GOVERNANCE_EVENT_TYPES)[keyof typeof GOVERNANCE_EVENT_TYPES];

// Base envelope — every event carries a tenantId. Event-specific fields are
// narrowed in each handler.
interface GovernanceEventEnvelope {
  tenantId?: string;
  agentId?: string;
  actionId?: string;
  feedbackId?: string;
  switchName?: string;
  state?: unknown;
  correctionType?: string;
  correctionPayload?: unknown;
  [key: string]: unknown;
}

type Handler = (payload: GovernanceEventEnvelope, messageId: string) => Promise<void>;

let pubsub: PubSub | null = null;
let started = false;

function parseEnvelope(raw: Buffer): GovernanceEventEnvelope | null {
  try {
    const data = JSON.parse(raw.toString('utf8')) as unknown;
    if (!data || typeof data !== 'object') return null;
    return data as GovernanceEventEnvelope;
  } catch {
    return null;
  }
}

// ─── Handlers ────────────────────────────────────────────────────────────────

async function handleKillSwitchChanged(
  payload: GovernanceEventEnvelope,
  _messageId: string,
): Promise<void> {
  if (!payload.tenantId) return;
  invalidatePreflight(payload.tenantId);
  logger.info(
    {
      event: 'governance_kill_switch_invalidated',
      tenantId: payload.tenantId,
      switchName: payload.switchName,
    },
    'governance kill-switch: preflight cache invalidated',
  );
}

async function handleCorrectionCaptured(
  payload: GovernanceEventEnvelope,
  _messageId: string,
): Promise<void> {
  await captureFromGovernanceEvent({
    tenantId: payload.tenantId,
    agentId: payload.agentId,
    actionId: payload.actionId,
    correctionType: payload.correctionType,
    correctionPayload: payload.correctionPayload,
  });
}

async function handleLateFeedbackFlagged(
  payload: GovernanceEventEnvelope,
  _messageId: string,
): Promise<void> {
  if (!payload.tenantId || !payload.agentId || !payload.feedbackId) {
    logger.warn(
      {
        event: 'governance_late_feedback_missing_fields',
        tenantId: payload.tenantId,
        agentId: payload.agentId,
        feedbackId: payload.feedbackId,
      },
      'governance late_feedback_flagged: missing required fields; skipping',
    );
    return;
  }
  await reflectionTriggerService.onLateFeedbackFlagged(
    payload.agentId,
    payload.tenantId,
    payload.feedbackId,
  );
}


// Dispatch table. Exported so tests can assert routing without touching
// Pub/Sub. Order of lookup: attribute `eventType` → handler.
export const governanceEventHandlers: Record<string, Handler> = {
  [GOVERNANCE_EVENT_TYPES.KILL_SWITCH_CHANGED]: handleKillSwitchChanged,
  [GOVERNANCE_EVENT_TYPES.CORRECTION_CAPTURED]: handleCorrectionCaptured,
  [GOVERNANCE_EVENT_TYPES.LATE_FEEDBACK_FLAGGED]: handleLateFeedbackFlagged,
  // ACTION_COMPENSATED is deliberately unsubscribed. Its only handler existed
  // to fire the `repeated_undos` reflection trigger, which was retired: the
  // counter behind it reads `actions.status='compensated'`, production holds
  // zero such rows, and compensation is reachable only through a coordinator
  // API method. A trigger that cannot fire reads as coverage. Re-subscribe
  // when compensation is a path agents actually take, and give it a counter
  // that is written by that path.
};

// Exported for unit testing — runs the dispatch logic on a synthetic message.
// Returns { acked: true } after a handler runs (or an ack-and-drop path) and
// { acked: false } if the caller should nack (handler threw).
export async function dispatchGovernanceEvent(
  eventType: string | undefined,
  payload: GovernanceEventEnvelope | null,
  messageId: string,
): Promise<{ acked: boolean; reason?: string }> {
  if (!eventType) {
    logger.warn(
      { event: 'governance_event_missing_type', messageId },
      'governance event: missing eventType attribute; acking',
    );
    return { acked: true, reason: 'missing_event_type' };
  }

  const handler = governanceEventHandlers[eventType];
  if (!handler) {
    logger.warn(
      { event: 'governance_event_unknown_type', eventType, messageId },
      'governance event: unknown eventType; acking',
    );
    return { acked: true, reason: 'unknown_event_type' };
  }

  if (!payload || !payload.tenantId) {
    logger.warn(
      { event: 'governance_event_bad_envelope', eventType, messageId },
      'governance event: malformed envelope; acking',
    );
    return { acked: true, reason: 'bad_envelope' };
  }

  try {
    await handler(payload, messageId);
    return { acked: true };
  } catch (err) {
    logger.error(
      {
        event: 'governance_event_handler_failed',
        eventType,
        tenantId: payload.tenantId,
        error: (err as Error).message,
      },
      'governance event handler failed; nacking',
    );
    return { acked: false, reason: 'handler_error' };
  }
}

export async function startGovernanceEventsSubscriber(): Promise<void> {
  if (started) return;
  started = true;

  const environment = process.env.ENVIRONMENT || 'dev';
  const topicName = `governance-events-${environment}`;
  // Phase 4: when split, agent-service (and monolith as legacy) own this
  // subscriber. If other services grow a need to subscribe independently,
  // suffix SERVICE_TYPE to give each its own subscription for fan-out. The
  // monolith keeps the original subscription name to avoid a rename +
  // dangling-subscription cleanup during rollout.
  const svcType = process.env.SERVICE_TYPE || 'monolith';
  const subSuffix = svcType === 'monolith' ? 'tenant-runtime' : svcType;
  const subscriptionName = `${topicName}-${subSuffix}-sub`;

  pubsub = new PubSub();
  const subscription = pubsub.subscription(subscriptionName, {
    flowControl: { maxMessages: 8, allowExcessMessages: false },
  });

  subscription.on('message', (message: Message) => {
    const eventType =
      message.attributes?.eventType ?? message.attributes?.event_type;
    const envelope = parseEnvelope(message.data);

    void dispatchGovernanceEvent(eventType, envelope, message.id).then((res) => {
      if (res.acked) {
        message.ack();
      } else {
        message.nack();
      }
    });
  });

  subscription.on('error', (err) => {
    logger.error(
      {
        event: 'governance_events_subscription_error',
        error: (err as Error).message,
      },
      'governance events subscription error',
    );
  });

  logger.info(
    { event: 'governance_events_subscribed', subscription: subscriptionName },
    `Subscribed to ${subscriptionName}`,
  );
}

export function resetGovernanceEventsSubscriber(): void {
  started = false;
  pubsub = null;
}
