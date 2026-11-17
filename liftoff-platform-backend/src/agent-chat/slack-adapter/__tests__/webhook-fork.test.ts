// Webhook fork (ADR-040): events whose api_app_id is the Liftoff workspace
// app route to the workspace event handler; other app ids keep the legacy
// per-agent path (which acks-and-ignores unknown apps).

import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

jest.mock('../../../infrastructure/database', () => ({
  getPool: jest.fn().mockReturnValue({ query: jest.fn(async () => ({ rows: [], rowCount: 1 })) }),
  withAdminScope: jest.fn(async () => ({ rows: [] })),
  withTenantScope: jest.fn(async () => ({ rows: [] })),
}));
jest.mock('../../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../bot-token-service', () => ({
  resolveBotToken: jest.fn(),
}));

jest.mock('../workspace-app', () => ({
  isWorkspaceAppEvent: (id: string | undefined) => id === 'A0LIFTOFF',
}));

const handleWorkspaceMock = jest.fn(async (opts: { res: { sendStatus: (n: number) => void } }) => {
  opts.res.sendStatus(200);
});
jest.mock('../workspace-event-handler', () => ({
  handleWorkspaceSlackEvent: (...a: unknown[]) => handleWorkspaceMock(...(a as [Parameters<typeof handleWorkspaceMock>[0]])),
}));

import { slackWebhookRouter } from '../webhook-router';

function makeApp() {
  const app = express();
  app.use('/events', express.raw({ type: 'application/json' }), slackWebhookRouter);
  return app;
}

beforeEach(() => jest.clearAllMocks());

describe('webhook api_app_id fork', () => {
  it('answers url_verification without touching either branch', async () => {
    const res = await request(makeApp())
      .post('/events')
      .set('content-type', 'application/json')
      .send(JSON.stringify({ type: 'url_verification', challenge: 'ch-1' }));
    expect(res.body).toEqual({ challenge: 'ch-1' });
    expect(handleWorkspaceMock).not.toHaveBeenCalled();
  });

  it('routes the workspace app id to the workspace handler with raw body + headers', async () => {
    const body = JSON.stringify({ api_app_id: 'A0LIFTOFF', team_id: 'T1', event: {} });
    const res = await request(makeApp())
      .post('/events')
      .set('content-type', 'application/json')
      .set('x-slack-request-timestamp', '111')
      .set('x-slack-signature', 'v0=abc')
      .send(body);
    expect(res.status).toBe(200);
    expect(handleWorkspaceMock).toHaveBeenCalledTimes(1);
    const opts = handleWorkspaceMock.mock.calls[0][0] as unknown as {
      rawBody: Buffer; timestamp: string; signature: string; body: { api_app_id: string };
    };
    expect(opts.rawBody.toString()).toBe(body);
    expect(opts.timestamp).toBe('111');
    expect(opts.signature).toBe('v0=abc');
    expect(opts.body.api_app_id).toBe('A0LIFTOFF');
  });

  it('keeps other app ids on the per-agent branch (unknown app ⇒ 200 ack, no workspace handler)', async () => {
    const res = await request(makeApp())
      .post('/events')
      .set('content-type', 'application/json')
      .send(JSON.stringify({ api_app_id: 'A0SOMETHINGELSE', team_id: 'T1', event: {} }));
    expect(res.status).toBe(200);
    expect(handleWorkspaceMock).not.toHaveBeenCalled();
  });
});
