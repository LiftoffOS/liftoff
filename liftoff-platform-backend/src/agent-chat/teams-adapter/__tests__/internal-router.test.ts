import express from 'express';
import request from 'supertest';
import { jest } from '@jest/globals';

// Teams internal-router pulls repository / sender / app-service at import time;
// stub them so the module loads without DB or Graph calls. The schema refine on
// /post-review-card (draftText messaging OR generic action) is the unit here.
const postReviewCardFanoutMock = jest.fn<() => Promise<unknown>>();
jest.mock('../review-card-notifier', () => ({
  postReviewCardFanout: (...a: unknown[]) => postReviewCardFanoutMock(...(a as [])),
}));
jest.mock('../repository', () => ({
  listConversationsForAgent: jest.fn(),
  getTenantInstall: jest.fn(),
  findPersonalConversationByUser: jest.fn(),
  getChannelMetaByConversation: jest.fn(),
}));
jest.mock('../teams-sender', () => ({ sendToConversation: jest.fn() }));
jest.mock('../teams-app-service', () => ({
  getUserInfo: jest.fn(),
  getChannelThreadReplies: jest.fn(),
  proactiveInstallForUser: jest.fn(),
}));
jest.mock('../../../infrastructure/database', () => ({
  withTenantScope: (_t: unknown, fn: (c: unknown) => Promise<unknown>) => fn({ query: jest.fn() }),
}));
jest.mock('../../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('@liftoffos/service-client', () => ({
  verifyServiceAuth: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import { agentTeamsInternalRouter } from '../internal-router';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/internal/agent-teams', agentTeamsInternalRouter);
  return app;
}

const TENANT = '11111111-1111-1111-1111-111111111111';
const AGENT = '22222222-2222-2222-2222-222222222222';
const REVIEW = '33333333-3333-3333-3333-333333333333';
const ASSIGNEE = '44444444-4444-4444-4444-444444444444';

beforeEach(() => {
  postReviewCardFanoutMock.mockReset().mockResolvedValue({ totalAssignees: 1, delivered: 1, unreachable: [] });
});

describe('POST /post-review-card body validation (messaging OR generic action)', () => {
  const base = { reviewId: REVIEW, tenantId: TENANT, agentId: AGENT, assigneeAccountIds: [ASSIGNEE] };

  it('rejects (400) when neither draftText nor generic action are present', async () => {
    const res = await request(makeApp())
      .post('/api/internal/agent-teams/post-review-card')
      .set('X-Service-Auth', 'test')
      .send({ ...base });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_body');
    expect(postReviewCardFanoutMock).not.toHaveBeenCalled();
  });

  it('accepts a messaging payload (draftText) and reaches the fan-out', async () => {
    const res = await request(makeApp())
      .post('/api/internal/agent-teams/post-review-card')
      .set('X-Service-Auth', 'test')
      .send({ ...base, draftText: 'hello' });
    expect(res.status).toBe(200);
    expect(postReviewCardFanoutMock).toHaveBeenCalledWith(
      expect.objectContaining({ reviewId: REVIEW, draftText: 'hello' }),
    );
  });

  it('accepts a generic gated-tool payload (action only) and reaches the fan-out', async () => {
    const res = await request(makeApp())
      .post('/api/internal/agent-teams/post-review-card')
      .set('X-Service-Auth', 'test')
      .send({ ...base, action: 'Merge pull request #7 in acme/site', why: 'Reviews passed', detail: 'github · merge_pull_request' });
    expect(res.status).toBe(200);
    expect(postReviewCardFanoutMock).toHaveBeenCalledWith(
      expect.objectContaining({ reviewId: REVIEW, action: 'Merge pull request #7 in acme/site', why: 'Reviews passed' }),
    );
  });
});
