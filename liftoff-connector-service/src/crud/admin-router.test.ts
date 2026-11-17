// Tests for the cross-tenant connector lookups other services depend on.
//
// These routes exist because platform-backend was answering both questions
// from its own `connectors` table, which has held only pre-cutover rows since
// connectors moved into this service. A connector created after the cutover
// is absent there, and absence reads as "no such connector" rather than as an
// error — harvest 404'd live connectors and the operator dashboard reported
// zero of everything.

jest.mock('../db/pool.js', () => ({ withAdminScope: jest.fn() }));

import express from 'express';
import http from 'node:http';
import request from 'supertest';
import { jest } from '@jest/globals';

import { connectorAdminRouter } from './admin-router.js';
import { withAdminScope } from '../db/pool.js';

const mockAdminScope = withAdminScope as unknown as jest.Mock;

function startServer(): Promise<{ server: http.Server; url: string }> {
  const app = express();
  app.use('/api/connectors/internal/admin', express.json(), connectorAdminRouter);
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
    server.on('error', reject);
  });
}

/** Run the route's callback against a fake client with canned query results. */
function adminScopeReturning(rowsByOrder: Array<{ rows: unknown[] }>) {
  let call = 0;
  mockAdminScope.mockImplementation(((_ctx: unknown, fn: (c: unknown) => Promise<unknown>) =>
    fn({ query: () => Promise.resolve(rowsByOrder[call++] ?? { rows: [] }) })) as never);
}

const CONNECTOR_ID = '8fbfbd68-fc15-47d1-b777-dca252f14a0d';

beforeEach(() => jest.clearAllMocks());

describe('GET /connectors/:connectorId/tenant', () => {
  it('resolves the owning tenant for a caller that has no tenant context', async () => {
    adminScopeReturning([
      { rows: [{ tenant_id: 't-1', type: 'google_drive', status: 'active' }] },
    ]);

    const { server, url } = await startServer();
    try {
      const res = await request(url).get(
        `/api/connectors/internal/admin/connectors/${CONNECTOR_ID}/tenant`,
      );
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ tenantId: 't-1', connectorType: 'google_drive', status: 'active' });
    } finally { server.close(); }
  });

  it('404s an id that belongs to no connector', async () => {
    adminScopeReturning([{ rows: [] }]);
    const { server, url } = await startServer();
    try {
      const res = await request(url).get(
        `/api/connectors/internal/admin/connectors/${CONNECTOR_ID}/tenant`,
      );
      expect(res.status).toBe(404);
    } finally { server.close(); }
  });

  it('rejects a non-UUID before it reaches the database', async () => {
    const { server, url } = await startServer();
    try {
      const res = await request(url).get(
        '/api/connectors/internal/admin/connectors/not-a-uuid/tenant',
      );
      expect(res.status).toBe(400);
      expect(mockAdminScope).not.toHaveBeenCalled();
    } finally { server.close(); }
  });
});

describe('GET /health/summary', () => {
  it('reports real totals, a type breakdown, and recent failures', async () => {
    adminScopeReturning([
      { rows: [{ total: '21', active: '12', error: '1', disconnected: '7', pending: '1' }] },
      { rows: [{ type: 'google_drive', count: '3' }, { type: 'slack', count: '1' }] },
      {
        rows: [
          {
            connector_id: CONNECTOR_ID,
            tenant_id: 't-1',
            type: 'google_drive',
            last_error: 'token expired',
            last_error_at: new Date('2026-08-16T00:00:00Z'),
          },
        ],
      },
      { rows: [{ count: '2' }] },
    ]);

    const { server, url } = await startServer();
    try {
      const res = await request(url).get('/api/connectors/internal/admin/health/summary');
      expect(res.status).toBe(200);
      expect(res.body.totalConnectors).toBe(21);
      expect(res.body.activeCount).toBe(12);
      expect(res.body.disconnectedCount).toBe(7);
      expect(res.body.connectorsByType).toEqual({ google_drive: 3, slack: 1 });
      expect(res.body.connectorsWithSyncErrorsLast24h).toBe(2);
      expect(res.body.recentSyncFailures[0]).toMatchObject({
        connectorId: CONNECTOR_ID,
        tenantId: 't-1',
        connectorType: 'google_drive',
        errorMessage: 'token expired',
      });
    } finally { server.close(); }
  });

  it('fails loudly when the query fails, rather than reporting a healthy estate', async () => {
    mockAdminScope.mockRejectedValue(new Error('connection refused') as never);
    const { server, url } = await startServer();
    try {
      const res = await request(url).get('/api/connectors/internal/admin/health/summary');
      expect(res.status).toBe(500);
      expect(res.body.error).toMatch(/connection refused/);
    } finally { server.close(); }
  });
});

