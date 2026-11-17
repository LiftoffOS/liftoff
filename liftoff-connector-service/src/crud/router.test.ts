// Tests for the connector CRUD router + service.
//
// Service + credential/secret/pubsub layers are stubbed so the tests are
// hermetic and do NOT touch Postgres, Secret Manager, or Pub/Sub.
//
// Every route is exercised:
//   - GET / requires tenantId, returns list
//   - GET /available returns full catalog with functional + mcp metadata
//   - GET /:id returns 404 on unknown, 200 on match
//   - POST / creates + audits + 400s on missing / invalid type
//   - DELETE /:id soft-deletes + revokes credentials + publishes
//   - PATCH /:id/status validates status + toggles
// Service auth mounting is exercised separately via buildApp.

import express from 'express';
import http from 'node:http';
import request from 'supertest';
import { jest } from '@jest/globals';
import type { Logger } from '@liftoffos/telemetry';

import { connectorCrudRouter } from './router.js';
import { connectorCrudService } from './service.js';
import { credentialService } from '../credentials/service.js';
import { GoogleDriveClient } from '../clients/google-drive.js';
import * as secretsClient from '../secrets/client.js';
import * as eventsPublisher from '../events/publisher.js';
import { buildApp } from '../server.js';

const silentLog = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLog,
} as unknown as Logger;

function makeApp(): express.Express {
  const app = express();
  app.use('/api/connectors', express.json(), connectorCrudRouter);
  return app;
}

function startServer(): Promise<{ server: http.Server; url: string }> {
  const app = makeApp();
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
    server.on('error', reject);
  });
}

const sampleConnector = {
  id: 'c-1',
  tenantId: 't1',
  type: 'slack' as const,
  name: 'Slack',
  status: 'active' as const,
  config: {},
  apiKeyHint: null,
  lastSyncAt: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

describe('crud/router — GET /', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns 400 when tenantId missing', async () => {
    const { server, url } = await startServer();
    try {
      const res = await request(url).get('/api/connectors');
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/tenantId/);
    } finally {
      server.close();
    }
  });

  it('returns the tenant connector list from the service', async () => {
    const listSpy = jest
      .spyOn(connectorCrudService, 'listByTenant')
      .mockResolvedValue([sampleConnector]);
    const { server, url } = await startServer();
    try {
      const res = await request(url).get('/api/connectors?tenantId=t1');
      expect(res.status).toBe(200);
      expect(res.body.connectors).toHaveLength(1);
      expect(res.body.connectors[0].id).toBe('c-1');
      expect(listSpy).toHaveBeenCalledWith('t1');
    } finally {
      server.close();
    }
  });

  it('returns 500 on service failure', async () => {
    jest
      .spyOn(connectorCrudService, 'listByTenant')
      .mockRejectedValue(new Error('boom'));
    const { server, url } = await startServer();
    try {
      const res = await request(url).get('/api/connectors?tenantId=t1');
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('boom');
    } finally {
      server.close();
    }
  });
});

