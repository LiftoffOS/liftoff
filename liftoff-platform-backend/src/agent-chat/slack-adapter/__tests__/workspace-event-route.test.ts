// POST /api/internal/agent-slack/workspace-event — connector-service forwards
// signature-verified Slack events here. Slack allows ONE Events URL per app
// and connector-service owns it, because it also publishes every message onto
// connector-events for reactive subscriptions; this handler only acts on
// messages addressed to an agent, so owning the URL here would silence the bus.

import express from 'express';
import request from 'supertest';
import { jest } from '@jest/globals';

const verifyCalls: Array<{ tokenEnvVar?: string }> = [];
jest.mock('@liftoffos/service-client', () => ({
  verifyServiceAuth: (opts: { tokenEnvVar?: string }) => {
    verifyCalls.push(opts);
    return (_req: unknown, _res: unknown, next: () => void) => next();
  },
}));

jest.mock('../../../infrastructure/database', () => ({
  withTenantScope: jest.fn(async () => ({ rows: [] })),
}));
jest.mock('../../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  logAudit: jest.fn(),
}));
jest.mock('../review-dm-notifier', () => ({ postReviewDmFanout: jest.fn(), postDraftDmFanout: jest.fn() }));
jest.mock('../repository', () => ({ listInstalledInstalls: jest.fn(async () => []), findInstallByTeam: jest.fn() }));
jest.mock('../bot-token-service', () => ({
  resolveBotToken: jest.fn(), resolveWorkspaceBotToken: jest.fn(), storeWorkspaceBotToken: jest.fn(),
}));
jest.mock('../workspace-repository', () => ({
  getInstalledWorkspaceInstall: jest.fn(async () => null), upsertWorkspaceInstall: jest.fn(),
}));
jest.mock('../workspace-app', () => ({ getLiftoffSlackAppId: () => 'A0LIFTOFF' }));

const handleVerifiedMock = jest.fn(async (opts: { res: { sendStatus: (n: number) => void } }) => {
  opts.res.sendStatus(200);
});
jest.mock('../workspace-event-handler', () => ({
  handleVerifiedWorkspaceSlackEvent: (...a: unknown[]) =>
    handleVerifiedMock(...(a as [Parameters<typeof handleVerifiedMock>[0]])),
}));

import { slackWorkspaceEventRouter } from '../internal-router';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/internal/agent-slack/workspace-event', slackWorkspaceEventRouter);
  return app;
}

beforeEach(() => jest.clearAllMocks());

describe('POST /workspace-event', () => {
  it('authenticates with PLATFORM_CALLBACK_TOKEN (connector-service does not hold the agent-slack token)', () => {
    expect(verifyCalls.some((c) => c.tokenEnvVar === 'PLATFORM_CALLBACK_TOKEN')).toBe(true);
  });

  it('routes a forwarded envelope without re-verifying the Slack signature', async () => {
    const envelope = {
      team_id: 'T1',
      api_app_id: 'A0LIFTOFF',
      event_id: 'Ev1',
      event: { type: 'message', channel_type: 'im', channel: 'D1', user: 'U1', text: 'hi', ts: '1.0' },
    };
    const res = await request(makeApp())
      .post('/api/internal/agent-slack/workspace-event')
      .send(envelope);
    expect(res.status).toBe(200);
    expect(handleVerifiedMock).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.objectContaining({ team_id: 'T1' }) }),
    );
  });

  it('rejects an envelope with no event', async () => {
    const res = await request(makeApp())
      .post('/api/internal/agent-slack/workspace-event')
      .send({ team_id: 'T1' });
    expect(res.status).toBe(400);
    expect(handleVerifiedMock).not.toHaveBeenCalled();
  });
});
