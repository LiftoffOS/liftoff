// Workforce Plan Events
// Pub/Sub event publishing for CAIO workforce plan lifecycle.
//
// Provisioning is driven by Cloud Tasks fan-out enqueued from the
// workforce-plans/router approve handler (one task per spec → HRBP via
// runPlatformAgent). The events here remain for observability and
// dashboard updates; no subscriber drives provisioning.

import { publishEvent } from '../events/publisher.js';
import { log } from '../infrastructure/logging.js';

export type WorkforcePlanEventType =
  | 'workforce_plan.created'
  | 'workforce_plan.submitted'
  | 'workforce_plan.approved'
  | 'workforce_plan.rejected'
  | 'workforce_plan.reopened'
  | 'workforce_plan.provisioning_started'
  | 'workforce_plan.provisioning_progress'
  | 'workforce_plan.completed'
  | 'workforce_plan.failed';

/**
 * Publish a workforce plan lifecycle event. Uses `revision` as the
 * entityVersion so subscribers can order events correctly across the
 * draft -> pending_approval -> approved -> provisioning -> completed
 * -> (reopen) -> draft lifecycle.
 *
 * Errors are logged but not rethrown. Failing to publish the event must
 * never fail the HTTP request that triggered the state change - the
 * plan is still persisted, and a stuck event is recoverable via a
 * reconciliation job (same pattern as internal-agent events).
 */
export async function publishWorkforcePlanEvent(
  eventType: WorkforcePlanEventType,
  planId: string,
  tenantId: string,
  revision: number,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await publishEvent({
      entityType: 'workforce_plan',
      entityId: planId,
      eventType,
      entityVersion: revision,
      eventVersion: 1,
      tenantId,
      payload,
    });

    log.info(
      { eventType, planId, tenantId, revision },
      'Workforce plan event published',
    );
  } catch (error) {
    log.error(
      { error, eventType, planId, tenantId },
      'Failed to publish workforce plan event',
    );
    // Don't throw - event publishing shouldn't fail the request
  }
}
