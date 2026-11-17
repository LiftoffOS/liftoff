/**
 * Usage-ledger /feed endpoint tests.
 *
 * Validates cursor pagination, service-auth enforcement, and empty-result
 * behavior. The DB pool and service-auth env var are stubbed.
 */

// Router does `pool.connect()` then `client.query(SET LOCAL statement_timeout)`
// then `client.query(SELECT ...)` then `client.release()`. The setQueryMock
// stub handles the SET LOCAL silently so individual tests can set up only
// the SELECT call's return value via selectQueryMock.mockResolvedValueOnce.
const selectQueryMock = jest.fn();
const mockRelease = jest.fn();
const mockClient = {
  query: jest.fn((sql: string, params?: unknown[]) => {
    // SET LOCAL statement_timeout — silent ack, no rows expected.
    if (typeof sql === 'string' && sql.startsWith('SET LOCAL')) {
      return Promise.resolve({ rows: [] });
    }
    // The SELECT — delegate to the test-controlled mock.
    return selectQueryMock(sql, params);
  }),
  release: mockRelease,
};
jest.mock('../../infrastructure/database', () => ({
  getPool: () => ({
    connect: async () => mockClient,
  }),
}));

import express from 'express';
import request from 'supertest';
import { usageLedgerRouter } from '../router';

const TENANT = '11111111-1111-1111-1111-111111111111';
const OTHER  = '22222222-2222-2222-2222-222222222222';

let app: express.Express;
beforeAll(() => {
  process.env.TENANT_RUNTIME_SERVICE_TOKEN = 'shared-secret';
  app = express();
  app.use(express.json());
  app.use('/api/usage-ledger', usageLedgerRouter);
});

beforeEach(() => { jest.clearAllMocks(); });

describe('GET /api/usage-ledger/feed', () => {
  it('rejects requests without a valid service-auth header', async () => {
    const res = await request(app).get('/api/usage-ledger/feed');
    expect(res.status).toBe(401);
  });

  it('returns events + nextCursor when rows are present', async () => {
    const ts = new Date('2025-01-02T00:00:00Z');
    selectQueryMock.mockResolvedValueOnce({
      rows: [{ id: 'e1', tenant_id: 't', agent_id: 'a', workflow_id: null, action_id: null, event_type: 'memory_save', credits: 1, metadata: {}, created_at: ts }],
    });
    const res = await request(app)
      .get(`/api/usage-ledger/feed?tenantId=${TENANT}&limit=100`)
      .set('x-service-auth', 'shared-secret');
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.nextCursor).toBe(ts.toISOString());
    expect(res.body.hasMore).toBe(false);
  });

  it('returns an empty list with no cursor advance when no rows', async () => {
    selectQueryMock.mockResolvedValueOnce({ rows: [] });
    const res = await request(app)
      .get(`/api/usage-ledger/feed?tenantId=${TENANT}`)
      .set('x-service-auth', 'shared-secret');
    expect(res.status).toBe(200);
    expect(res.body.events).toEqual([]);
    expect(res.body.hasMore).toBe(false);
  });

  it('clamps limit to 500', async () => {
    selectQueryMock.mockResolvedValueOnce({ rows: [] });
    await request(app)
      .get(`/api/usage-ledger/feed?tenantId=${TENANT}&limit=9999`)
      .set('x-service-auth', 'shared-secret');
    const args = selectQueryMock.mock.calls[0];
    expect(args[1][1]).toBe(500);
  });
});

describe('the feed is scoped to one tenant', () => {
  // It was not, and this database is shared by every tenant on the runtime, so
  // an unfiltered feed handed the whole fleet's events to every caller. The
  // platform backend consumes it per tenant and translates each event's agent id
  // with the CURRENT tenant's mapping, so a foreign event's id missed the lookup
  // and fell through to pass-through — writing a runtime id into a column that
  // must hold internal_agents.id (INV-TR-010 / ADR-039).

  it('requires a tenantId', async () => {
    const res = await request(app)
      .get('/api/usage-ledger/feed')
      .set('x-service-auth', 'shared-secret');

    expect(res.status).toBe(400);
    expect(selectQueryMock).not.toHaveBeenCalled();
  });

  it('filters the query by that tenant', async () => {
    selectQueryMock.mockResolvedValueOnce({ rows: [] });

    await request(app)
      .get(`/api/usage-ledger/feed?tenantId=${TENANT}`)
      .set('x-service-auth', 'shared-secret');

    const [sql, params] = selectQueryMock.mock.calls[0];
    expect(sql).toMatch(/tenant_id = \$3/);
    expect(params).toContain(TENANT);
    expect(params).not.toContain(OTHER);
  });
});
