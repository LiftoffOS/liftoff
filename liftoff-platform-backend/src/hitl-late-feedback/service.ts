// HITL Late Feedback Service
// Handles late feedback submission and syncing to tenant runtime for agent learning

import { lateFeedbackRepository } from './repository';
import { enqueueLateFeedbackTrustOutbox } from './trust-outbox';
import { tenantRuntimeClient } from '../connectors/tenant-runtime-client';
import { log } from '../infrastructure/logging';
import { frontendUrl } from '../infrastructure/frontend-url';
import { agentAuditLogsService } from '../agent-audit-logs/service';
import { enqueueNotification } from '../notifications';
import { getPool, withTenantScope } from '../infrastructure/database';
import type {
  LateFeedback,
  CreateLateFeedbackInput,
} from './types';

// Strip alias__ / mcp__<server>__ prefixes down to the bare action name.
function bareToolActionName(name: string): string {
  const parts = name.split('__');
  return parts[parts.length - 1];
}

export class LateFeedbackService {
  /**
   * Submit late feedback for an expired approval
   * Stores feedback and triggers async sync to tenant runtime
   */
  async submitLateFeedback(input: CreateLateFeedbackInput): Promise<LateFeedback> {
    // Store the feedback row AND enqueue its trust-decisions outbox row in ONE transaction,
    // so a submitted decision is never persisted without being scheduled for delivery to the
    // governance trust ledger.
    const feedback = await withTenantScope(input.tenantId, async (client) => {
      const fb = await lateFeedbackRepository.insert(input, client);
      const actionClasses = [
        ...new Set(input.approval.pendingToolCalls.map((tc) => bareToolActionName(tc.name))),
      ];
      const trustDecision = input.decision === 'would_approve' ? 'approved' : 'rejected';
      const payload = {
        tenantId: input.tenantId,
        agentId: input.approval.agentId,
        gateReason: fb.gateReason,
        feedbackId: fb.id,
        decisions: actionClasses.map((actionClass) => ({
          actionClass,
          decision: trustDecision,
          decidedBy: input.decidedBy,
          decidedAt: new Date().toISOString(),
          sourceKey: `${fb.id}:${actionClass}`,
        })),
      };
      await enqueueLateFeedbackTrustOutbox(client, {
        tenantId: input.tenantId,
        feedbackId: fb.id,
        payload,
      });
      return fb;
    });

    log.info({
      event: 'hitl_late_feedback_submitted',
      feedbackId: feedback.id,
      tenantId: input.tenantId,
      approvalId: input.approval.id,
      agentId: input.approval.agentId,
      decision: input.decision,
      decidedBy: input.decidedBy,
    });

    agentAuditLogsService.insertAuditLog({
      tenantId: input.tenantId,
      internalAgentId: feedback.internalAgentId ?? undefined,
      action: 'hitl_late_feedback_submitted',
      inputArgs: {
        approvalId: feedback.approvalId,
        decision: feedback.decision,
        gateReason: feedback.gateReason,
        hitlLevel: feedback.hitlLevel,
        toolCallsHash: feedback.toolCallsHash,
        rejectionReason: feedback.rejectionReason ?? null,
      },
      outcome: 'success',
      triggeredBy: `human:${input.decidedBy}`,
    }).catch((err) => {
      log.warn({
        event: 'hitl_late_feedback_audit_log_failed',
        feedbackId: feedback.id,
        error: (err as Error).message,
      });
    });

    // Fan out agent_activity notifications to other tenant members. Fire-and-forget.
    this.fanOutTeamActivity(feedback).catch((err) => {
      log.warn({
        event: 'hitl_late_feedback_notify_failed',
        feedbackId: feedback.id,
        error: (err as Error).message,
      });
    });

    // Trigger async sync to runtime (fire and forget)
    this.syncToRuntime(feedback).catch((error) => {
      log.warn({
        event: 'hitl_late_feedback_sync_failed_initial',
        feedbackId: feedback.id,
        error: (error as Error).message,
      });
    });

    return feedback;
  }

