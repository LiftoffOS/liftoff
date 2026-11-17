// GET /api/internal/agent-slack/installs — the workspace-app virtual install
// (ADR-040) is now the ONLY install: per-agent apps are gone. The entry is
// tenant-keyed, so ANY live agent id — including agents created after the
// workspace was connected — receives the slack_* tool surface, with postAs
// carrying the agent's display name.

import express from 'express';
import request from 'supertest';
import { jest } from '@jest/globals';

const queryMock = jest.fn<(...a: unknown[]) => Promise<{ rows: unknown[] }>>();
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
jest.mock('../review-dm-notifier', () => ({
  postReviewDmFanout: jest.fn(),
  postDraftDmFanout: jest.fn(),
}));

const resolveWsTokenMock = jest.fn<() => Promise<string | null>>();
jest.mock('../bot-token-service', () => ({
  resolveWorkspaceBotToken: (...a: unknown[]) => resolveWsTokenMock(...(a as [])),
  storeWorkspaceBotToken: jest.fn(),
}));

const getWsInstallMock = jest.fn<() => Promise<unknown>>();
jest.mock('../workspace-repository', () => ({
  getInstalledWorkspaceInstall: (...a: unknown[]) => getWsInstallMock(...(a as [])),
}));
jest.mock('../workspace-app', () => ({
  getLiftoffSlackAppId: () => 'A0LIFTOFF',
}));

import { agentSlackInternalRouter } from '../internal-router';

const TENANT = '11111111-1111-1111-1111-111111111111';
const AGENT = '22222222-2222-2222-2222-222222222222';

const WS_INSTALL = {
  id: 'ws-row-1', tenantId: TENANT, slackTeamId: 'T1', slackTeamName: 'Acme',
  slackBotUserId: 'UBOT', slackBotTokenSecretPath: 'p', installStatus: 'installed',
  installedAt: '2026-08-01T00:00:00.000Z',
};

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/internal/agent-slack', agentSlackInternalRouter);
  return app;
}

const get = () =>
  request(makeApp())
    .get(`/api/internal/agent-slack/installs?tenantId=${TENANT}&agentId=${AGENT}`)
    .set('X-Service-Auth', 'test');

beforeEach(() => {
  jest.clearAllMocks();
  getWsInstallMock.mockResolvedValue(WS_INSTALL);
  resolveWsTokenMock.mockResolvedValue('xoxb-ws');
  queryMock.mockResolvedValue({ rows: [{ display_name: 'Code Reviewer' }] });
});

describe('GET /installs — workspace virtual install', () => {
  it('returns the virtual install with kind + postAs for an agent with no per-agent installs', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.installs).toEqual([
      {
        installId: 'ws:ws-row-1',
        slackAppId: 'A0LIFTOFF',
        slackTeamId: 'T1',
        slackTeamName: 'Acme',
        slackBotUserId: 'UBOT',
        installedAt: '2026-08-01T00:00:00.000Z',
        botToken: 'xoxb-ws',
        kind: 'workspace',
        postAs: { username: 'Code Reviewer' },
      },
    ]);
  });

  it('returns no virtual install for an unknown/deleted agent id', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    const res = await get();
    expect(res.body.installs).toEqual([]);
  });

  it('returns no virtual install when the workspace app is not installed', async () => {
    getWsInstallMock.mockResolvedValue(null);
    const res = await get();
    expect(res.body.installs).toEqual([]);
  });

  it('omits the virtual install when the workspace token cannot be resolved', async () => {
    resolveWsTokenMock.mockResolvedValue(null);
    const res = await get();
    expect(res.body.installs).toEqual([]);
  });
});
