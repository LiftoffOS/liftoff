import type { ConnectRouter, HandlerContext } from '@connectrpc/connect';
import { create } from '@bufbuild/protobuf';
import { TenantRuntimeService } from '@liftoffos/proto-gen';
import {
  ListApprovalsResponseSchema,
  ResolveApprovalResponseSchema,
  SendLateFeedbackResponseSchema,
  GetInvocationStatsResponseSchema,
  GetAgentCostsResponseSchema,
  GetUsageDashboardResponseSchema,
  GetConnectorHealthResponseSchema,
  GetToolCatalogResponseSchema,
  GetActionCostsResponseSchema,
  RespondToClarificationResponseSchema,
  type ListApprovalsRequest,
  type ResolveApprovalRequest,
  type SendLateFeedbackRequest,
  type GetInvocationStatsRequest,
  type GetAgentCostsRequest,
  type GetUsageDashboardRequest,
  type GetConnectorHealthRequest,
  type GetToolCatalogRequest,
  type GetActionCostsRequest,
  type RespondToClarificationRequest,
} from '@liftoffos/proto-gen/dist/liftoff/platform/v1/tenant_runtime_pb.js';
import { ApprovalDecision, ApprovalStatus, HitlLevel } from '@liftoffos/proto-gen/dist/liftoff/governance/v1/types_pb.js';
import { hitlEnforcementService } from '../hitl-enforcement/service.js';
import { invocationsService } from '../invocations/service.js';
import { aggregationService } from '../usage-ledger/aggregation-service.js';
import { connectorService } from '../connectors/service.js';
import { getAvailableTools, getTenantManifests } from '../tool-catalog/catalog-service.js';
import { logger } from '../infrastructure/logging';
import { parseApprovedEdits } from '../hitl-enforcement/approved-edits';
import { resolveApprovalAndResume } from '../hitl-enforcement/resolve-and-resume.js';

// ── Row to proto converters ─────────────────────────────────────────────
//
// The wire types are enums and Timestamp messages; the service layer works in
// strings, numbers and Dates. Converting explicitly keeps a column that is
// absent, null or an unrecognised string from reaching protobuf-es as garbage.

function toProtoTimestamp(value: Date | null | undefined) {
  if (!value || Number.isNaN(value.getTime())) return undefined;
  return { seconds: BigInt(Math.floor(value.getTime() / 1000)), nanos: 0 };
}

function toProtoApprovalStatus(status: string | null | undefined): ApprovalStatus {
  switch (status) {
    case 'pending': return ApprovalStatus.PENDING;
    case 'approved': return ApprovalStatus.APPROVED;
    case 'rejected': return ApprovalStatus.REJECTED;
    case 'expired': return ApprovalStatus.EXPIRED;
    default: return ApprovalStatus.UNSPECIFIED;
  }
}

function toProtoApprovalDecision(decision: string | null | undefined): ApprovalDecision {
  switch (decision) {
    case 'approved': return ApprovalDecision.APPROVED;
    case 'rejected': return ApprovalDecision.REJECTED;
    default: return ApprovalDecision.UNSPECIFIED;
  }
}

/** hitl_level is the tenant's effective autonomy level, 1 to 5. Anything
 *  outside that range maps to UNSPECIFIED rather than an invalid enum value. */
function toProtoHitlLevel(level: number | null | undefined): HitlLevel {
  switch (level) {
    case 1: return HitlLevel.HITL_LEVEL_1;
    case 2: return HitlLevel.HITL_LEVEL_2;
    case 3: return HitlLevel.HITL_LEVEL_3;
    case 4: return HitlLevel.HITL_LEVEL_4;
    case 5: return HitlLevel.HITL_LEVEL_5;
    default: return HitlLevel.HITL_LEVEL_UNSPECIFIED;
  }
}