describe('POST /connectors/reconnect-required', () => {
  /** The route reads rowCount, which the shared helper above does not set. */
  function adminScopeUpdating(rows: unknown[]) {
    mockAdminScope.mockImplementation(((_ctx: unknown, fn: (c: unknown) => Promise<unknown>) =>
      fn({ query: () => Promise.resolve({ rows, rowCount: rows.length }) })) as never);
  }

  it('flags the connector a caller already resolved', async () => {
    adminScopeUpdating([{ id: CONNECTOR_ID, tenant_id: 't1', type: 'google_mail' }]);
    const { server, url } = await startServer();
    try {
      const res = await request(url)
        .post('/api/connectors/internal/admin/connectors/reconnect-required')
        .send({ connectorId: CONNECTOR_ID, reason: 'probe_failed' });
      expect(res.status).toBe(200);
      expect(res.body.updated).toBe(1);
      expect(res.body.connectors[0]).toEqual({
        connectorId: CONNECTOR_ID,
        tenantId: 't1',
        connectorType: 'google_mail',
      });
    } finally {
      server.close();
    }
  });

  // The webhook that reports an expired Composio account knows a vendor
  // account id and nothing else — no connector id, no tenant.
  it('resolves a Composio account id when no connector id is given', async () => {
    adminScopeUpdating([{ id: CONNECTOR_ID, tenant_id: 't1', type: 'gong' }]);
    const { server, url } = await startServer();
    try {
      const res = await request(url)
        .post('/api/connectors/internal/admin/connectors/reconnect-required')
        .send({ composioConnectedAccountId: 'ca_abc123', reason: 'composio_account_expired' });
      expect(res.status).toBe(200);
      expect(res.body.updated).toBe(1);
    } finally {
      server.close();
    }
  });

  // Reporting the same failure twice must not read as two separate faults,
  // and a connector the user has since disconnected must not be resurrected
  // into a Reconnect card they never asked for. Both fall out of the
  // status = 'active' guard in the UPDATE.
  it('is a no-op when nothing active matches', async () => {
    adminScopeUpdating([]);
    const { server, url } = await startServer();
    try {
      const res = await request(url)
        .post('/api/connectors/internal/admin/connectors/reconnect-required')
        .send({ connectorId: CONNECTOR_ID });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, updated: 0 });
    } finally {
      server.close();
    }
  });

  it('rejects a body carrying neither identifier', async () => {
    const { server, url } = await startServer();
    try {
      const res = await request(url)
        .post('/api/connectors/internal/admin/connectors/reconnect-required')
        .send({ reason: 'probe_failed' });
      expect(res.status).toBe(400);
    } finally {
      server.close();
    }
  });

  it('rejects a connectorId that is not a UUID', async () => {
    const { server, url } = await startServer();
    try {
      const res = await request(url)
        .post('/api/connectors/internal/admin/connectors/reconnect-required')
        .send({ connectorId: 'google_mail' });
      expect(res.status).toBe(400);
    } finally {
      server.close();
    }
  });
});
