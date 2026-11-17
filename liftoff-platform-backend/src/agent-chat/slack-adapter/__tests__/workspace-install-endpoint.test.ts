// POST /api/internal/agent-slack/workspace-install — connector-service hands
// the slack dual-grant's BOT token here (ADR-040). Auth is
// PLATFORM_CALLBACK_TOKEN (the CS/TR → PB callback secret), NOT
// AGENT_SLACK_SERVICE_TOKEN; the endpoint stores the token in Secret Manager
// and upserts slack_workspace_installs.

import express from 'express';
import request from 'supertest';
import { jest } from '@jest/globals';

// Capture which env var the router's verifyServiceAuth pinned.
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
jest.mock('../review-dm-notifier', () => ({
  postReviewDmFanout: jest.fn(),
  postDraftDmFanout: jest.fn(),
}));
jest.mock('../repository', () => ({
  listInstalledInstalls: jest.fn(async () => []),
  findInstallByTeam: jest.fn(),
}));

const storeWsTokenMock = jest.fn<() => Promise<string>>();
jest.mock('../bot-token-service', () => ({
  resolveBotToken: jest.fn(),
  resolveWorkspaceBotToken: jest.fn(),
  storeWorkspaceBotToken: (...a: unknown[]) => storeWsTokenMock(...(a as [])),
}));

const upsertWsInstallMock = jest.fn<() => Promise<void>>();
jest.mock('../workspace-repository', () => ({
  getInstalledWorkspaceInstall: jest.fn(async () => null),
  upsertWorkspaceInstall: (...a: unknown[]) => upsertWsInstallMock(...(a as [])),
}));
jest.mock('../workspace-app', () => ({
  getLiftoffSlackAppId: () => 'A0LIFTOFF',
}));

const getByFirebaseUidMock = jest.fn<() => Promise<{ id: string } | null>>();
jest.mock('../../../accounts/service', () => ({
  AccountService: jest.fn().mockImplementation(() => ({
    getByFirebaseUid: (...a: unknown[]) => getByFirebaseUidMock(...(a as [])),
  })),
}));

import { slackWorkspaceInstallRouter } from '../internal-router';

const TENANT = '11111111-1111-1111-1111-111111111111';
const ACCOUNT = '33333333-3333-3333-3333-333333333333';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/internal/agent-slack/workspace-install', slackWorkspaceInstallRouter);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  storeWsTokenMock.mockResolvedValue('projects/example-project/secrets/slack-ws-bot-x/versions/latest');
  upsertWsInstallMock.mockResolvedValue(undefined);
});

describe('POST /workspace-install', () => {
  it('authenticates with PLATFORM_CALLBACK_TOKEN (not the agent-slack service token)', () => {
    expect(verifyCalls.some((c) => c.tokenEnvVar === 'PLATFORM_CALLBACK_TOKEN')).toBe(true);
  });

  it('stores the bot token and upserts the install row', async () => {
    const res = await request(makeApp())
      .post('/api/internal/agent-slack/workspace-install')
      .send({
        tenantId: TENANT,
        slackTeamId: 'T1',
        slackTeamName: 'Acme',
        slackBotUserId: 'UBOT',
        botToken: 'xoxb-new',
        installedByAccountId: ACCOUNT,
      });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(storeWsTokenMock).toHaveBeenCalledWith(TENANT, 'T1', 'xoxb-new');
    expect(upsertWsInstallMock).toHaveBeenCalledWith({
      tenantId: TENANT,
      slackTeamId: 'T1',
      slackTeamName: 'Acme',
      slackBotUserId: 'UBOT',
      slackBotTokenSecretPath: 'projects/example-project/secrets/slack-ws-bot-x/versions/latest',
      installedByAccountId: ACCOUNT,
    });
  });

  it('resolves a Firebase-uid installer to the account id (the first live handoff sent one)', async () => {
    getByFirebaseUidMock.mockResolvedValue({ id: ACCOUNT });
    const res = await request(makeApp())
      .post('/api/internal/agent-slack/workspace-install')
      .send({
        tenantId: TENANT,
        slackTeamId: 'T1',
        slackBotUserId: 'UBOT',
        botToken: 'xoxb-new',
        installedByAccountId: 'F6wbR2SXrBhe6aMT398J38pNzb53',
      });
    expect(res.status).toBe(200);
    expect(getByFirebaseUidMock).toHaveBeenCalledWith('F6wbR2SXrBhe6aMT398J38pNzb53');
    expect(upsertWsInstallMock).toHaveBeenCalledWith(
      expect.objectContaining({ installedByAccountId: ACCOUNT }),
    );
  });

  it('falls back to null attribution when the installer cannot be resolved (install must not fail)', async () => {
    getByFirebaseUidMock.mockResolvedValue(null);
    const res = await request(makeApp())
      .post('/api/internal/agent-slack/workspace-install')
      .send({
        tenantId: TENANT,
        slackTeamId: 'T1',
        slackBotUserId: 'UBOT',
        botToken: 'xoxb-new',
        installedByAccountId: 'unknown-uid',
      });
    expect(res.status).toBe(200);
    expect(upsertWsInstallMock).toHaveBeenCalledWith(
      expect.objectContaining({ installedByAccountId: null }),
    );
  });

  it('rejects a payload without a bot token', async () => {
    const res = await request(makeApp())
      .post('/api/internal/agent-slack/workspace-install')
      .send({ tenantId: TENANT, slackTeamId: 'T1', slackBotUserId: 'UBOT' });
    expect(res.status).toBe(400);
    expect(storeWsTokenMock).not.toHaveBeenCalled();
    expect(upsertWsInstallMock).not.toHaveBeenCalled();
  });

  it('500s (so connector-service logs it) when the secret store fails', async () => {
    storeWsTokenMock.mockRejectedValue(new Error('sm down'));
    const res = await request(makeApp())
      .post('/api/internal/agent-slack/workspace-install')
      .send({
        tenantId: TENANT,
        slackTeamId: 'T1',
        slackBotUserId: 'UBOT',
        botToken: 'xoxb-new',
      });
    expect(res.status).toBe(500);
    expect(upsertWsInstallMock).not.toHaveBeenCalled();
  });
});