export default function registerTenantRuntimeService(router: ConnectRouter): void {
  router.service(TenantRuntimeService, {

    async listApprovals(req: ListApprovalsRequest, _ctx: HandlerContext) {
      const tenantId = req.tenantContext?.tenantId ?? '';
      const result = await hitlEnforcementService.listPendingItemsForTenant(tenantId, {
        cursor: req.pagination?.pageToken || undefined,
        limit: req.pagination?.pageSize || 50,
      });
      const approvals = result.items
        .filter((item): item is import('../hitl-enforcement/service.js').ApprovalItem => item.kind === 'approval')
        // Mapped field by field, never spread. `status` and `decision` are proto
        // enums (numbers) and the timestamps are Timestamp messages, so handing
        // over the raw row values would serialise a string into an enum and a
        // Date into a message. That only stayed invisible while the listing
        // query omitted those columns entirely.
        .map(a => ({
          id: a.id,
          tenantId: a.tenantId,
          workflowId: a.workflowId,
          taskId: a.taskId,
          agentId: a.agentId,
          hitlLevel: toProtoHitlLevel(a.hitlLevel),
          toolCallsHash: a.toolCallsHash ?? '',
          reason: a.reason,
          status: toProtoApprovalStatus(a.status),
          decidedBy: a.decidedBy ?? '',
          decidedByRole: a.decidedByRole ?? '',
          decision: toProtoApprovalDecision(a.decision),
          rejectionReason: a.rejectionReason ?? '',
          decidedAt: toProtoTimestamp(a.decidedAt),
          expiresAt: toProtoTimestamp(a.expiresAt),
          createdAt: toProtoTimestamp(a.createdAt),
          updatedAt: toProtoTimestamp(a.updatedAt),
        }));
      const clarifications = result.items
        .filter((item): item is import('../hitl-enforcement/service.js').ClarificationItem => item.kind === 'clarification')
        .map(c => ({
          id: c.id,
          tenantId: c.tenantId,
          agentId: c.agentId,
          threadId: c.threadId,
          question: c.question,
          source: c.source,
          vendorRequestId: c.vendorRequestId ?? '',
          createdAt: { seconds: BigInt(Math.floor(c.createdAt.getTime() / 1000)), nanos: 0 },
          expiresAt: { seconds: BigInt(Math.floor(c.expiresAt.getTime() / 1000)), nanos: 0 },
        }));
      return create(ListApprovalsResponseSchema, {
        approvals: approvals as never,
        nextPageToken: result.nextCursor ?? '',
        clarifications: clarifications as never,
      });
    },

    async respondToClarification(req: RespondToClarificationRequest, _ctx: HandlerContext) {
      const tenantId = req.tenantContext?.tenantId ?? '';
      await hitlEnforcementService.respondToClarification({
        tenantId,
        clarificationId: req.clarificationId,
        response: req.response,
        resolvedBy: req.resolvedBy,
      });
      return create(RespondToClarificationResponseSchema, { success: true });
    },

    async resolveApproval(req: ResolveApprovalRequest, _ctx: HandlerContext) {
      const isApproved = req.decision === ApprovalDecision.APPROVED;

      // Single shared path with the REST approval router: records the decision,
      // settles sandbox-code approvals, appends the decision to the typed run
      // transcript, and enqueues the resume task that dispatches approved calls
      // / drives the rejection's continue-and-adapt re-entry. The resume
      // enqueue used to be missing here, so operator-approved runs paused via
      // createHitlPause were never dispatched.
      try {
        await resolveApprovalAndResume({
          approvalId: req.approvalId,
          tenantId: req.tenantContext?.tenantId ?? '',
          decision: isApproved ? 'approved' : 'rejected',
          decidedBy: req.decidedBy,
          decidedByRole: req.decidedByRole,
          rejectionReason: req.rejectionReason,
          approvalNote: req.approvalNote,
          // Whole-input replacements the reviewer made, keyed by tool call id.
          // Proto carries them as Struct, which decodes to a plain object; the
          // service drops any key naming no pending call.
          editedToolInputs: parseApprovedEdits(req.editedToolInputs),
          alwaysApply: req.alwaysApply,
        });
      } catch (err) {
        // approveRequest/rejectRequest throw on a refused precondition — not
        // found, already decided, expired, tamper hash mismatch. Unlogged, each
        // of those reached the operator as a bare HTTP 500 with no message, on
        // both surfaces that call this (Slack action and /dashboard/review),
        // which is indistinguishable from the service being down and gives
        // nobody a reason or a next step.
        //
        // A TAMPER_DETECTED refusal, unlogged, shows as nothing but 500s, and
        // finding the cause takes a database read and a hash recomputation —
        // for a condition the code knew by name at the moment it threw.
        logger.error(
          {
            approvalId: req.approvalId,
            decision: isApproved ? 'approved' : 'rejected',
            decidedBy: req.decidedBy,
            err: (err as Error).message,
          },
          'ResolveApproval failed',
        );
        throw err;
      }

      return create(ResolveApprovalResponseSchema, { success: true });
    },

    async sendLateFeedback(req: SendLateFeedbackRequest, _ctx: HandlerContext) {
      const tenantId = req.tenantContext?.tenantId ?? '';
      await hitlEnforcementService.recordLateFeedback({
        feedbackId: req.feedbackId,
        tenantId,
        approvalId: req.feedbackId,
        decision: req.decision === ApprovalDecision.APPROVED ? 'approved' : 'rejected',
        decidedBy: req.decidedBy,
        decidedByRole: req.decidedByRole,
        rejectionReason: req.rejectionReason,
      });
      return create(SendLateFeedbackResponseSchema, { success: true });
    },

    async getInvocationStats(req: GetInvocationStatsRequest, _ctx: HandlerContext) {
      const tenantId = req.tenantContext?.tenantId ?? '';
      const since = req.since
        ? new Date(Number(req.since.seconds) * 1000)
        : new Date(Date.now() - 30 * 86_400_000);
      const stats = await invocationsService.getCostStats(tenantId, since, new Date());
      return create(GetInvocationStatsResponseSchema, {
        totalInvocations: BigInt(stats.invocationCount),
        successfulInvocations: BigInt(stats.successfulInvocations),
        failedInvocations: BigInt(stats.failedInvocations),
        totalToolCalls: 0n,
        totalCostUsd: stats.totalCostUsd,
      });
    },

    async getAgentCosts(req: GetAgentCostsRequest, _ctx: HandlerContext) {
      const tenantId = req.tenantContext?.tenantId ?? '';
      const since = req.since
        ? new Date(Number(req.since.seconds) * 1000)
        : new Date(Date.now() - 30 * 86_400_000);
      const costs = await invocationsService.getAgentCosts(tenantId, since, new Date());
      return create(GetAgentCostsResponseSchema, {
        entries: Object.entries(costs).map(([agentId, e]) => ({
          agentId,
          totalCostUsd: e.totalCostUsd,
          invocationCount: BigInt(e.invocationCount),
          totalInputTokens: BigInt(e.totalInputTokens),
          totalOutputTokens: BigInt(e.totalOutputTokens),
          totalCachedTokens: 0n,
        })),
      });
    },

    async getUsageDashboard(req: GetUsageDashboardRequest, _ctx: HandlerContext) {
      const tenantId = req.tenantContext?.tenantId ?? '';
      const dashboard = await aggregationService.getOperatorDashboard(tenantId);
      return create(GetUsageDashboardResponseSchema, {
        totalCostUsd: dashboard.currentBurn.usedCredits,
        remainingCreditsUsd: dashboard.currentBurn.remainingCredits,
        activeAgents: dashboard.topAgents.length,
        topAgentsByCost: dashboard.topAgents.map(a => a.agentId),
        topConnectorsByUsage: dashboard.topConnectors.map(c => c.connector),
      });
    },

    async getConnectorHealth(req: GetConnectorHealthRequest, _ctx: HandlerContext) {
      const tenantId = req.tenantContext?.tenantId ?? '';
      const entries = await connectorService.listConnectorSyncStats(tenantId);
      return create(GetConnectorHealthResponseSchema, {
        entries: entries.map(e => ({
          connectorId: e.connectorId,
          connectorType: e.connectorType,
          status: e.status,
          lastSuccessAt: e.lastSuccessAt
            ? { seconds: BigInt(Math.floor(e.lastSuccessAt.getTime() / 1000)), nanos: 0 }
            : undefined,
          consecutiveFailures: e.consecutiveFailures,
        })),
      });
    },

    async getToolCatalog(req: GetToolCatalogRequest, _ctx: HandlerContext) {
      const tenantId = req.tenantContext?.tenantId ?? '';
      const manifests = await getTenantManifests(tenantId);
      const allTools = await Promise.all(
        manifests.map(m => getAvailableTools(tenantId, m.manifestId)),
      );
      return create(GetToolCatalogResponseSchema, {
        tools: allTools.flatMap(result => {
          if (!result) return [];
          return result.tools.map(t => ({
            connectorType: result.connectorType,
            functionName: t.name,
            description: t.description,
            categories: t.categories ?? [],
          }));
        }),
      });
    },

    async getActionCosts(req: GetActionCostsRequest, _ctx: HandlerContext) {
      const tenantId = req.tenantContext?.tenantId ?? '';
      const since = req.since
        ? new Date(Number(req.since.seconds) * 1000)
        : new Date(Date.now() - 30 * 86_400_000);
      const until = req.until ? new Date(Number(req.until.seconds) * 1000) : new Date();
      const result = await invocationsService.getActionCosts(tenantId, {
        agentId: req.agentId || undefined,
        since,
        until,
        cursor: req.pageCursor || undefined,
        limit: req.pageSize || 50,
      });
      return create(GetActionCostsResponseSchema, {
        entries: result.entries.map(e => ({
          actionId: e.actionId,
          agentId: e.agentId,
          workflowId: e.workflowId,
          connector: e.connector,
          actionType: e.actionType,
          llmCostUsd: e.llmCostUsd,
          connectorCostUsd: e.connectorCostUsd,
          inputTokens: BigInt(e.inputTokens),
          outputTokens: BigInt(e.outputTokens),
          durationMs: BigInt(Math.round(e.durationMs)),
          occurredAt: {
            seconds: BigInt(Math.floor(e.occurredAt.getTime() / 1000)),
            nanos: 0,
          },
        })),
        nextPageCursor: result.nextCursor ?? '',
      });
    },
  });
}
