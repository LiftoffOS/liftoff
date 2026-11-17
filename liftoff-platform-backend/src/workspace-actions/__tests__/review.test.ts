// decideReview — one decision path for every surface: a Slack-origin decision
// now emits approval.decided and posts to the thread; a standing decision is
// dropped where the gate does not allow one; the level rule refuses a viewer.

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));

const mockGetApproval = jest.fn();
const mockApprove = jest.fn();
const mockReject = jest.fn();
const mockRespond = jest.fn();
const mockDecline = jest.fn();
jest.mock('../../connectors/tenant-runtime-client', () => ({
  HitlError: class HitlError extends Error {
    constructor(message: string, public readonly status: number, public readonly errorCode: string, public readonly details?: Record<string, unknown>) { super(message); }
  },
  tenantRuntimeClient: {
    getApproval: (...a: unknown[]) => mockGetApproval(...a),
    approveRequest: (...a: unknown[]) => mockApprove(...a),
    rejectRequest: (...a: unknown[]) => mockReject(...a),
    respondToClarification: (...a: unknown[]) => mockRespond(...a),
    declineClarification: (...a: unknown[]) => mockDecline(...a),
    listPendingApprovals: jest.fn(),
    getPendingApprovalCount: jest.fn(),
  },
}));

const mockEnqueueLifecycle = jest.fn(async () => ({ queued: 1 }));
jest.mock('../../event-sources/outbound-webhooks', () => ({
  enqueueLifecycleEvent: (...a: unknown[]) => mockEnqueueLifecycle(...a),
}));

const mockAppendMessage = jest.fn(async () => undefined);
jest.mock('../../agent-chat/chat-repository', () => ({
  appendMessage: (...a: unknown[]) => mockAppendMessage(...a),
}));
jest.mock('../../agent-chat/hitl-status-message', () => ({
  decisionMessage: (decision: string, by: string | null) => `${decision} by ${by ?? 'someone'}`,
  HITL_STATUS_MESSAGE_TYPE: 'hitl_status',
}));
const mockSlackCards = jest.fn(async () => undefined);
jest.mock('../../agent-chat/slack-adapter/review-dm-notifier', () => ({
  chatUpdateAllSiblingCards: (...a: unknown[]) => mockSlackCards(...a),
}));
const mockTeamsCards = jest.fn(async () => undefined);
jest.mock('../../agent-chat/teams-adapter/review-card-notifier', () => ({
  updateAllReviewCards: (...a: unknown[]) => mockTeamsCards(...a),
}));

import { decideReview, answerClarification, declineClarification, standingApprovalAllowed } from '../review';
import type { Actor } from '../actor';
import { logAudit } from '../../infrastructure/logging';
import { HitlError } from '../../connectors/tenant-runtime-client';

const TENANT = '22222222-2222-2222-2222-222222222222';
const APPROVAL = '66666666-6666-4666-8666-666666666666';
const ACCOUNT = '77777777-7777-7777-7777-777777777777';
const RUNTIME_AGENT = 'runtime-agent-1';

function actor(role: Actor['role'], surface: Actor['surface']): Actor {
  return { tenantId: TENANT, accountId: ACCOUNT, role, displayName: 'Ada Lovelace', surface };
}

const PENDING = {
  id: APPROVAL, agentId: RUNTIME_AGENT, hitlLevel: 2, reason: 'destructive_gate', threadId: 'thread-1',
  status: 'pending', pendingToolCalls: [{ id: 'c1', name: 'send_email', input: {} }],
};

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 10));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetApproval.mockResolvedValue(PENDING);
  mockApprove.mockResolvedValue({ ...PENDING, status: 'approved' });
  mockReject.mockResolvedValue({ ...PENDING, status: 'rejected' });
});

