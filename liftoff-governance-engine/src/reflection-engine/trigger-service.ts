// Reflection Trigger Service — Pub/Sub-backed.
//
// Phase 3e: governance-engine does not own the reflection engine itself;
// that lives in tenant-runtime (or its eventual extracted service). The
// ported hitl-enforcement and action-ledger compensation flows still need
// somewhere to call "a rejection just happened" / "this action was just
// compensated" — here we turn those calls into fire-and-forget Pub/Sub
// publishes on the `governance-events-{ENVIRONMENT}` topic.
//
// Method signatures are kept identical to the earlier stub so callers
// don't have to change, and publish errors are swallowed (warn-logged) by
// the publisher so the HITL / compensation hot paths never fail here.

import { logger } from '../infrastructure/logging';
import {
  publishLateFeedbackFlagged,
  publishActionCompensated,
} from '../events/publisher';

export class ReflectionTriggerService {
  async onLateFeedbackFlagged(
    agentId: string,
    tenantId: string,
    feedbackId: string,
  ): Promise<void> {
    logger.info(
      { agent_id: agentId, tenant_id: tenantId, feedback_id: feedbackId },
      'reflectionTriggerService.onLateFeedbackFlagged — publishing governance event',
    );
    await publishLateFeedbackFlagged({
      tenantId,
      agentId,
      feedbackId,
      // The caller uses approvalId interchangeably with feedbackId for the
      // immediate-rejection path; when called from late-feedback the
      // caller already has both. Default here keeps API stable.
      approvalId: feedbackId,
      decision: 'rejected',
    });
  }

  async onActionCompensated(
    agentId: string,
    tenantId: string,
    actionId: string,
  ): Promise<void> {
    logger.info(
      { agent_id: agentId, tenant_id: tenantId, action_id: actionId },
      'reflectionTriggerService.onActionCompensated — publishing governance event',
    );
    await publishActionCompensated({
      tenantId,
      agentId,
      actionId,
    });
  }
}

export const reflectionTriggerService = new ReflectionTriggerService();
