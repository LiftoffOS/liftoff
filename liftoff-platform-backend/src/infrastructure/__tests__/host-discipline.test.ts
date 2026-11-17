// Tests for the host-discipline middleware. Verifies the URL namespace is
// partitioned between hosts so the webhooks subdomain serves ONLY the
// inbound webhook path and the api host rejects /v1/* probes.

import express from 'express';
import request from 'supertest';
import {
  makeHostDisciplineMiddleware,
  parseWebhookHosts,
} from '../host-discipline';

// Build a minimal express app with the middleware + a couple of canary
// routes so we can assert the gate's behavior.
function buildApp(hosts: Set<string>) {
  const app = express();
  // trust proxy so X-Forwarded-Host is honored (matches platform-backend's
  // production config).
  app.set('trust proxy', true);
  app.use(makeHostDisciplineMiddleware(hosts));
  // Canary routes used to assert downstream reachability:
  app.post('/v1/:token', (_req, res) => { res.status(200).json({ ok: true, where: 'v1' }); });
  app.get('/api/foo', (_req, res) => { res.status(200).json({ ok: true, where: 'api' }); });
  app.get('/healthz', (_req, res) => { res.status(200).json({ ok: true, where: 'healthz' }); });
  return app;
}

describe('parseWebhookHosts', () => {
  it('returns empty set for unset input', () => {
    expect(parseWebhookHosts(undefined).size).toBe(0);
  });
  it('returns empty set for empty string', () => {
    expect(parseWebhookHosts('').size).toBe(0);
  });
  it('parses a single host', () => {
    const s = parseWebhookHosts('webhooks.example.com');
    expect(s.has('webhooks.example.com')).toBe(true);
    expect(s.size).toBe(1);
  });
  it('parses multiple comma-separated hosts', () => {
    const s = parseWebhookHosts('webhooks.example.com,webhooks-staging.example.com');
    expect(s.has('webhooks.example.com')).toBe(true);
    expect(s.has('webhooks-staging.example.com')).toBe(true);
  });
  it('trims whitespace and lowercases', () => {
    const s = parseWebhookHosts('  Webhooks-Dev.EXAMPLE.com , other ');
    expect(s.has('webhooks-dev.example.com')).toBe(true);
    expect(s.has('other')).toBe(true);
  });
  it('drops empty segments', () => {
    const s = parseWebhookHosts('webhooks.example.com,,,');
    expect(s.size).toBe(1);
  });
});

describe('host-discipline middleware: empty host set (no-op mode)', () => {
  it('passes /v1/* through on any host', async () => {
    const app = buildApp(new Set());
    const res = await request(app)
      .post('/v1/sometoken')
      .set('Host', 'api.example.com');
    expect(res.status).toBe(200);
    expect(res.body.where).toBe('v1');
  });
  it('passes /api/* through on any host', async () => {
    const app = buildApp(new Set());
    const res = await request(app)
      .get('/api/foo')
      .set('Host', 'webhooks.example.com');
    expect(res.status).toBe(200);
  });
});

