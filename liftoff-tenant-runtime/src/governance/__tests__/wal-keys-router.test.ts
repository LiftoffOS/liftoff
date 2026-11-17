// Tests for wal-keys-router. Mocks the pool so we exercise the query
// predicate and response contract without a database.

import express from 'express';
import request from 'supertest';

const queryMock = jest.fn();

jest.mock('../../infrastructure/database', () => ({
  getPoolForService: () => ({ query: queryMock }),
}));

// The router moved off the package's verifyServiceAuth, which resolves the
// expected token from process.env and 500s when it is absent. This repo's
// requireServiceAuth reads the secret store instead; same shared-bearer-only
// default, so the stub is the same shape in a different place.
jest.mock('../../security/service-auth', () => ({
  requireServiceAuth: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
  log: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));

// Import AFTER mocks land so the router picks up the mocked pool.
import { walKeysRouter } from '../wal-keys-router';

const app = express();
app.use(express.json());
app.use('/api/internal', walKeysRouter);

const TENANT = 'dd7d80bd-3b77-4677-817c-053fdb8668cd';

beforeEach(() => {
  queryMock.mockReset();
});

it('defaults to a 25 hour window, matching the reconciler', async () => {
  queryMock.mockResolvedValue({ rows: [] });
  const r = await request(app).get('/api/internal/governance/wal-keys');
  expect(r.status).toBe(200);
  expect(r.body.windowHours).toBe(25);
  expect(queryMock.mock.calls[0][1][0]).toBe('25');
});

it('returns keys and the tenant ids actually present', async () => {
  queryMock.mockResolvedValue({
    rows: [
      { tenant_id: TENANT, idempotency_key: 'k1' },
      { tenant_id: TENANT, idempotency_key: 'k2' },
    ],
  });
  const r = await request(app).get('/api/internal/governance/wal-keys?windowHours=3');
  expect(r.status).toBe(200);
  expect(r.body).toEqual({
    windowHours: 3,
    tenantIds: [TENANT],
    keys: ['k1', 'k2'],
    count: 2,
  });
});

// The predicate is the contract. An unreplicated row is the drainer's
// backlog, not drift, and including it would make the reconciler report
// every in-flight tool call as missing from governance.
it('only reports rows this runtime already replicated', async () => {
  queryMock.mockResolvedValue({ rows: [] });
  await request(app).get('/api/internal/governance/wal-keys');
  expect(queryMock.mock.calls[0][0]).toMatch(/replicated\s*=\s*true/);
});

it('passes tenantId through as a filter when supplied, and null when not', async () => {
  queryMock.mockResolvedValue({ rows: [] });
  await request(app).get(`/api/internal/governance/wal-keys?tenantId=${TENANT}`);
  expect(queryMock.mock.calls[0][1][1]).toBe(TENANT);

  queryMock.mockClear();
  queryMock.mockResolvedValue({ rows: [] });
  await request(app).get('/api/internal/governance/wal-keys');
  expect(queryMock.mock.calls[0][1][1]).toBeNull();
});

it('rejects an absurd window rather than scanning the table', async () => {
  const r = await request(app).get('/api/internal/governance/wal-keys?windowHours=100000');
  expect(r.status).toBe(400);
  expect(queryMock).not.toHaveBeenCalled();
});

// An empty key set is a meaningful answer ("replicated nothing in the
// window"), so a failure must never be dressed up as one.
it('fails loudly instead of returning an empty key set', async () => {
  queryMock.mockRejectedValue(new Error('connection terminated'));
  const r = await request(app).get('/api/internal/governance/wal-keys');
  expect(r.status).toBe(500);
  expect(r.body).toEqual({ error: 'wal_keys_query_failed' });
  expect(r.body.keys).toBeUndefined();
});