describe('crud/router — POST /_resolve', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns 400 when tenantId is missing', async () => {
    const { server, url } = await startServer();
    try {
      const res = await request(url).post('/api/connectors/_resolve').send({ ids: ['a'] });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/tenantId/);
    } finally {
      server.close();
    }
  });

  it('returns 400 when ids is not an array of strings', async () => {
    const { server, url } = await startServer();
    try {
      const res = await request(url)
        .post('/api/connectors/_resolve')
        .send({ tenantId: 't1', ids: 'not-an-array' });
      expect(res.status).toBe(400);
    } finally {
      server.close();
    }
  });

  it('returns 400 when ids exceeds the per-call cap', async () => {
    const tooMany = Array.from({ length: 1001 }, (_, i) => `c-${i}`);
    const { server, url } = await startServer();
    try {
      const res = await request(url)
        .post('/api/connectors/_resolve')
        .send({ tenantId: 't1', ids: tooMany });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/1000/);
    } finally {
      server.close();
    }
  });

  it('returns the resolved id/type/status rows from the service', async () => {
    const resolveSpy = jest
      .spyOn(connectorCrudService, 'resolveTypesByIds')
      .mockResolvedValue([
        { id: 'c-1', type: 'google_mail', status: 'active', scopes: [], botLogin: null, authorizedRepos: null },
        { id: 'c-2', type: 'slack', status: 'disconnected', scopes: [], botLogin: null, authorizedRepos: null },
      ]);
    const { server, url } = await startServer();
    try {
      const res = await request(url)
        .post('/api/connectors/_resolve')
        .send({ tenantId: 't1', ids: ['c-1', 'c-2', 'orphan'] });
      expect(res.status).toBe(200);
      expect(res.body.connectors).toEqual([
        { id: 'c-1', type: 'google_mail', status: 'active', scopes: [], botLogin: null, authorizedRepos: null },
        { id: 'c-2', type: 'slack', status: 'disconnected', scopes: [], botLogin: null, authorizedRepos: null },
      ]);
      expect(resolveSpy).toHaveBeenCalledWith('t1', ['c-1', 'c-2', 'orphan']);
    } finally {
      server.close();
    }
  });

  it('returns empty connectors[] when no ids match', async () => {
    jest.spyOn(connectorCrudService, 'resolveTypesByIds').mockResolvedValue([]);
    const { server, url } = await startServer();
    try {
      const res = await request(url)
        .post('/api/connectors/_resolve')
        .send({ tenantId: 't1', ids: ['orphan'] });
      expect(res.status).toBe(200);
      expect(res.body.connectors).toEqual([]);
    } finally {
      server.close();
    }
  });
});

describe('crud/router — GET /available', () => {
  it('returns every known connector type with metadata', async () => {
    const { server, url } = await startServer();
    try {
      const res = await request(url).get('/api/connectors/available');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.connectors)).toBe(true);
      expect(res.body.connectors.length).toBeGreaterThan(20);
      // Every entry has type + name + provider + scopes + supportsOAuth.
      for (const entry of res.body.connectors) {
        expect(typeof entry.type).toBe('string');
        expect(typeof entry.name).toBe('string');
        expect(typeof entry.provider).toBe('string');
        expect(Array.isArray(entry.scopes)).toBe(true);
        expect(typeof entry.supportsOAuth).toBe('boolean');
        expect(typeof entry.functional).toBe('boolean');
      }
    } finally {
      server.close();
    }
  });

  it('marks salesforce as OAuth with non-empty scopes (direct-routed connector)', async () => {
    // composio_managed entries carry `scopes: []` because Composio's own OAuth
    // app holds the scope list. We need an `available` direct-OAuth connector
    // to exercise the "scopes are returned to the UI" path; salesforce fits.
    const { server, url } = await startServer();
    try {
      const res = await request(url).get('/api/connectors/available');
      const sf = res.body.connectors.find(
        (c: { type: string }) => c.type === 'salesforce',
      );
      expect(sf).toBeDefined();
      expect(sf.supportsOAuth).toBe(true);
      expect(sf.scopes.length).toBeGreaterThan(0);
    } finally {
      server.close();
    }
  });

  it('marks slack as OAuth via our own app (native scopes in the catalog)', async () => {
    // Not Composio-managed (see the slack catalog entry): OAuth
    // runs on Liftoff's own Slack app, so the catalog carries the real
    // bot scopes and the connect flow mints slack.com authorize URLs.
    const { server, url } = await startServer();
    try {
      const res = await request(url).get('/api/connectors/available');
      const sl = res.body.connectors.find(
        (c: { type: string }) => c.type === 'slack',
      );
      expect(sl).toBeDefined();
      expect(sl.supportsOAuth).toBe(true);
      expect(sl.scopes).toEqual([
        'channels:history', 'channels:read', 'chat:write', 'files:read',
        'groups:history', 'groups:read', 'im:history', 'im:read',
        'mpim:history', 'mpim:read', 'reactions:read', 'reactions:write',
        'users:read', 'users:read.email',
      ]);
    } finally {
      server.close();
    }
  });
});

