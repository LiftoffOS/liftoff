// emitHitlApprovalSideEffects — shared helper for Slack DM fan-out + SSE
// emit + audit log per pending tool call.
//
// helper is reachable from both the workflow tool_call path (executeToolCalls)
// and the autonomous adapter pause handlers. This test pins the three
// side-effect surfaces so a refactor doesn't silently skip one.

const postReviewDmMock = jest.fn();
const postReviewCardMock = jest.fn();
const listAgentAssigneesMock = jest.fn();
const emitHitlRequiredMock = jest.fn();
const insertAuditLogMock = jest.fn();

jest.mock('../../agent-chat/agent-slack-client', () => ({
  postReviewDm: (...a: unknown[]) => postReviewDmMock(...a),
  listAgentAssignees: (...a: unknown[]) => listAgentAssigneesMock(...a),
}));
jest.mock('../../agent-chat/agent-teams-client', () => ({
  postReviewCard: (...a: unknown[]) => postReviewCardMock(...a),
  listAgentAssignees: (...a: unknown[]) => listAgentAssigneesMock(...a),
}));
jest.mock('../../tool-gateway/agent-teams-tool-catalog', () => ({
  TEAMS_OUTBOUND_TOOL_NAMES: new Set(['teams_send_message']),
}));
jest.mock('../../streaming', () => ({
  streamingService: { emitHitlRequired: (...a: unknown[]) => emitHitlRequiredMock(...a) },
}));
jest.mock('../../audit', () => ({
  insertAuditLog: (...a: unknown[]) => insertAuditLogMock(...a),
}));
jest.mock('../../tool-gateway/agent-slack-tool-catalog', () => ({
  SLACK_OUTBOUND_TOOL_NAMES: new Set(['slack_send_message']),
}));
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { emitHitlApprovalSideEffects } from '../hitl-side-effects';
import type { ExecutionState } from '../types';

function makeState(threadId?: string): ExecutionState {
  return {
    context: {
      tenantId: 't1', agentId: 'a1',
      threadId, invocationId: 'inv-1',
      traceId: 'tr-1',
    },
  } as unknown as ExecutionState;
}

async function flushSetImmediate() {
  await new Promise((r) => setImmediate(r));
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.HITL_GENERIC_CARD_ENABLED;
  listAgentAssigneesMock.mockResolvedValue(['acct-a']);
  postReviewDmMock.mockResolvedValue({ totalAssignees: 1, delivered: 1, unreachable: [] });
  postReviewCardMock.mockResolvedValue({ totalAssignees: 1, delivered: 1, unreachable: [] });
});

describe('emitHitlApprovalSideEffects', () => {
  it('fires Slack postReviewDm for an outbound slack call', async () => {
    await emitHitlApprovalSideEffects({
      approvalId: 'appr-1',
      gateReason: 'communication_review',
      pendingToolCalls: [{ id: 'p1', name: 'slack_send_message', input: { channel: 'C1', text: 'hi' } }],
      state: makeState('thread-1'),
    });
    await flushSetImmediate();
    expect(postReviewDmMock).toHaveBeenCalledWith(
      expect.objectContaining({
        reviewId: 'appr-1', channelId: 'C1', draftText: 'hi',
        assigneeAccountIds: ['acct-a'],
      }),
    );
  });

  it('skips Slack fan-out for non-slack tool calls', async () => {
    await emitHitlApprovalSideEffects({
      approvalId: 'appr-2',
      gateReason: 'communication_review',
      pendingToolCalls: [{ id: 'p1', name: 'gmail__send_email', input: { to: 'x@y.com' } }],
      state: makeState('thread-1'),
    });
    await flushSetImmediate();
    expect(postReviewDmMock).not.toHaveBeenCalled();
  });

  it('emits hitl_required SSE when threadId is present', async () => {
    await emitHitlApprovalSideEffects({
      approvalId: 'appr-3',
      gateReason: 'communication_review',
      pendingToolCalls: [{ id: 'p1', name: 'gmail__send_email', input: {} }],
      state: makeState('thread-1'),
      expiresAt: new Date('2026-06-17T00:00:00Z'),
    });
    expect(emitHitlRequiredMock).toHaveBeenCalledWith(
      'thread-1', 'inv-1', 'appr-3', 'communication_review',
      expect.any(Array),
      expect.any(Date),
    );
  });

  it('skips SSE emit when no threadId (autonomous cron-fired run)', async () => {
    await emitHitlApprovalSideEffects({
      approvalId: 'appr-4',
      gateReason: 'communication_review',
      pendingToolCalls: [{ id: 'p1', name: 'gmail__send_email', input: {} }],
      state: makeState(undefined),
    });
    expect(emitHitlRequiredMock).not.toHaveBeenCalled();
  });

  it('audit-logs every pending tool call with outcome="gated"', async () => {
    await emitHitlApprovalSideEffects({
      approvalId: 'appr-5',
      gateReason: 'communication_review',
      pendingToolCalls: [
        { id: 'p1', name: 'gmail__send_email', input: { to: 'a@b.com' } },
        { id: 'p2', name: 'gmail__send_email', input: { to: 'c@d.com' } },
      ],
      state: makeState('thread-1'),
    });
    expect(insertAuditLogMock).toHaveBeenCalledTimes(2);
    expect(insertAuditLogMock).toHaveBeenCalledWith(null, 't1', expect.objectContaining({
      action: 'gmail__send_email', outcome: 'gated', triggeredBy: 'agent:a1',
    }));
  });

  it('fans out the GENERIC Action/Why/Details card for a non-messaging gated tool when the flag is on', async () => {
    process.env.HITL_GENERIC_CARD_ENABLED = 'true';
    await emitHitlApprovalSideEffects({
      approvalId: 'appr-2',
      gateReason: 'sensitive_work',
      pendingToolCalls: [{ id: 'p1', name: 'github__merge_pull_request', input: { pull_number: 7 } }],
      state: makeState('thread-1'),
      actionSummary: 'Merge pull request #7 in acme/site',
      whySummary: 'Both reviews approved',
      detail: 'github · merge_pull_request',
    });
    await flushSetImmediate();
    expect(postReviewDmMock).toHaveBeenCalledWith(expect.objectContaining({
      reviewId: 'appr-2', action: 'Merge pull request #7 in acme/site',
      why: 'Both reviews approved', detail: 'github · merge_pull_request',
    }));
    expect(postReviewCardMock).toHaveBeenCalledWith(expect.objectContaining({
      reviewId: 'appr-2', action: 'Merge pull request #7 in acme/site',
    }));
  });

  it('does NOT fan out a card for a non-messaging gated tool when the flag is off (current behavior)', async () => {
    await emitHitlApprovalSideEffects({
      approvalId: 'appr-3',
      gateReason: 'sensitive_work',
      pendingToolCalls: [{ id: 'p1', name: 'github__merge_pull_request', input: {} }],
      state: makeState('thread-1'),
      actionSummary: 'Merge a pull request', // present, but the flag is off → still suppressed
    });
    await flushSetImmediate();
    expect(postReviewDmMock).not.toHaveBeenCalled();
    expect(postReviewCardMock).not.toHaveBeenCalled();
  });
});