describe('decideReview', () => {
  it('a Slack-surface decision emits approval.decided and posts the outcome to the thread', async () => {
    const result = await decideReview(actor('member', 'slack'), APPROVAL, 'approve', {});
    expect('approval' in result).toBe(true);
    expect(mockApprove).toHaveBeenCalledWith(TENANT, APPROVAL, ACCOUNT, 'member', false, undefined, undefined);
    expect(mockEnqueueLifecycle).toHaveBeenCalledWith({
      tenantId: TENANT,
      eventType: 'approval.decided',
      payload: { approvalId: APPROVAL, agentId: RUNTIME_AGENT, decision: 'approved', decidedBy: ACCOUNT, alwaysApply: false },
    });
    await settle();
    expect(mockAppendMessage).toHaveBeenCalledWith(TENANT, 'thread-1', 'assistant', 'approved by Ada Lovelace', RUNTIME_AGENT, null, 0, 0, 'hitl_status');
    expect(mockSlackCards).toHaveBeenCalledWith({ reviewId: APPROVAL, tenantId: TENANT, footer: 'Approved via Slack.' });
    expect(mockTeamsCards).toHaveBeenCalledWith(TENANT, APPROVAL, RUNTIME_AGENT, 'Approved via Slack.');
    expect(logAudit).toHaveBeenCalledWith(
      'hitl.approved',
      { tenantId: TENANT, userId: ACCOUNT, operation: 'slack' },
      expect.objectContaining({ approvalId: APPROVAL, surface: 'slack' }),
    );
  });

  it('alwaysApply is dropped for super_destructive_gate and the audit says so', async () => {
    mockGetApproval.mockResolvedValue({ ...PENDING, reason: 'super_destructive_gate' });
    const result = await decideReview(actor('admin', 'liftoff'), APPROVAL, 'approve', { alwaysApply: true });
    expect('approval' in result).toBe(true);
    expect(mockApprove).toHaveBeenCalledWith(TENANT, APPROVAL, ACCOUNT, 'admin', false, undefined, undefined);
    expect(logAudit).toHaveBeenCalledWith('hitl.approved', expect.anything(), expect.objectContaining({ alwaysApply: false, standingDropped: true }));
    expect(standingApprovalAllowed('super_destructive_gate')).toBe(false);
    expect(standingApprovalAllowed('destructive_gate')).toBe(true);
  });

  it('alwaysApply is kept where the gate allows a standing decision', async () => {
    await decideReview(actor('admin', 'dashboard'), APPROVAL, 'reject', { alwaysApply: true, reason: 'no' });
    expect(mockReject).toHaveBeenCalledWith(TENANT, APPROVAL, ACCOUNT, 'admin', 'no', true);
    expect(mockEnqueueLifecycle).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ decision: 'rejected', reason: 'no', alwaysApply: true }),
    }));
  });

  it('viewer → forbidden; nothing is written', async () => {
    const result = await decideReview(actor('viewer', 'insights'), APPROVAL, 'approve', {});
    expect(result).toMatchObject({ refused: 'forbidden', status: 403 });
    expect(mockApprove).not.toHaveBeenCalled();
  });

  it('a level-1 approval refuses a member; an unreadable approval is treated as level 1', async () => {
    mockGetApproval.mockResolvedValueOnce({ ...PENDING, hitlLevel: 1 });
    expect(await decideReview(actor('member', 'dashboard'), APPROVAL, 'approve', {})).toMatchObject({ refused: 'forbidden' });
    mockGetApproval.mockResolvedValueOnce(null);
    expect(await decideReview(actor('member', 'dashboard'), APPROVAL, 'approve', {})).toMatchObject({ refused: 'forbidden' });
    mockGetApproval.mockResolvedValueOnce(null);
    // An admin may decide an unreadable one; the runtime answers.
    expect('approval' in (await decideReview(actor('admin', 'dashboard'), APPROVAL, 'approve', {}))).toBe(true);
  });

  it('maps the runtime refusals, with the late-feedback pointer on an expired one', async () => {
    mockApprove.mockRejectedValueOnce(new HitlError('has expired', 410, 'EXPIRED', { approvalId: APPROVAL }));
    expect(await decideReview(actor('member', 'dashboard'), APPROVAL, 'approve', {})).toMatchObject({
      refused: 'expired', status: 410, code: 'EXPIRED',
      lateFeedbackEndpoint: `/api/internal-agent-oversight/hitl-approvals/${APPROVAL}/late-feedback`,
    });
    mockApprove.mockRejectedValueOnce(new HitlError('request status is approved', 409, 'ALREADY_DECIDED'));
    expect(await decideReview(actor('member', 'dashboard'), APPROVAL, 'approve', {})).toMatchObject({ refused: 'already_decided', status: 409 });
    expect(mockEnqueueLifecycle).not.toHaveBeenCalled();
  });

  it('passes edited tool inputs and the note through on approve', async () => {
    await decideReview(actor('member', 'dashboard'), APPROVAL, 'approve', {
      approvalNote: '  looks right  ', editedToolInputs: { c1: { to: 'x@y.z' } },
    });
    expect(mockApprove).toHaveBeenCalledWith(TENANT, APPROVAL, ACCOUNT, 'member', false, 'looks right', { c1: { to: 'x@y.z' } });
  });
});

describe('clarifications', () => {
  it('answer and decline go to the runtime as the person and are audited', async () => {
    expect(await answerClarification(actor('member', 'liftoff'), 'c-1', 'go ahead')).toEqual({ done: true });
    expect(mockRespond).toHaveBeenCalledWith(TENANT, 'c-1', 'go ahead', ACCOUNT);
    expect(await declineClarification(actor('member', 'liftoff'), 'c-1', 'cannot say')).toEqual({ done: true });
    expect(mockDecline).toHaveBeenCalledWith(TENANT, 'c-1', ACCOUNT, 'cannot say');
    expect(logAudit).toHaveBeenCalledWith('hitl.clarification_answered', expect.anything(), expect.objectContaining({ clarificationId: 'c-1' }));
    expect(logAudit).toHaveBeenCalledWith('hitl.clarification_declined', expect.anything(), expect.objectContaining({ clarificationId: 'c-1', reason: 'cannot say' }));
  });

  it('maps already-resolved and not-found', async () => {
    mockRespond.mockRejectedValueOnce(new Error('clarification already resolved or not found'));
    expect(await answerClarification(actor('member', 'liftoff'), 'c-1', 'x')).toMatchObject({ refused: 'already_resolved' });
    mockDecline.mockRejectedValueOnce(Object.assign(new Error('gone'), { status: 404 }));
    expect(await declineClarification(actor('member', 'liftoff'), 'c-1')).toMatchObject({ refused: 'not_found' });
  });
});
