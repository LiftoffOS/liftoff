// Activity tools: the feed, one item, corrections (preview → confirm), the
// correction history, and running a failed autonomous run again (preview →
// confirm). Reads are any member's; the two writes need teams:update, and
// the correction service applies its own eligibility and permission rules.

import type { AgentAuditLog } from '../../agent-audit-logs/types';
import type { Actor } from '../actor';
import {
  canRerunActivityLog,
  correct,
  correctionHistory,
  correctionOptions,
  getActivity,
  listActivity,
  runAgain,
} from '../activity';
import { PreviewRefused, type WorkspaceActionTool } from './types';

function summariseLog(log: AgentAuditLog) {
  return {
    id: log.id,
    team: log.agentName ?? null,
    internalAgentId: log.internalAgentId,
    action: log.action,
    outcome: log.outcome,
    errorCode: log.errorCode,
    triggeredBy: log.triggeredBy,
    triggeredByTeam: log.triggeredByAgentName ?? null,
    summary: log.outputSummary ? log.outputSummary.slice(0, 300) : null,
    durationMs: log.durationMs,
    invocationId: log.invocationId,
    threadId: log.threadId,
    createdAt: log.createdAt,
    canRunAgain: canRerunActivityLog(log),
  };
}

function ids(input: Record<string, unknown>): string[] {
  if (Array.isArray(input.ids)) return input.ids.filter((v): v is string => typeof v === 'string' && v.length > 0).slice(0, 50);
  if (typeof input.id === 'string' && input.id) return [input.id];
  return [];
}

export const activityListTool: WorkspaceActionTool = {
  definition: {
    name: 'activity_list',
    description:
      'The Activity feed: what the agents did, newest first. Filter by agent (name), outcome (success, error, gated), action, a date range, or free text (q). Each item says whether it can be run again (canRunAgain) and carries the ids the other activity tools take.',
    input_schema: {
      type: 'object',
      properties: {
        team: { type: 'string', maxLength: 200, description: 'Only this agent, by name' },
        outcome: { type: 'string', enum: ['success', 'error', 'gated'] },
        action: { type: 'string', maxLength: 100 },
        q: { type: 'string', maxLength: 200, description: 'Free text across the agent, action, arguments and summary' },
        startDate: { type: 'string', description: 'ISO 8601' },
        endDate: { type: 'string', description: 'ISO 8601' },
        limit: { type: 'number', minimum: 1, maximum: 100 },
        cursor: { type: 'string', description: 'From a previous result' },
      },
    },
  },
  permission: null,
  async execute(input, actor: Actor) {
    const result = await listActivity(actor, {
      team: typeof input.team === 'string' ? input.team : undefined,
      outcome: input.outcome === 'success' || input.outcome === 'error' || input.outcome === 'gated' ? input.outcome : undefined,
      action: typeof input.action === 'string' ? input.action : undefined,
      q: typeof input.q === 'string' ? input.q : undefined,
      startDate: typeof input.startDate === 'string' ? input.startDate : undefined,
      endDate: typeof input.endDate === 'string' ? input.endDate : undefined,
      limit: typeof input.limit === 'number' ? input.limit : undefined,
      cursor: typeof input.cursor === 'string' ? input.cursor : undefined,
    });
    if ('refused' in result) return { refused: true, reason: result.refused, message: result.message };
    return { items: result.items.map(summariseLog), total: result.total, nextCursor: result.nextCursor };
  },
};

export const activityGetTool: WorkspaceActionTool = {
  definition: {
    name: 'activity_get',
    description: 'One Activity item in full: its arguments, its result, the snapshots around it, and whether it can be corrected or run again.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The activity item id' } },
      required: ['id'],
    },
  },
  permission: null,
  async execute(input, actor: Actor) {
    const id = String(input.id ?? '');
    const log = await getActivity(actor, id);
    if (!log) return { refused: true, reason: 'not_found', message: 'No activity item with that id.' };
    const options = await correctionOptions(actor, id);
    return {
      ...summariseLog(log),
      inputArgs: log.inputArgs,
      preActionSnapshot: log.preActionSnapshot,
      postActionSnapshot: log.postActionSnapshot,
      externalResponse: log.externalResponse,
      correction: options,
    };
  },
};

