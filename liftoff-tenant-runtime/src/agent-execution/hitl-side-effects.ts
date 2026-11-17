// Shared HITL approval side-effects.
//
// Extracted from `executeToolCalls` (service.ts:1771-1843) so the
// adapter-loop pause handlers (runConversationalTurnsViaAdapter +
// invokeStepLLM) can reuse the same Slack DM fan-out + SSE emit + audit
// log pattern after they call `createApprovalRequest`. Without this
// extraction the workflow tool_call path would emit the side effects but
// autonomous adapter pauses would silently skip Slack DMs and audit
// entries — which would mask the HITL request from the operator-facing
// surfaces (#fix.

import { streamingService } from '../streaming';
import { insertAuditLog } from '../audit';
import { logger } from '../infrastructure/logging';
import type { ExecutionState } from './types';
import { isGenericHitlCardEnabled } from './hitl-card-content';
import { recordApprovalNotificationOutcome } from './hitl-notification-outcome';

export interface HitlSideEffectInput {
  approvalId: string;
  gateReason: string;
  /** The gate's level. Routing is per level — owners and admins can take level
   *  1 and 2, members only level 2 — so without this a level 1 gate is DM'd to
   *  members who cannot approve it. */
  hitlLevel?: number;
  pendingToolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  state: ExecutionState;
  expiresAt?: Date;
  /** Generic gated-tool card content (see hitl-card-content.ts). Present when the
   *  generic-card flag is on and the gated set is NOT outbound messaging; drives the
   *  Action/Why/Details fan-out to assignees. Null/undefined ⇒ messaging-only (today's
   *  behavior — the web dashboard is the surface for non-messaging gates). */
  actionSummary?: string | null;
  whySummary?: string | null;
  detail?: string | null;
}

/** Fire-and-forget Slack DM + SSE emit + audit log per pending tool call.
 *  All three surfaces are idempotent: re-running won't duplicate Slack DMs
 *  (the helper guards on the first outbound slack call only), SSE emits
 *  are coalesced by the streaming service, and audit_logs are appended
 *  with no UNIQUE constraint (history > integrity here).
 *
 *  Inputs use the hitl-enforcement `ToolCallRequest` shape
 *  ({id, name, input}) — callers in the workflow path that hold the
 *  agent-execution shape ({connector, actionType, payload}) must map
 *  before invoking. */