describe('host-discipline middleware: webhook host', () => {
  const hosts = new Set(['webhooks-dev.example.com']);

  it('allows POST /v1/<token>', async () => {
    const app = buildApp(hosts);
    const res = await request(app)
      .post('/v1/abc123')
      .set('Host', 'webhooks-dev.example.com');
    expect(res.status).toBe(200);
    expect(res.body.where).toBe('v1');
  });

  it('rejects GET /v1/<token> with 404 (only POST allowed on v1)', async () => {
    const app = buildApp(hosts);
    const res = await request(app)
      .get('/v1/abc123')
      .set('Host', 'webhooks-dev.example.com');
    expect(res.status).toBe(404);
  });

  it('rejects DELETE /v1/<token> with 404', async () => {
    const app = buildApp(hosts);
    const res = await request(app)
      .delete('/v1/abc123')
      .set('Host', 'webhooks-dev.example.com');
    expect(res.status).toBe(404);
  });

  it('rejects POST /v1 (no token) with 404', async () => {
    const app = buildApp(hosts);
    const res = await request(app)
      .post('/v1')
      .set('Host', 'webhooks-dev.example.com');
    expect(res.status).toBe(404);
  });

  it('rejects POST /v1/ (trailing slash but no token) with 404', async () => {
    const app = buildApp(hosts);
    const res = await request(app)
      .post('/v1/')
      .set('Host', 'webhooks-dev.example.com');
    expect(res.status).toBe(404);
  });

  it('rejects /api/* paths with 404 (no api surface from this host)', async () => {
    const app = buildApp(hosts);
    const res = await request(app)
      .get('/api/foo')
      .set('Host', 'webhooks-dev.example.com');
    expect(res.status).toBe(404);
  });

  it('rejects /healthz with 404 (only the inbound webhook is served)', async () => {
    // Cloud Run probes hit the *.run.app URL, never the custom domain, so
    // blocking /healthz on the webhook host has no operational cost.
    const app = buildApp(hosts);
    const res = await request(app)
      .get('/healthz')
      .set('Host', 'webhooks-dev.example.com');
    expect(res.status).toBe(404);
  });

  it('returns an empty 404 body (does not leak existence/shape of api routes)', async () => {
    const app = buildApp(hosts);
    const res = await request(app)
      .get('/api/internal-agents/anything')
      .set('Host', 'webhooks-dev.example.com');
    expect(res.status).toBe(404);
    expect(res.text).toBe('');
  });
});

describe('host-discipline middleware: non-webhook host', () => {
  const hosts = new Set(['webhooks-dev.example.com']);

  it('rejects POST /v1/<token> with 404 (cross-host probe rejection)', async () => {
    const app = buildApp(hosts);
    const res = await request(app)
      .post('/v1/abc123')
      .set('Host', 'api-dev.example.com');
    expect(res.status).toBe(404);
  });

  it('rejects GET /v1/ with 404', async () => {
    const app = buildApp(hosts);
    const res = await request(app)
      .get('/v1/something')
      .set('Host', 'api-dev.example.com');
    expect(res.status).toBe(404);
  });

  it('allows /api/* through', async () => {
    const app = buildApp(hosts);
    const res = await request(app)
      .get('/api/foo')
      .set('Host', 'api-dev.example.com');
    expect(res.status).toBe(200);
    expect(res.body.where).toBe('api');
  });

  it('allows /healthz through', async () => {
    const app = buildApp(hosts);
    const res = await request(app)
      .get('/healthz')
      .set('Host', 'api-dev.example.com');
    expect(res.status).toBe(200);
    expect(res.body.where).toBe('healthz');
  });

  it('Cloud Run probe host (*.run.app) falls through to api branch', async () => {
    // Probes hit the direct Cloud Run service URL — host won't match the
    // configured webhook host(s), so they land in the non-webhook branch.
    // Verifies /healthz keeps working when probes use the run.app hostname.
    const app = buildApp(hosts);
    const res = await request(app)
      .get('/healthz')
      .set('Host', 'platform-backend-abc123xyz-uw.a.run.app');
    expect(res.status).toBe(200);
  });
});

describe('host-discipline middleware: multiple webhook hosts', () => {
  it('treats every host in the set as a webhook host', async () => {
    const hosts = new Set([
      'webhooks-dev.example.com',
      'webhooks-staging.example.com',
    ]);
    const app = buildApp(hosts);

    const r1 = await request(app)
      .post('/v1/x')
      .set('Host', 'webhooks-dev.example.com');
    expect(r1.status).toBe(200);

    const r2 = await request(app)
      .post('/v1/x')
      .set('Host', 'webhooks-staging.example.com');
    expect(r2.status).toBe(200);

    // A non-listed host is treated as api → /v1/* is rejected.
    const r3 = await request(app)
      .post('/v1/x')
      .set('Host', 'webhooks.example.com');
    expect(r3.status).toBe(404);
  });
});

describe('host-discipline middleware: case-insensitivity', () => {
  it('matches the webhook host regardless of Host-header casing', async () => {
    const hosts = new Set(['webhooks-dev.example.com']);
    const app = buildApp(hosts);
    const res = await request(app)
      .post('/v1/tok')
      .set('Host', 'Webhooks-Dev.EXAMPLE.com');
    expect(res.status).toBe(200);
  });
});