  private async fanOutTeamActivity(feedback: LateFeedback): Promise<void> {
    const pool = getPool();
    const recipients = await withTenantScope(feedback.tenantId, (client) => client.query<{ account_id: string }>(
      `SELECT account_id FROM tenant_members WHERE tenant_id = $1 AND account_id != $2`,
      [feedback.tenantId, feedback.decidedBy],
    ));
    const actor = await pool.query<{ first_name: string; last_name: string }>(
      `SELECT first_name, last_name FROM accounts WHERE id = $1`,
      [feedback.decidedBy],
    );
    const actorName = actor.rows[0]
      ? `${actor.rows[0].first_name} ${actor.rows[0].last_name}`.trim()
      : 'A workspace member';
    const verb = feedback.decision === 'would_approve' ? 'approved' : 'rejected';
    const summary = `${verb} a late-feedback review for an expired approval.`;
    const link = `${frontendUrl()}/dashboard/review#${feedback.id}`;

    for (const r of recipients.rows) {
      enqueueNotification({
        accountId: r.account_id,
        tenantId: feedback.tenantId,
        type: 'agent_activity',
        payload: {
          actorName,
          eventSummary: summary,
          eventLink: link,
        },
      }).catch((err) => {
        log.warn(
          { err: (err as Error).message, feedbackId: feedback.id, recipient: r.account_id },
          'agent_activity enqueue failed',
        );
      });
    }
  }

  /**
   * Get feedback by approval ID (for idempotency check)
   */
  async getByApprovalId(
    tenantId: string,
    approvalId: string
  ): Promise<LateFeedback | null> {
    return lateFeedbackRepository.getByApprovalId(tenantId, approvalId);
  }

  /**
   * Which of these approvals already carry feedback, in one query. Backs the
   * "decision window passed" page, so it does not offer a form for an item
   * that was already answered.
   */
  async findApprovalIdsWithFeedback(
    tenantId: string,
    approvalIds: string[]
  ): Promise<Set<string>> {
    return lateFeedbackRepository.findApprovalIdsWithFeedback(tenantId, approvalIds);
  }

  /**
   * List feedback by agent for learning queries
   */
  async listByAgent(
    tenantId: string,
    agentId: string,
    options?: { limit?: number; offset?: number }
  ): Promise<LateFeedback[]> {
    return lateFeedbackRepository.listByAgent(tenantId, agentId, options);
  }

  /**
   * List feedback by tool calls hash for pattern matching
   */
  async listByToolCallsHash(
    tenantId: string,
    toolCallsHash: string,
    options?: { limit?: number }
  ): Promise<LateFeedback[]> {
    return lateFeedbackRepository.listByToolCallsHash(tenantId, toolCallsHash, options);
  }

  /**
   * Sync feedback to tenant runtime
   * Retry mechanism is handled by tenantRuntimeClient.sendLateFeedback()
   */
  async syncToRuntime(feedback: LateFeedback): Promise<{ success: boolean }> {
    return tenantRuntimeClient.sendLateFeedback(feedback.tenantId, feedback.id, {
      approvalId: feedback.approvalId,
      decision: feedback.decision,
      decidedBy: feedback.decidedBy,
      decidedByRole: feedback.decidedByRole,
      rejectionReason: feedback.rejectionReason || undefined,
      toolCallsHash: feedback.toolCallsHash,
      pendingToolCalls: feedback.pendingToolCalls,
    });
  }

  /**
   * Get unsynced feedback for background sync job
   */
  async getUnsyncedFeedback(options?: {
    limit?: number;
    maxAttempts?: number;
  }): Promise<LateFeedback[]> {
    return lateFeedbackRepository.getUnsynced(options);
  }
}

export const lateFeedbackService = new LateFeedbackService();
