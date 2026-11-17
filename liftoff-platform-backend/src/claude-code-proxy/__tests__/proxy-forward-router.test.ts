// Tests for the /proxy/* forward router (Claude Code → developer-proxy).
// pipeToDeveloperProxy / isDevProxyEnabled are mocked so the focus is the
// router's relay behaviour: streaming a response through, the originGuard CSRF
// block, and the not-configured guard.

import express from 'express';
import request from 'supertest';

const mockPipe = jest.fn();
const mockIsEnabled = jest.fn();

jest.mock('../developer-proxy-client', () => ({
  pipeToDeveloperProxy: (...args: unknown[]) => mockPipe(...args),
  isDevProxyEnabled: () => mockIsEnabled(),
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// Import after mocks are registered.
import { createProxyForwardRouter } from '../proxy-forward-router';

function makeApp() {
  const app = express();
  app.use('/proxy', createProxyForwardRouter());
  return app;
}

describe('proxy-forward-router', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsEnabled.mockReturnValue(true);
  });

  it('streams the developer-proxy response (status + headers + body) through', async () => {
    const sseBody = 'event: message_start\ndata: {"type":"message_start"}\n\n';
    mockPipe.mockResolvedValue(
      new Response(sseBody, {
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'anthropic-ratelimit-requests-remaining': '42',
        },
      }),
    );

    const res = await request(makeApp())
      .post('/proxy/v1/messages')
      .set('x-api-key', 'liftoff_sk_test')
      .send({ model: 'x', messages: [] });

    expect(res.status).toBe(200);
    expect(res.text).toBe(sseBody);
    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.headers['anthropic-ratelimit-requests-remaining']).toBe('42');
    expect(mockPipe).toHaveBeenCalledTimes(1);
  });

  it('rejects browser-originated (Origin header) requests with 403', async () => {
    const res = await request(makeApp())
      .post('/proxy/v1/messages')
      .set('Origin', 'https://evil.com')
      .send({});

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ type: 'error', error: { type: 'authentication_error' } });
    expect(mockPipe).not.toHaveBeenCalled();
  });

  it('returns 503 when the developer proxy is not configured', async () => {
    mockIsEnabled.mockReturnValue(false);

    const res = await request(makeApp()).post('/proxy/v1/messages').send({});

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ type: 'error', error: { type: 'api_error' } });
    expect(mockPipe).not.toHaveBeenCalled();
  });
});