describe('crud/router — GET /:id', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns 400 when tenantId missing', async () => {
    const { server, url } = await startServer();
    try {
      const res = await request(url).get('/api/connectors/c-1');
      expect(res.status).toBe(400);
    } finally {
      server.close();
    }
  });

  it('returns 404 when service returns null (unknown / cross-tenant)', async () => {
    jest.spyOn(connectorCrudService, 'getById').mockResolvedValue(null);
    const { server, url } = await startServer();
    try {
      const res = await request(url).get('/api/connectors/c-1?tenantId=t1');
      expect(res.status).toBe(404);
    } finally {
      server.close();
    }
  });

  it('returns the connector on match', async () => {
    jest
      .spyOn(connectorCrudService, 'getById')
      .mockResolvedValue(sampleConnector);
    const { server, url } = await startServer();
    try {
      const res = await request(url).get('/api/connectors/c-1?tenantId=t1');
      expect(res.status).toBe(200);
      expect(res.body.id).toBe('c-1');
    } finally {
      server.close();
    }
  });
});

describe('crud/router — POST /', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('rejects missing tenantId', async () => {
    const { server, url } = await startServer();
    try {
      const res = await request(url)
        .post('/api/connectors')
        .send({ type: 'slack' });
      expect(res.status).toBe(400);
    } finally {
      server.close();
    }
  });

  it('rejects missing type', async () => {
    const { server, url } = await startServer();
    try {
      const res = await request(url)
        .post('/api/connectors')
        .send({ tenantId: 't1' });
      expect(res.status).toBe(400);
    } finally {
      server.close();
    }
  });

  it('rejects invalid connector type', async () => {
    const { server, url } = await startServer();
    try {
      const res = await request(url)
        .post('/api/connectors')
        .send({ tenantId: 't1', type: 'not-a-type' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Invalid connector type/);
    } finally {
      server.close();
    }
  });

  it('creates connector + returns 201', async () => {
    const createSpy = jest
      .spyOn(connectorCrudService, 'create')
      .mockResolvedValue({ ...sampleConnector, status: 'pending' });
    const { server, url } = await startServer();
    try {
      const res = await request(url)
        .post('/api/connectors')
        .set('x-account-id', 'acct_1')
        .send({ tenantId: 't1', type: 'slack' });
      expect(res.status).toBe(201);
      expect(res.body.id).toBe('c-1');
      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 't1', type: 'slack' }),
      );
    } finally {
      server.close();
    }
  });

  it('uses provided name when supplied', async () => {
    const createSpy = jest
      .spyOn(connectorCrudService, 'create')
      .mockResolvedValue({ ...sampleConnector, name: 'Custom Slack' });
    const { server, url } = await startServer();
    try {
      await request(url)
        .post('/api/connectors')
        .send({ tenantId: 't1', type: 'slack', name: 'Custom Slack' });
      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Custom Slack' }),
      );
    } finally {
      server.close();
    }
  });
});

describe('crud/router — DELETE /:id', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('rejects missing tenantId', async () => {
    const { server, url } = await startServer();
    try {
      const res = await request(url).delete('/api/connectors/c-1');
      expect(res.status).toBe(400);
    } finally {
      server.close();
    }
  });

  it('returns 404 when connector unknown', async () => {
    jest.spyOn(connectorCrudService, 'getById').mockResolvedValue(null);
    const { server, url } = await startServer();
    try {
      const res = await request(url).delete(
        '/api/connectors/c-1?tenantId=t1',
      );
      expect(res.status).toBe(404);
    } finally {
      server.close();
    }
  });

  it('soft-deletes + revokes + publishes on happy path', async () => {
    jest
      .spyOn(connectorCrudService, 'getById')
      .mockResolvedValue(sampleConnector);
    const dcSpy = jest
      .spyOn(connectorCrudService, 'disconnect')
      .mockResolvedValue(true);
    const revokeSpy = jest
      .spyOn(credentialService, 'revokeCredentials')
      .mockResolvedValue(undefined);
    const delSecSpy = jest
      .spyOn(secretsClient, 'deleteConnectorCredential')
      .mockResolvedValue(true);
    const pubSpy = jest
      .spyOn(eventsPublisher, 'publishEvent')
      .mockResolvedValue(undefined);

    const { server, url } = await startServer();
    try {
      const res = await request(url).delete(
        '/api/connectors/c-1?tenantId=t1',
      );
      expect(res.status).toBe(204);
      expect(dcSpy).toHaveBeenCalledWith('c-1', 't1');
      expect(revokeSpy).toHaveBeenCalledWith('t1', 'c-1');
      expect(delSecSpy).toHaveBeenCalledWith('t1', 'c-1');
      expect(pubSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'connector.deleted',
          entityId: 'c-1',
          tenantId: 't1',
        }),
      );
    } finally {
      server.close();
    }
  });

  it('does not fail the request when credential scrub throws', async () => {
    jest
      .spyOn(connectorCrudService, 'getById')
      .mockResolvedValue(sampleConnector);
    jest
      .spyOn(connectorCrudService, 'disconnect')
      .mockResolvedValue(true);
    jest
      .spyOn(credentialService, 'revokeCredentials')
      .mockRejectedValue(new Error('db down'));
    jest
      .spyOn(secretsClient, 'deleteConnectorCredential')
      .mockRejectedValue(new Error('sm down'));
    jest.spyOn(eventsPublisher, 'publishEvent').mockResolvedValue(undefined);

    const { server, url } = await startServer();
    try {
      const res = await request(url).delete(
        '/api/connectors/c-1?tenantId=t1',
      );
      expect(res.status).toBe(204);
    } finally {
      server.close();
    }
  });
});