export const activityCorrectTool: WorkspaceActionTool = {
  definition: {
    name: 'activity_correct',
    description:
      'Undo or correct what an agent did, for one Activity item (id) or up to fifty (ids). Called without confirmationId it returns a preview from the correction options (what the correction would do, whether it needs a review) and a confirmationId; call again with it when the person agrees. The result is requested, gated (a review was opened; see review_list) or ineligible, with the reason.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        ids: { type: 'array', items: { type: 'string' }, maxItems: 50 },
        reason: { type: 'string', maxLength: 2048 },
        confirmationId: { type: 'string' },
      },
    },
  },
  permission: 'teams:update',
  mutating: true,
  async preview(input, actor: Actor) {
    const targets = ids(input);
    if (targets.length === 0) throw new PreviewRefused('validation', 'Provide id or ids.');
    const options = await Promise.all(targets.map(async (id) => ({ id, ...(await correctionOptions(actor, id)) })));
    return { items: options, reason: typeof input.reason === 'string' ? input.reason : undefined };
  },
  async execute(input, actor: Actor) {
    const targets = ids(input);
    if (targets.length === 0) return { refused: true, reason: 'validation', message: 'Provide id or ids.' };
    const result = await correct(actor, targets, typeof input.reason === 'string' ? input.reason : undefined);
    if ('single' in result) {
      const r = result.single;
      return {
        status: r.status,
        ...(r.correctionRequestId ? { correctionRequestId: r.correctionRequestId } : {}),
        ...(r.approvalRequestId ? { approvalRequestId: r.approvalRequestId } : {}),
        ...(r.error ? { error: r.error } : {}),
        message: r.status === 'gated'
          ? 'The correction needs a review before it runs; it is in the review queue (review_list).'
          : r.status === 'requested'
            ? 'The correction is requested.'
            : r.status === 'ineligible'
              ? 'This item cannot be corrected.'
              : 'The correction could not be requested.',
      };
    }
    return {
      summary: result.bulk.summary,
      results: result.bulk.results,
      message: `Requested ${result.bulk.summary.requested} of ${result.bulk.summary.total}; ${result.bulk.summary.ineligible} ineligible, ${result.bulk.summary.errors} failed.`,
    };
  },
};

export const activityCorrectionHistoryTool: WorkspaceActionTool = {
  definition: {
    name: 'activity_correction_history',
    description: 'The corrections made to one Activity item, in order.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  permission: null,
  async execute(input, actor: Actor) {
    const history = await correctionHistory(actor, String(input.id ?? ''));
    return { history };
  },
};

export const activityRunAgainTool: WorkspaceActionTool = {
  definition: {
    name: 'activity_run_again',
    description:
      'Run a failed scheduled or event-triggered run again. Called without confirmationId it returns a preview (the run, whether it is eligible) and a confirmationId; call again with it when the person agrees. The runtime decides whether the run can be repeated.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The activity item id of the run' },
        confirmationId: { type: 'string' },
      },
      required: ['id'],
    },
  },
  permission: 'teams:update',
  mutating: true,
  async preview(input, actor: Actor) {
    const log = await getActivity(actor, String(input.id ?? ''));
    if (!log) throw new PreviewRefused('not_found', 'No activity item with that id.');
    return { ...summariseLog(log), eligible: canRerunActivityLog(log) };
  },
  async execute(input, actor: Actor) {
    const result = await runAgain(actor, String(input.id ?? ''));
    if ('refused' in result) return { refused: true, reason: result.refused, message: result.message, ...(result.body !== undefined ? { runtime: result.body } : {}) };
    return { requested: true, runtime: result.body, message: 'The run is requested again; it appears in the Activity feed as it runs.' };
  },
};

export const activityTools: WorkspaceActionTool[] = [
  activityListTool,
  activityGetTool,
  activityCorrectTool,
  activityCorrectionHistoryTool,
  activityRunAgainTool,
];
