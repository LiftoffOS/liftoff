// Review tools: the queue, a decision, an answer to a clarification.
//
// review_decide is preview → confirm: the preview carries what the team is
// waiting to do (its pending tool calls), why the gate fired, and whether a
// standing decision is on offer for this gate reason, so the person sees
// exactly what they are approving before the handle is confirmed. The level
// rule lives inside decideReview (canApproveHitl against the approval's
// level), so the tool's permission is the member floor and a level-1 refusal
// comes back from the function.

import { getRuntimeToInternalMap } from '../../internal-agents/runtime-agent-id-map';
import type { Actor } from '../actor';
import {
  answerClarification,
  declineClarification,
  decideReview,
  listReviews,
  standingApprovalAllowed,
} from '../review';
import { tenantRuntimeClient, type QueueWindow } from '../../connectors/tenant-runtime-client';
import { findTeamByName, listAiWorkforce } from '../teams';
import type { WorkspaceActionTool } from './types';

/** A team name → the RUNTIME's agents.id, through the runtime's own mapping
 *  (ADR-039). null when the map cannot be resolved or holds no entry: the
 *  caller reports the filter unavailable rather than filtering a page by
 *  name, which returns an incomplete set against an unfiltered count. */
async function runtimeAgentIdForTeam(tenantId: string, teamName: string): Promise<{ runtimeAgentId: string } | { unknownTeam: true } | null> {
  const { teams } = await listAiWorkforce(tenantId);
  const team = findTeamByName(teams, teamName);
  if (!team) return { unknownTeam: true };
  const map = await getRuntimeToInternalMap(tenantId);
  for (const [runtimeId, internalId] of map) {
    if (internalId === team.id) return { runtimeAgentId: runtimeId };
  }
  return null;
}

function summariseItem(item: Awaited<ReturnType<typeof listReviews>>['items'][number]) {
  if (item.kind === 'clarification') {
    return {
      kind: 'clarification',
      id: item.id,
      team: item.agentName ?? null,
      question: item.question,
      createdAt: item.createdAt,
      expiresAt: item.expiresAt,
    };
  }
  return {
    kind: 'approval',
    id: item.id,
    team: item.agentName ?? null,
    level: item.hitlLevel,
    reason: item.reason,
    status: item.status,
    action: item.actionSummary ?? null,
    why: item.whySummary ?? null,
    detail: item.detail ?? null,
    pendingToolCalls: item.pendingToolCalls.map((c) => ({ id: c.id, name: c.name, input: c.input })),
    standingDecisionOffered: standingApprovalAllowed(item.reason),
    createdAt: item.createdAt,
    expiresAt: item.expiresAt,
    ...(item.lateFeedbackSubmitted !== undefined ? { lateFeedbackSubmitted: item.lateFeedbackSubmitted } : {}),
  };
}

export const reviewListTool: WorkspaceActionTool = {
  definition: {
    name: 'review_list',
    description:
      'The review queue: what is waiting on a person in this workspace. Each item is an approval an agent needs before it can continue, or a clarification an agent is asking for. `window` "actionable" (the default) lists what still needs a decision; "passed" lists approvals whose window closed. `team` narrows the queue to one agent by name; when that single agent view cannot be resolved right now the result says filterUnavailable and the whole queue is still available without the filter.',
    input_schema: {
      type: 'object',
      properties: {
        window: { type: 'string', enum: ['actionable', 'passed'], description: 'Which view of the queue (default actionable)' },
        team: { type: 'string', maxLength: 200, description: 'Only this agent, by name' },
        limit: { type: 'number', minimum: 1, maximum: 50, description: 'Max items (default 20)' },
      },
    },
  },
  permission: null,
  async execute(input, actor: Actor) {
    const window = (input.window === 'passed' ? 'passed' : 'actionable') as QueueWindow;
    const limit = typeof input.limit === 'number' ? Math.min(Math.max(1, Math.floor(input.limit)), 50) : 20;
    let agentId: string | undefined;
    if (typeof input.team === 'string' && input.team.trim()) {
      const resolved = await runtimeAgentIdForTeam(actor.tenantId, input.team.trim());
      if (resolved && 'unknownTeam' in resolved) {
        return { items: [], total: 0, unknownTeam: input.team, message: 'No team by that name in this workspace.' };
      }
      if (!resolved) {
        return {
          items: [],
          total: null,
          filterUnavailable: true,
          message: 'The single agent view of the review queue is not available right now. The whole queue is: call review_list without team.',
        };
      }
      agentId = resolved.runtimeAgentId;
    }
    const { items, nextCursor, counts } = await listReviews(actor.tenantId, { window, agentId, limit });
    return {
      window,
      items: items.map(summariseItem),
      total: counts?.total ?? null,
      counts,
      hasMore: nextCursor !== null,
    };
  },
};

