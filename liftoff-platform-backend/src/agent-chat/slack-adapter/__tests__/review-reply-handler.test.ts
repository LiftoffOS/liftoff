// Tests for review-reply-handler. Covers:
//   - parseReplyIntent grammar (approve / reject / reject:reason / unknown)
//   - no review match returns false
//   - approve happy path → approveApprovalAsService called
//   - reject with inline reason → rejectApprovalAsService called with reason
//   - unknown reply → posts "edit in Liftoff Dashboard" (link) and does NOT mutate
//   - already-actioned race → ack reflects no change

import { jest } from '@jest/globals';

type QueryFn = (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
const tenantQueryMock = jest.fn<QueryFn>();
jest.mock('../../../infrastructure/database', () => ({
  withTenantScope: jest.fn(
    async (
      _tenantId: string,
      fn: (c: { query: typeof tenantQueryMock }) => Promise<unknown>,
    ) => fn({ query: tenantQueryMock }),
  ),
}));

jest.mock('../../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const slackApiFetchMock = jest.fn<(m: string, o: unknown) => Promise<Record<string, unknown>>>();
jest.mock('../slack-api', () => ({
  slackApiFetch: (m: string, o: unknown) => slackApiFetchMock(m, o),
}));

const approveMock = jest.fn<(input: unknown) => Promise<{ alreadyActioned: boolean; approvalId: string }>>();
const rejectMock = jest.fn<(input: unknown) => Promise<{ alreadyActioned: boolean; approvalId: string }>>();
jest.mock('../../../internal-agent-oversight/service-internal', () => ({
  approveApprovalAsService: (i: unknown) => approveMock(i),
  rejectApprovalAsService: (i: unknown) => rejectMock(i),
}));

jest.mock('../review-dm-notifier', () => ({
  chatUpdateAllSiblingCards: jest.fn(async () => undefined),
  reviewDashboardUrl: (reviewId: string) => `https://app.example.com/dashboard/review?approvalId=${reviewId}`,
}));

beforeEach(() => {
  jest.clearAllMocks();
});

describe('parseReplyIntent', () => {
  const cases: Array<[string, { kind: string; reason?: string }]> = [
    ['approve', { kind: 'approve' }],
    ['YES', { kind: 'approve' }],
    ['  send  ', { kind: 'approve' }],
    ['ok', { kind: 'approve' }],
    ['reject', { kind: 'reject' }],
    ['no', { kind: 'reject' }],
    ['cancel', { kind: 'reject' }],
    ['discard', { kind: 'reject' }],
    ['reject: pricing claim wrong', { kind: 'reject', reason: 'pricing claim wrong' }],
    ['no: too aggressive', { kind: 'reject', reason: 'too aggressive' }],
    ['please change to Friday', { kind: 'unknown' }],
    ['hi there', { kind: 'unknown' }],
    ['', { kind: 'unknown' }],
  ];

  it.each(cases)('parses %p → %o', async (input, expected) => {
    const { parseReplyIntent } = await import('../review-reply-handler');
    const parsed = parseReplyIntent(input);
    expect(parsed.kind).toBe(expected.kind);
    if (expected.kind === 'reject' && expected.reason !== undefined) {
      expect((parsed as { reason?: string }).reason).toBe(expected.reason);
    }
  });

  it('caps the rejection reason at 2048 chars', async () => {
    const { parseReplyIntent } = await import('../review-reply-handler');
    const long = 'x'.repeat(3000);
    const parsed = parseReplyIntent(`reject: ${long}`);
    expect(parsed.kind).toBe('reject');
    expect(((parsed as { reason: string }).reason).length).toBe(2048);
  });
});

describe('handleReviewThreadReply', () => {
  it('returns false when no review row matches the thread root', async () => {
    const { handleReviewThreadReply } = await import('../review-reply-handler');
    tenantQueryMock.mockResolvedValueOnce({ rows: [] });

    const handled = await handleReviewThreadReply({
      tenantId: 't1', slackTeamId: 'T1', channelId: 'D1', rootTs: 'x.0',
      slackUserId: 'U1', text: 'approve', botToken: 'xoxb',
    });

    expect(handled).toBe(false);
    expect(approveMock).not.toHaveBeenCalled();
  });

  it('approve happy path → calls approveApprovalAsService + posts ack', async () => {
    const { handleReviewThreadReply } = await import('../review-reply-handler');
    tenantQueryMock.mockResolvedValueOnce({
      rows: [{ review_id: 'rev_1', assignee_account_id: 'a1' }],
    });
    approveMock.mockResolvedValueOnce({ alreadyActioned: false, approvalId: 'rev_1' });
    slackApiFetchMock.mockResolvedValue({ ok: true });

    const handled = await handleReviewThreadReply({
      tenantId: 't1', slackTeamId: 'T1', channelId: 'D1', rootTs: 'x.0',
      slackUserId: 'U1', text: 'approve', botToken: 'xoxb',
    });

    expect(handled).toBe(true);
    expect(approveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: 'rev_1',
        slackUserId: 'U1',
        alwaysApply: false,
      }),
    );
    const post = slackApiFetchMock.mock.calls.find((c) => c[0] === 'chat.postMessage');
    expect(post).toBeDefined();
    expect(((post![1] as { body: { value: { text: string } } }).body.value.text)).toContain('Sent');
  });

  it('reject with inline reason → forwards reason', async () => {
    const { handleReviewThreadReply } = await import('../review-reply-handler');
    tenantQueryMock.mockResolvedValueOnce({
      rows: [{ review_id: 'rev_2', assignee_account_id: 'a1' }],
    });
    rejectMock.mockResolvedValueOnce({ alreadyActioned: false, approvalId: 'rev_2' });
    slackApiFetchMock.mockResolvedValue({ ok: true });

    await handleReviewThreadReply({
      tenantId: 't1', slackTeamId: 'T1', channelId: 'D1', rootTs: 'x.0',
      slackUserId: 'U1', text: 'reject: tone wrong', botToken: 'xoxb',
    });

    expect(rejectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: 'rev_2',
        reason: 'tone wrong',
        alwaysApply: false,
      }),
    );
  });

  it('unknown reply → directs user to Dashboard deeplink and does NOT mutate', async () => {
    const { handleReviewThreadReply } = await import('../review-reply-handler');
    tenantQueryMock.mockResolvedValueOnce({
      rows: [{ review_id: 'rev_3', assignee_account_id: 'a1' }],
    });
    slackApiFetchMock.mockResolvedValue({ ok: true });

    const handled = await handleReviewThreadReply({
      tenantId: 't1', slackTeamId: 'T1', channelId: 'D1', rootTs: 'x.0',
      slackUserId: 'U1', text: 'change it to friday', botToken: 'xoxb',
    });

    expect(handled).toBe(true);
    expect(approveMock).not.toHaveBeenCalled();
    expect(rejectMock).not.toHaveBeenCalled();
    const post = slackApiFetchMock.mock.calls.find((c) => c[0] === 'chat.postMessage');
    const txt = (post![1] as { body: { value: { text: string } } }).body.value.text;
    expect(txt).toContain('edit in <');
    expect(txt).toContain('|Liftoff Dashboard>');
    expect(txt).toContain('/dashboard/review?approvalId=');
  });

  it('already-actioned → ack says no change made', async () => {
    const { handleReviewThreadReply } = await import('../review-reply-handler');
    tenantQueryMock.mockResolvedValueOnce({
      rows: [{ review_id: 'rev_4', assignee_account_id: 'a1' }],
    });
    approveMock.mockResolvedValueOnce({ alreadyActioned: true, approvalId: 'rev_4' });
    slackApiFetchMock.mockResolvedValue({ ok: true });

    await handleReviewThreadReply({
      tenantId: 't1', slackTeamId: 'T1', channelId: 'D1', rootTs: 'x.0',
      slackUserId: 'U1', text: 'approve', botToken: 'xoxb',
    });

    const post = slackApiFetchMock.mock.calls.find((c) => c[0] === 'chat.postMessage');
    expect(((post![1] as { body: { value: { text: string } } }).body.value.text))
      .toContain('Already handled');
  });
});
