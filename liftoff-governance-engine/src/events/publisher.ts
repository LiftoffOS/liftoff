// Governance-engine event publisher.
//
// Phase 3e: governance-engine does NOT own reflection or learning — those
// flows live in tenant-runtime (or its eventual extracted reflection service).
// Instead governance publishes lifecycle events onto a dedicated Pub/Sub
// topic so any interested subscriber (reflection engine, analytics,
// dashboards) can pick them up without a synchronous RPC dependency.
//
// Topic: `governance-events-{ENVIRONMENT}`
// Attribute: `eventType` — one of:
//   - governance.correction_captured
//   - governance.late_feedback_flagged
//   - governance.action_compensated
//
// All publishes are fire-and-forget — errors log a warning but never throw,
// because these events are observability/learning-side and must never fail
// the HITL or action-ledger hot paths.

import { PubSubPublisher } from '@liftoffos/pubsub';
import { logger } from '../infrastructure/logging';

export const GOVERNANCE_EVENT_TYPES = {
  CORRECTION_CAPTURED: 'governance.correction_captured',
  LATE_FEEDBACK_FLAGGED: 'governance.late_feedback_flagged',
  ACTION_COMPENSATED: 'governance.action_compensated',
} as const;

export type GovernanceEventType =
  (typeof GOVERNANCE_EVENT_TYPES)[keyof typeof GOVERNANCE_EVENT_TYPES];

export interface CorrectionCapturedPayload {
  tenantId: string;
  agentId: string;
  actionId?: string | null;
  correctionType: 'rejected' | 'approved';
  correctionPayload: {
    pendingToolCalls?: Array<{
      id: string;
      name: string;
      input: Record<string, unknown>;
    }>;
    rejectionReason?: string;
    approvalId?: string;
  };
}

export interface LateFeedbackFlaggedPayload {
  tenantId: string;
  agentId: string;
  feedbackId: string;
  approvalId: string;
  decision: 'approved' | 'rejected';
  rejectionReason?: string;
}

export interface ActionCompensatedPayload {
  tenantId: string;
  agentId: string;
  actionId: string;
  compensationReason?: string;
}

function buildTopicName(): string {
  const env = process.env.ENVIRONMENT || 'dev';
  return `governance-events-${env}`;
}

// Lazy-instantiate so tests can mock @liftoffos/pubsub cleanly without
// the publisher trying to talk to a real project at module-load time.
let cachedPublisher: PubSubPublisher | null = null;
export function getPublisher(): PubSubPublisher {
  if (!cachedPublisher) {
    cachedPublisher = new PubSubPublisher({
      projectId: process.env.GCP_PROJECT_ID,
      logger: {
        debug: (ctx, msg) => logger.debug(ctx, msg),
        error: (ctx, msg) => logger.error(ctx, msg),
      },
    });
  }
  return cachedPublisher;
}

// Test-only reset — lets tests swap the publisher cleanly between cases.
export function __resetPublisherForTests(p: PubSubPublisher | null): void {
  cachedPublisher = p;
}

async function publishGovernanceEvent(
  eventType: GovernanceEventType,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    const topicName = buildTopicName();
    const publisher = getPublisher();
    await publisher.publish(
      topicName,
      { eventType, occurredAt: new Date().toISOString(), payload },
      {
        attributes: {
          eventType,
          ...(typeof payload.tenantId === 'string'
            ? { tenantId: payload.tenantId }
            : {}),
        },
      },
    );
  } catch (err) {
    logger.warn(
      {
        err: (err as Error).message,
        eventType,
      },
      'governance event publish failed (non-fatal)',
    );
  }
}

export function publishCorrectionCaptured(
  payload: CorrectionCapturedPayload,
): Promise<void> {
  return publishGovernanceEvent(
    GOVERNANCE_EVENT_TYPES.CORRECTION_CAPTURED,
    payload as unknown as Record<string, unknown>,
  );
}

export function publishLateFeedbackFlagged(
  payload: LateFeedbackFlaggedPayload,
): Promise<void> {
  return publishGovernanceEvent(
    GOVERNANCE_EVENT_TYPES.LATE_FEEDBACK_FLAGGED,
    payload as unknown as Record<string, unknown>,
  );
}

export function publishActionCompensated(
  payload: ActionCompensatedPayload,
): Promise<void> {
  return publishGovernanceEvent(
    GOVERNANCE_EVENT_TYPES.ACTION_COMPENSATED,
    payload as unknown as Record<string, unknown>,
  );
}