export async function emitHitlApprovalSideEffects(input: HitlSideEffectInput): Promise<void> {
  const { approvalId, gateReason, pendingToolCalls, state, expiresAt, hitlLevel } = input;

  // 1. Slack DM fan-out — fire-and-forget. Pulled verbatim from the
  //    pre-extraction inline block in executeToolCalls.
  try {
    const { SLACK_OUTBOUND_TOOL_NAMES } = await import('../tool-gateway/agent-slack-tool-catalog');
    const firstSlack = pendingToolCalls.find((tc) => SLACK_OUTBOUND_TOOL_NAMES.has(tc.name));
    const { postReviewDm, listAgentAssignees } = await import('../agent-chat/agent-slack-client');
    if (firstSlack) {
      // Messaging specialization: preview the exact outbound message. Flag-independent
      // — this is today's behavior and unchanged.
      const slackCount = pendingToolCalls.filter((tc) => SLACK_OUTBOUND_TOOL_NAMES.has(tc.name)).length;
      if (slackCount > 1) {
        logger.warn('Multiple outbound slack tool calls in single approval; preview shows only the first', {
          approval_id: approvalId, slack_call_count: slackCount,
        });
      }
      const channelId = String((firstSlack.input as Record<string, unknown>)?.channel ?? '');
      const text = String((firstSlack.input as Record<string, unknown>)?.text ?? '');
      setImmediate(async () => {
        try {
          const assigneeAccountIds = await listAgentAssignees(
            state.context.tenantId, state.context.agentId, hitlLevel,
          );
          if (assigneeAccountIds.length === 0) {
            // Recorded, not returned silently: zero targets is a ROUTING
            // failure (nobody is assigned who can take this level) and looks
            // identical to a delivery failure unless it is written down.
            await recordApprovalNotificationOutcome(state.context.tenantId, approvalId, {
              targets: 0, delivered: 0,
            });
            return;
          }
          const res = await postReviewDm({
            reviewId: approvalId, tenantId: state.context.tenantId,
            agentId: state.context.agentId,
            channelId, draftText: text, assigneeAccountIds,
          });
          await recordApprovalNotificationOutcome(state.context.tenantId, approvalId, {
            targets: res.totalAssignees, delivered: res.delivered,
          });
        } catch (err) {
          logger.warn('slack review dm fan-out failed', {
            approval_id: approvalId, err: (err as Error).message,
          });
          await recordApprovalNotificationOutcome(state.context.tenantId, approvalId, {
            targets: 0, delivered: 0, error: `slack: ${(err as Error).message}`,
          });
        }
      });
    } else if (isGenericHitlCardEnabled() && input.actionSummary) {
      // Generic gated tool (not outbound messaging): fan out the Action/Why/Details card.
      const { actionSummary, whySummary, detail } = input;
      setImmediate(async () => {
        try {
          const assigneeAccountIds = await listAgentAssignees(
            state.context.tenantId, state.context.agentId, hitlLevel,
          );
          if (assigneeAccountIds.length === 0) {
            await recordApprovalNotificationOutcome(state.context.tenantId, approvalId, {
              targets: 0, delivered: 0,
            });
            return;
          }
          const res = await postReviewDm({
            reviewId: approvalId, tenantId: state.context.tenantId,
            agentId: state.context.agentId,
            action: actionSummary, why: whySummary ?? null, detail: detail ?? null,
            assigneeAccountIds,
          });
          await recordApprovalNotificationOutcome(state.context.tenantId, approvalId, {
            targets: res.totalAssignees, delivered: res.delivered,
          });
        } catch (err) {
          logger.warn('slack generic review dm fan-out failed', {
            approval_id: approvalId, err: (err as Error).message,
          });
          await recordApprovalNotificationOutcome(state.context.tenantId, approvalId, {
            targets: 0, delivered: 0, error: `slack: ${(err as Error).message}`,
          });
        }
      });
    }
  } catch (err) {
    logger.warn('slack review dm fan-out setup failed', { err: (err as Error).message });
  }

  // 1b. Teams review-card fan-out — fire-and-forget, mirrors the Slack DM
  //     fan-out above. Guards on the first outbound teams call only; PB's
  //     review-card-notifier maps assignees to their personal bot conversations
  //     (no channel id needed — the card is DM'd to each approver).
  try {
    const { TEAMS_OUTBOUND_TOOL_NAMES } = await import('../tool-gateway/agent-teams-tool-catalog');
    const firstTeams = pendingToolCalls.find((tc) => TEAMS_OUTBOUND_TOOL_NAMES.has(tc.name));
    const { postReviewCard, listAgentAssignees } = await import('../agent-chat/agent-teams-client');
    if (firstTeams) {
      // Messaging specialization (unchanged, flag-independent).
      const teamsCount = pendingToolCalls.filter((tc) => TEAMS_OUTBOUND_TOOL_NAMES.has(tc.name)).length;
      if (teamsCount > 1) {
        logger.warn('Multiple outbound teams tool calls in single approval; preview shows only the first', {
          approval_id: approvalId, teams_call_count: teamsCount,
        });
      }
      const text = String((firstTeams.input as Record<string, unknown>)?.text ?? '');
      setImmediate(async () => {
        try {
          const assigneeAccountIds = await listAgentAssignees(
            state.context.tenantId, state.context.agentId, hitlLevel,
          );
          if (assigneeAccountIds.length === 0) {
            await recordApprovalNotificationOutcome(state.context.tenantId, approvalId, {
              targets: 0, delivered: 0,
            });
            return;
          }
          const res = await postReviewCard({
            reviewId: approvalId, tenantId: state.context.tenantId,
            agentId: state.context.agentId,
            draftText: text, assigneeAccountIds,
          });
          await recordApprovalNotificationOutcome(state.context.tenantId, approvalId, {
            targets: res.totalAssignees, delivered: res.delivered,
          });
        } catch (err) {
          logger.warn('teams review card fan-out failed', {
            approval_id: approvalId, err: (err as Error).message,
          });
          await recordApprovalNotificationOutcome(state.context.tenantId, approvalId, {
            targets: 0, delivered: 0, error: `teams: ${(err as Error).message}`,
          });
        }
      });
    } else if (isGenericHitlCardEnabled() && input.actionSummary) {
      // Generic gated tool (not outbound messaging): fan out the Action/Why/Details card.
      const { actionSummary, whySummary, detail } = input;
      setImmediate(async () => {
        try {
          const assigneeAccountIds = await listAgentAssignees(
            state.context.tenantId, state.context.agentId, hitlLevel,
          );
          if (assigneeAccountIds.length === 0) {
            await recordApprovalNotificationOutcome(state.context.tenantId, approvalId, {
              targets: 0, delivered: 0,
            });
            return;
          }
          const res = await postReviewCard({
            reviewId: approvalId, tenantId: state.context.tenantId,
            agentId: state.context.agentId,
            action: actionSummary, why: whySummary ?? null, detail: detail ?? null,
            assigneeAccountIds,
          });
          await recordApprovalNotificationOutcome(state.context.tenantId, approvalId, {
            targets: res.totalAssignees, delivered: res.delivered,
          });
        } catch (err) {
          logger.warn('teams generic review card fan-out failed', {
            approval_id: approvalId, err: (err as Error).message,
          });
          await recordApprovalNotificationOutcome(state.context.tenantId, approvalId, {
            targets: 0, delivered: 0, error: `teams: ${(err as Error).message}`,
          });
        }
      });
    }
  } catch (err) {
    logger.warn('teams review card fan-out setup failed', { err: (err as Error).message });
  }

  // 2. SSE emit (only if thread present — autonomous cron-fired runs have
  //    no threadId and the chat UI isn't watching).
  if (state.context.threadId && state.context.invocationId) {
    streamingService.emitHitlRequired(
      state.context.threadId,
      state.context.invocationId,
      approvalId,
      gateReason as Parameters<typeof streamingService.emitHitlRequired>[3],
      pendingToolCalls,
      expiresAt,
    );
  }

  // 3. Audit log per pending tool call — outcome='gated' so the audit
  //    surface shows the agent stopped before externalising.
  //    `inputArgs` is recorded as the raw tool input; the workflow
  //    tool_call path (service.ts:executeToolCalls) historically wrapped
  //    via withTrustMetadata for additional context — for the adapter
  //    paths we use the raw input because the trust-metadata helper is a
  //    private function in service.ts not exported, and the metadata
  //    matters mainly for tools that reference external untrusted data
  //    (rare on outbound communication tools). Keeping it raw is the
  //    safer no-regression default.
  for (const tc of pendingToolCalls) {
    await insertAuditLog(null, state.context.tenantId, {
      internalAgentId: state.context.agentId,
      threadId: state.context.threadId,
      invocationId: state.context.invocationId,
      action: tc.name,
      inputArgs: tc.input,
      outcome: 'gated',
      triggeredBy: `agent:${state.context.agentId}`,
    });
  }

  logger.info('HITL gate triggered, execution paused', {
    trace_id: state.context.traceId,
    approval_id: approvalId,
    reason: gateReason,
    pending_tool_calls: pendingToolCalls.length,
  });
}