describe('crud/router — PATCH /:id/status', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('rejects invalid status value', async () => {
    const { server, url } = await startServer();
    try {
      const res = await request(url)
        .patch('/api/connectors/c-1/status?tenantId=t1')
        .send({ status: 'bogus' });
      expect(res.status).toBe(400);
    } finally {
      server.close();
    }
  });

  it('rejects when connector unknown', async () => {
    jest.spyOn(connectorCrudService, 'getById').mockResolvedValue(null);
    const { server, url } = await startServer();
    try {
      const res = await request(url)
        .patch('/api/connectors/c-1/status?tenantId=t1')
        .send({ status: 'active' });
      expect(res.status).toBe(404);
    } finally {
      server.close();
    }
  });

  it('updates to disabled + returns updated row', async () => {
    jest
      .spyOn(connectorCrudService, 'getById')
      .mockResolvedValue(sampleConnector);
    const upSpy = jest
      .spyOn(connectorCrudService, 'updateStatus')
      .mockResolvedValue({ ...sampleConnector, status: 'disabled' });
    const { server, url } = await startServer();
    try {
      const res = await request(url)
        .patch('/api/connectors/c-1/status?tenantId=t1')
        .send({ status: 'disabled' });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('disabled');
      expect(upSpy).toHaveBeenCalledWith('c-1', 't1', 'disabled');
    } finally {
      server.close();
    }
  });
});

describe('crud/router — service auth', () => {
  const ORIG_TOKEN = process.env.CONNECTOR_SERVICE_TOKEN;
  beforeAll(() => {
    process.env.CONNECTOR_SERVICE_TOKEN = 'test-token';
  });
  afterAll(() => {
    if (ORIG_TOKEN === undefined) delete process.env.CONNECTOR_SERVICE_TOKEN;
    else process.env.CONNECTOR_SERVICE_TOKEN = ORIG_TOKEN;
  });

  it('rejects crud routes without X-Service-Auth via buildApp', async () => {
    const app = buildApp({ port: 0, log: silentLog });
    const res = await request(app).get('/api/connectors?tenantId=t1');
    expect(res.status).toBe(401);
  });

  it('accepts crud routes with X-Service-Auth via buildApp', async () => {
    jest
      .spyOn(connectorCrudService, 'listByTenant')
      .mockResolvedValue([sampleConnector]);
    const app = buildApp({ port: 0, log: silentLog });
    const res = await request(app)
      .get('/api/connectors?tenantId=t1')
      .set('X-Service-Auth', 'test-token');
    expect(res.status).toBe(200);
    expect(res.body.connectors).toHaveLength(1);
    jest.restoreAllMocks();
  });

  it('GET /available is accessible with X-Service-Auth', async () => {
    const app = buildApp({ port: 0, log: silentLog });
    const res = await request(app)
      .get('/api/connectors/available')
      .set('X-Service-Auth', 'test-token');
    expect(res.status).toBe(200);
    expect(res.body.connectors.length).toBeGreaterThan(0);
  });

  it('does not shadow the OAuth subtree (404 falls through to oauth router path matching)', async () => {
    const app = buildApp({ port: 0, log: silentLog });
    // The oauth router mounts /:connectorType/start (POST); GETting an
    // unknown OAuth path should NOT be answered by the CRUD :connectorId
    // GET because /api/connectors/oauth is mounted first. The CRUD
    // GET /:id matcher would incorrectly treat `oauth` as an id if it ran
    // first; since oauth is mounted first the oauth router handles the
    // request (returning 404 for the unmatched route within that router).
    const res = await request(app)
      .get('/api/connectors/oauth/not-a-real-route')
      .set('X-Service-Auth', 'test-token');
    // The oauth router has no GET handler for this path; express ends up
    // in the fallback 404 JSON. Either 404 via CRUD fallthrough or via
    // server.ts fallback — what matters is the response is NOT a 200
    // CRUD single-connector payload.
    expect([404, 400]).toContain(res.status);
  });
});