export const reviewDecideTool: WorkspaceActionTool = {
  definition: {
    name: 'review_decide',
    description:
      'Approve or reject one item in the review queue, as the person. Called without confirmationId it returns a preview (what the agent is waiting to do, why the gate fired, and whether a standing decision (alwaysApply) is on offer for this kind of gate) and a confirmationId; show the person the preview and call again with the confirmationId only when they say to go ahead. reason explains a rejection; note explains an approval; alwaysApply asks for the same decision to stand for this kind of action in future (dropped where the gate does not allow one); editedToolInputs replaces the arguments of a pending tool call before approving, keyed by its id.',
    input_schema: {
      type: 'object',
      properties: {
        approvalId: { type: 'string', description: 'The approval id from review_list' },
        decision: { type: 'string', enum: ['approve', 'reject'] },
        reason: { type: 'string', maxLength: 2048, description: 'Why it is rejected' },
        note: { type: 'string', maxLength: 8000, description: 'Why it is approved' },
        alwaysApply: { type: 'boolean', description: 'Make this a standing decision for this kind of action' },
        editedToolInputs: { type: 'object', description: 'Replacement arguments per pending tool call id' },
        confirmationId: { type: 'string', description: 'From the preview, once the person has agreed' },
      },
      required: ['approvalId', 'decision'],
    },
  },
  permission: 'hitl:approve_level_2',
  mutating: true,
  async preview(input, actor: Actor) {
    const approvalId = String(input.approvalId ?? '');
    const approval = await tenantRuntimeClient.getApproval(actor.tenantId, approvalId);
    if (!approval) return { approvalId, decision: input.decision, approval: null, message: 'This approval could not be read; the decision will be checked against the stricter level.' };
    const standing = standingApprovalAllowed(approval.reason);
    return {
      approvalId,
      decision: input.decision,
      level: approval.hitlLevel,
      reason: approval.reason,
      status: approval.status,
      action: approval.actionSummary ?? null,
      why: approval.whySummary ?? null,
      detail: approval.detail ?? null,
      pendingToolCalls: approval.pendingToolCalls,
      standingDecisionOffered: standing,
      alwaysApply: input.alwaysApply === true && standing,
      ...(input.alwaysApply === true && !standing ? { note: 'A standing decision is not offered for this kind of gate; the decision applies once.' } : {}),
      ...(input.editedToolInputs ? { editedToolInputs: input.editedToolInputs } : {}),
      ...(typeof input.reason === 'string' ? { rejectionReason: input.reason } : {}),
      ...(typeof input.note === 'string' ? { approvalNote: input.note } : {}),
    };
  },
  async execute(input, actor: Actor) {
    const decision = input.decision === 'reject' ? 'reject' : 'approve';
    const result = await decideReview(actor, String(input.approvalId ?? ''), decision, {
      alwaysApply: input.alwaysApply === true,
      approvalNote: typeof input.note === 'string' ? input.note : undefined,
      reason: typeof input.reason === 'string' ? input.reason : undefined,
      editedToolInputs: input.editedToolInputs && typeof input.editedToolInputs === 'object'
        ? input.editedToolInputs as Record<string, Record<string, unknown>>
        : undefined,
    });
    if ('refused' in result) {
      return { refused: true, reason: result.refused, message: result.message, ...(result.lateFeedbackEndpoint ? { lateFeedbackEndpoint: result.lateFeedbackEndpoint } : {}) };
    }
    return {
      decided: decision === 'approve' ? 'approved' : 'rejected',
      approvalId: result.approval.id,
      status: result.approval.status,
      message: decision === 'approve'
        ? 'Approved. The team resumes from where it paused.'
        : 'Rejected. The team will not take that action.',
    };
  },
};

export const clarificationAnswerTool: WorkspaceActionTool = {
  definition: {
    name: 'clarification_answer',
    description:
      'Answer a clarification an agent is waiting on (response), or decline it (decline: true, with an optional reason) so the agent resumes without an answer. Either way the parked run continues.',
    input_schema: {
      type: 'object',
      properties: {
        clarificationId: { type: 'string', description: 'The clarification id from review_list' },
        response: { type: 'string', maxLength: 8000, description: 'The answer, in the person\'s words' },
        decline: { type: 'boolean', description: 'True to decline instead of answering' },
        reason: { type: 'string', maxLength: 8000, description: 'Why it is declined' },
      },
      required: ['clarificationId'],
    },
  },
  permission: 'hitl:approve_level_2',
  reResolveActor: true,
  async execute(input, actor: Actor) {
    const clarificationId = String(input.clarificationId ?? '');
    if (input.decline === true) {
      const result = await declineClarification(actor, clarificationId, typeof input.reason === 'string' ? input.reason : undefined);
      return 'refused' in result ? { refused: true, reason: result.refused, message: result.message } : { declined: true, clarificationId, message: 'Declined. The team resumes without an answer.' };
    }
    const response = typeof input.response === 'string' ? input.response.trim() : '';
    if (!response) return { refused: true, reason: 'validation', message: 'Provide response, or decline: true.' };
    const result = await answerClarification(actor, clarificationId, response);
    return 'refused' in result ? { refused: true, reason: result.refused, message: result.message } : { answered: true, clarificationId, message: 'Answered. The team resumes with the answer.' };
  },
};

export const reviewTools: WorkspaceActionTool[] = [reviewListTool, reviewDecideTool, clarificationAnswerTool];

