import express from 'express';
import request from 'supertest';
import { jest } from '@jest/globals';

const queryMock = jest.fn();
jest.mock('../../../infrastructure/database', () => ({
  withTenantScope: (_t: unknown, fn: (c: { query: typeof queryMock }) => Promise<unknown>) =>
    fn({ query: queryMock }),
}));
jest.mock('../../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('@liftoffos/service-client', () => ({
  verifyServiceAuth: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const postReviewDmFanoutMock = jest.fn<() => Promise<unknown>>();
const postDraftDmFanoutMock = jest.fn<() => Promise<unknown>>();
jest.mock('../review-dm-notifier', () => ({
  postReviewDmFanout: (...a: unknown[]) => postReviewDmFanoutMock(...(a as [])),
  postDraftDmFanout: (...a: unknown[]) => postDraftDmFanoutMock(...(a as [])),
}));

import { agentSlackInternalRouter } from '../internal-router';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/internal/agent-slack', agentSlackInternalRouter);
  return app;
}

beforeEach(() => {
  queryMock.mockReset();
  postReviewDmFanoutMock.mockReset().mockResolvedValue({ totalAssignees: 1, delivered: 1, unreachable: [] });
  postDraftDmFanoutMock.mockReset().mockResolvedValue({ totalAssignees: 1, delivered: 1, unreachable: [] });
});

const TENANT = '11111111-1111-1111-1111-111111111111';
const AGENT = '22222222-2222-2222-2222-222222222222';
const REVIEW = '33333333-3333-3333-3333-333333333333';
const ASSIGNEE = '44444444-4444-4444-4444-444444444444';

describe('POST /post-review-dm body validation (messaging OR generic action)', () => {
  const base = { reviewId: REVIEW, tenantId: TENANT, agentId: AGENT, assigneeAccountIds: [ASSIGNEE] };

  it('rejects (400) when neither messaging fields nor generic action are present', async () => {
    const res = await request(makeApp())
      .post('/api/internal/agent-slack/post-review-dm')
      .set('X-Service-Auth', 'test')
      .send({ ...base });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_body');
    expect(postReviewDmFanoutMock).not.toHaveBeenCalled();
  });

  it('accepts a messaging payload (channelId + draftText) and reaches the fan-out', async () => {
    const res = await request(makeApp())
      .post('/api/internal/agent-slack/post-review-dm')
      .set('X-Service-Auth', 'test')
      .send({ ...base, channelId: 'C1', draftText: 'hello' });
    expect(res.status).toBe(200);
    expect(postReviewDmFanoutMock).toHaveBeenCalledWith(
      expect.objectContaining({ reviewId: REVIEW, channelId: 'C1', draftText: 'hello' }),
    );
  });

  it('accepts a generic gated-tool payload (action only, no channel/draft) and reaches the fan-out', async () => {
    const res = await request(makeApp())
      .post('/api/internal/agent-slack/post-review-dm')
      .set('X-Service-Auth', 'test')
      .send({ ...base, action: 'Merge pull request #7 in acme/site', why: 'Reviews passed', detail: 'github · merge_pull_request' });
    expect(res.status).toBe(200);
    expect(postReviewDmFanoutMock).toHaveBeenCalledWith(
      expect.objectContaining({ reviewId: REVIEW, action: 'Merge pull request #7 in acme/site', why: 'Reviews passed' }),
    );
  });

  it('rejects (400) a half-messaging payload (channelId without draftText, no action)', async () => {
    const res = await request(makeApp())
      .post('/api/internal/agent-slack/post-review-dm')
      .set('X-Service-Auth', 'test')
      .send({ ...base, channelId: 'C1' });
    expect(res.status).toBe(400);
    expect(postReviewDmFanoutMock).not.toHaveBeenCalled();
  });
});

describe('GET /assignees fallback', () => {
  const get = () =>
    request(makeApp())
      .get(`/api/internal/agent-slack/assignees?tenantId=${TENANT}&agentId=${AGENT}`)
      .set('X-Service-Auth', 'test');

  it('returns explicit assignees when present', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ account_id: 'a1', role: 'admin' }, { account_id: 'a2', role: 'member' }],
    });
    const res = await get();
    expect(res.body).toEqual({ assigneeAccountIds: ['a1', 'a2'], visibility: 'assignees' });
  });

  // The bug this resolver exists to fix: assignment is a row, authority is a
  // role. A viewer used to be DM'd a card whose buttons threw on click.
  it('skips an assignee who cannot approve, and routes past them', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ account_id: 'viewer1', role: 'viewer' }] })
      .mockResolvedValueOnce({ rows: [{ account_id: 'admin1' }] });
    const res = await get();
    expect(res.body.assigneeAccountIds).toEqual(['admin1']);
    expect(res.body.fallback).toBe('admin_owner');
    // Still an assigned agent — its requests do not become everyone's business
    // just because the routing had to go past the assignee.
    expect(res.body.visibility).toBe('assignees');
  });

  // Level 1 needs admin or owner; a member assignee can take level 2 but not
  // level 1, so the same assignment resolves differently by level.
  it('routes past a member on a level 1 gate', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ account_id: 'm1', role: 'member' }] })
      .mockResolvedValueOnce({ rows: [{ account_id: 'admin1' }] });
    const res = await request(makeApp())
      .get(`/api/internal/agent-slack/assignees?tenantId=${TENANT}&agentId=${AGENT}&hitlLevel=1`)
      .set('X-Service-Auth', 'test');
    expect(res.body.assigneeAccountIds).toEqual(['admin1']);
  });

  it('falls back to admins+owners when no explicit assignees', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ account_id: 'admin1' }, { account_id: 'owner1' }] });
    const res = await get();
    expect(res.body).toEqual({
      assigneeAccountIds: ['admin1', 'owner1'],
      fallback: 'admin_owner',
      // Unassigned: the whole workspace sees it, per the routing model.
      visibility: 'workspace',
    });
  });

  it('returns empty list (no fallback) when tenant has no admins/owners', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    const res = await get();
    expect(res.body).toEqual({
      assigneeAccountIds: [],
      fallback: 'admin_owner',
      visibility: 'workspace',
    });
  });
});