describe('crud/router — GET /:connectorId/files (cloud-storage file listing)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  const activeDrive = { ...sampleConnector, id: 'd-1', type: 'google_drive' as const, status: 'active' as const };

  it('returns 404 when the connector does not exist', async () => {
    jest.spyOn(connectorCrudService, 'getById').mockResolvedValue(null);
    const { server, url } = await startServer();
    try {
      const res = await request(url).get('/api/connectors/d-1/files?tenantId=t1');
      expect(res.status).toBe(404);
    } finally { server.close(); }
  });

  it('returns 409 (reconnect) when the connector is not active', async () => {
    jest.spyOn(connectorCrudService, 'getById').mockResolvedValue({ ...activeDrive, status: 'disconnected' as const });
    const { server, url } = await startServer();
    try {
      const res = await request(url).get('/api/connectors/d-1/files?tenantId=t1');
      expect(res.status).toBe(409);
    } finally { server.close(); }
  });

  it('returns an empty list for a non file-listing connector type (e.g. slack)', async () => {
    jest.spyOn(connectorCrudService, 'getById').mockResolvedValue({ ...sampleConnector, status: 'active' as const });
    const { server, url } = await startServer();
    try {
      const res = await request(url).get('/api/connectors/c-1/files?tenantId=t1');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ files: [], nextPageToken: null });
    } finally { server.close(); }
  });

  it('returns 401 when the connector has no usable credentials', async () => {
    jest.spyOn(connectorCrudService, 'getById').mockResolvedValue(activeDrive);
    jest.spyOn(credentialService, 'getCredentials').mockResolvedValue({} as never);
    const { server, url } = await startServer();
    try {
      const res = await request(url).get('/api/connectors/d-1/files?tenantId=t1');
      expect(res.status).toBe(401);
    } finally { server.close(); }
  });

  it('maps client.list("file") records → ListFilesResult { files, nextPageToken }', async () => {
    jest.spyOn(connectorCrudService, 'getById').mockResolvedValue(activeDrive);
    jest.spyOn(credentialService, 'getCredentials').mockResolvedValue({ accessToken: 'tok' } as never);
    jest.spyOn(GoogleDriveClient.prototype, 'list').mockResolvedValue({
      records: [{
        id: 'f1',
        data: { name: 'Report.pdf', mimeType: 'application/pdf', size: '1024', modifiedTime: '2026-07-01T00:00:00Z', webViewLink: 'https://drive/f1' },
      }],
      hasMore: true,
      nextPageToken: 'next-1',
    } as never);
    const { server, url } = await startServer();
    try {
      const res = await request(url).get('/api/connectors/d-1/files?tenantId=t1&limit=25');
      expect(res.status).toBe(200);
      expect(res.body.nextPageToken).toBe('next-1');
      expect(res.body.files).toEqual([{
        id: 'f1', name: 'Report.pdf', mimeType: 'application/pdf', size: 1024,
        modifiedAt: '2026-07-01T00:00:00Z', webViewUrl: 'https://drive/f1',
      }]);
    } finally { server.close(); }
  });
});
