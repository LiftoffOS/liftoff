// Canonical-host guard scoping — regression tests.
//
// oauthMetadataRouter and oauthAuthorizationServerRouter are mounted at the
// app root, so an unscoped router.use(enforceCanonicalPublicHost) ran for
// every request in the app and 404'd internal service-to-service POSTs that
// target the raw *.run.app host (the OIDC audience internal callers pin).
// That silently broke the workforce LLM relay, billing spend-events, and
// audit-log writes. The guard must cover ONLY the paths these routers own.

import express from 'express';
import request from 'supertest';

const mockAdminQuery = jest.fn();

jest.mock('../../infrastructure/database', () => ({
  withAdminScope: jest.fn(async (_ctx: unknown, fn: (client: { query: typeof mockAdminQuery }) => unknown) => {
    return fn({ query: mockAdminQuery });
  }),
  pool: { query: (...args: unknown[]) => mockAdminQuery(...args) },
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../infrastructure/control-plane-url', () => ({
  getBackendUrl: () => 'https://api-test.example.com',
}));

import { oauthMetadataRouter } from '../metadata-router';
import { oauthAuthorizationServerRouter } from '../authorization-server-router';

const RAW_HOST = 'platform-backend-abc123-uw.a.run.app';

function buildApp() {
  const app = express();
  // Same shape as index.ts: both OAuth routers at the root, internal routes after.
  app.use(oauthMetadataRouter);
  app.use(oauthAuthorizationServerRouter);
  app.post('/api/internal/llm/complete', (_req, res) => {
    res.json({ reached: true });
  });
  return app;
}

describe('canonical-host guard scoping', () => {
  it('lets internal POSTs on a raw *.run.app host through to their route', async () => {
    const res = await request(buildApp())
      .post('/api/internal/llm/complete')
      .set('Host', RAW_HOST);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reached: true });
  });

  it('still refuses non-GET requests to the OAuth surface on a raw host', async () => {
    const res = await request(buildApp()).post('/oauth/token').set('Host', RAW_HOST);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found' });
  });

  it('still redirects metadata GETs on a raw host to the canonical host', async () => {
    const res = await request(buildApp())
      .get('/.well-known/oauth-protected-resource')
      .set('Host', RAW_HOST);
    expect(res.status).toBe(301);
    expect(res.headers.location).toBe(
      'https://api-test.example.com/.well-known/oauth-protected-resource',
    );
  });

  it('serves the OAuth surface normally on the canonical host', async () => {
    process.env.MCP_OAUTH_ENABLED = 'true';
    try {
      const res = await request(buildApp())
        .get('/.well-known/oauth-protected-resource')
        .set('Host', 'api-test.example.com');
      expect(res.status).toBe(200);
      expect(res.body.resource).toBe('https://api-test.example.com/mcp');
    } finally {
      delete process.env.MCP_OAUTH_ENABLED;
    }
  });
});
