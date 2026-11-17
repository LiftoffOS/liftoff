// Router tests, focused on the boundary rather than the payload.
//
// The panel names individual people, so the thing worth testing is that a
// tenant id in the query string cannot outrun the membership the middleware
// verified. src/index.ts mounts tenantAuthMiddleware('viewAuditLogs') ahead of
// this router; these tests stand in for it and check the router still refuses
// when the two disagree.

import express from 'express';
import request from 'supertest';
import { liftoffScoreRouter } from '../router';

jest.mock('../service', () => ({
  ...jest.requireActual('../service'),
  getLiftoffScore: jest.fn(async () => ({
    period: 'this_month',
    status: 'ok',
    taskCount: 40,
    computedAt: '2026-08-26T00:00:00.000Z',
    groups: [],
    entries: [],
  })),
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

/** Stands in for tenantAuthMiddleware, which is the only thing that may set this. */
function withVerifiedTenant(tenantId: string | undefined) {
  const app = express();
  app.use((req, _res, next) => {
    (req as express.Request).ctx = { requestId: 'test', tenantId, operation: 'GET /' };
    next();
  });
  app.use('/api/score', liftoffScoreRouter);
  return app;
}

describe('GET /api/score', () => {
  it('serves the panel when the verified tenant matches the query', async () => {
    const res = await request(withVerifiedTenant(TENANT))
      .get('/api/score')
      .query({ tenantId: TENANT, period: 'this_month' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('refuses a tenant the middleware did not verify', async () => {
    // The caller is a verified member of TENANT and asks for OTHER's ratings.
    const res = await request(withVerifiedTenant(TENANT))
      .get('/api/score')
      .query({ tenantId: OTHER });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Not a member of this tenant');
  });

  it('refuses when no membership was verified at all', async () => {
    const res = await request(withVerifiedTenant(undefined))
      .get('/api/score')
      .query({ tenantId: TENANT });

    expect(res.status).toBe(403);
  });

  it('rejects a period resolveTimeRange would throw on', async () => {
    const res = await request(withVerifiedTenant(TENANT))
      .get('/api/score')
      .query({ tenantId: TENANT, period: 'since_the_dawn_of_time' });

    expect(res.status).toBe(400);
  });

  it('rejects a tenantId that is not a uuid', async () => {
    const res = await request(withVerifiedTenant(TENANT))
      .get('/api/score')
      .query({ tenantId: 'not-a-uuid' });

    expect(res.status).toBe(400);
  });
});
