// Unit tests for the Meta webhook router.
//
// Covers:
//   - verifyMetaSignedRequest: valid sig, tampered sig, replay protection,
//     missing user_id, wrong algorithm
//   - revokeMetaUserCredentials: no-connectors path, connectors-found path
//     (verifies revokeCredentials, deleteConnectorCredential, updateConnectorStatus called)
//   - Route error handling: DB failure → 500, publishEvent failure → non-fatal
//
// All external I/O is mocked so no real DB or Secret Manager is needed.

import express from 'express';
import request from 'supertest';
import { createHmac, createHash } from 'node:crypto';

// ── Module mocks (hoisted before all imports) ─────────────────────────────────

jest.mock('../../db/pool.js', () => ({
  withAdminScope: jest.fn(),
  withTenantScope: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../credentials/service.js', () => ({
  credentialService: {
    revokeCredentials: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../../secrets/client.js', () => ({
  deleteConnectorCredential: jest.fn().mockResolvedValue(true),
}));

jest.mock('../connector-ops.js', () => ({
  updateConnectorStatus: jest.fn().mockResolvedValue({ id: 'c1', status: 'disconnected' }),
}));

jest.mock('../../events/publisher.js', () => ({
  publishEvent: jest.fn().mockResolvedValue(undefined),
}));

// ── Import mocked modules for per-test configuration ─────────────────────────

import { withAdminScope } from '../../db/pool.js';
import { credentialService } from '../../credentials/service.js';
import { deleteConnectorCredential } from '../../secrets/client.js';
import { updateConnectorStatus } from '../connector-ops.js';
import { publishEvent } from '../../events/publisher.js';
import { metaWebhookRouter } from '../meta-webhook-router.js';

// ── Typed mock helpers ────────────────────────────────────────────────────────

const mockWithAdminScope = withAdminScope as jest.Mock;
const mockRevokeCredentials = credentialService.revokeCredentials as jest.Mock;
const mockDeleteConnectorCredential = deleteConnectorCredential as jest.Mock;
const mockUpdateConnectorStatus = updateConnectorStatus as jest.Mock;
const mockPublishEvent = publishEvent as jest.Mock;

// Configures withAdminScope to call the callback with a mock client that returns the given rows.
function mockAdminScopeRows(rows: Array<{ connector_id: string; tenant_id: string }>) {
  mockWithAdminScope.mockImplementation((_ctx: unknown, fn: unknown) => {
    const mockClient = { query: jest.fn().mockResolvedValue({ rows }) };
    return (fn as (client: unknown) => Promise<unknown>)(mockClient);
  });
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const APP_SECRET = 'test-app-secret-1234';

function buildSignedRequest(
  payload: Record<string, unknown>,
  secret = APP_SECRET,
): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', secret).update(encodedPayload).digest('base64url');
  return `${sig}.${encodedPayload}`;
}

function buildApp() {
  const app = express();
  app.use('/api/connectors/meta', express.urlencoded({ extended: false }), metaWebhookRouter);
  return app;
}

const validPayload = {
  algorithm: 'HMAC-SHA256',
  user_id: 'fb-user-123',
  issued_at: Math.floor(Date.now() / 1000),
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Meta webhook router', () => {
  let app: express.Express;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.META_CLIENT_SECRET = APP_SECRET;
    mockAdminScopeRows([]); // default: no connectors found
    app = buildApp();
  });

  afterEach(() => {
    delete process.env.META_CLIENT_SECRET;
  });

  // ── verifyMetaSignedRequest ────────────────────────────────────────────────

  describe('signature verification', () => {
    it('accepts a valid signed_request', async () => {
      const res = await request(app)
        .post('/api/connectors/meta/deauthorize')
        .type('form')
        .send({ signed_request: buildSignedRequest(validPayload) });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true });
    });

    it('rejects a tampered signature (wrong HMAC)', async () => {
      const res = await request(app)
        .post('/api/connectors/meta/deauthorize')
        .type('form')
        .send({ signed_request: buildSignedRequest(validPayload, 'wrong-secret') });

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('invalid_signature');
    });

    it('rejects a replayed request (issued_at older than 24 hours)', async () => {
      const stale = { ...validPayload, issued_at: Math.floor(Date.now() / 1000) - 90000 };
      const res = await request(app)
        .post('/api/connectors/meta/deauthorize')
        .type('form')
        .send({ signed_request: buildSignedRequest(stale) });

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('invalid_signature');
    });

    it('rejects a signed_request missing user_id', async () => {
      const noUser = { algorithm: 'HMAC-SHA256', issued_at: Math.floor(Date.now() / 1000) };
      const res = await request(app)
        .post('/api/connectors/meta/deauthorize')
        .type('form')
        .send({ signed_request: buildSignedRequest(noUser) });

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('invalid_signature');
    });

    it('rejects a signed_request with wrong algorithm', async () => {
      const wrongAlg = { ...validPayload, algorithm: 'HMAC-SHA1' };
      const res = await request(app)
        .post('/api/connectors/meta/deauthorize')
        .type('form')
        .send({ signed_request: buildSignedRequest(wrongAlg) });

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('invalid_signature');
    });

    it('returns 400 when signed_request body field is missing', async () => {
      const res = await request(app)
        .post('/api/connectors/meta/deauthorize')
        .type('form')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('missing_signed_request');
    });

    it('returns 500 when META_CLIENT_SECRET is not configured', async () => {
      delete process.env.META_CLIENT_SECRET;
      const res = await request(app)
        .post('/api/connectors/meta/deauthorize')
        .type('form')
        .send({ signed_request: 'anything' });

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('not_configured');
    });
  });

  // ── POST /deauthorize ─────────────────────────────────────────────────────

  describe('POST /deauthorize', () => {
    it('returns 200 with no connectors to revoke', async () => {
      mockAdminScopeRows([]);
      const res = await request(app)
        .post('/api/connectors/meta/deauthorize')
        .type('form')
        .send({ signed_request: buildSignedRequest(validPayload) });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true });
      expect(mockRevokeCredentials).not.toHaveBeenCalled();
    });

    it('revokes credentials for each connector when connectors are found', async () => {
      mockAdminScopeRows([
        { connector_id: 'c1', tenant_id: 't1' },
        { connector_id: 'c2', tenant_id: 't2' },
      ]);

      const res = await request(app)
        .post('/api/connectors/meta/deauthorize')
        .type('form')
        .send({ signed_request: buildSignedRequest(validPayload) });

      expect(res.status).toBe(200);
      expect(mockRevokeCredentials).toHaveBeenCalledTimes(2);
      expect(mockRevokeCredentials).toHaveBeenCalledWith('t1', 'c1');
      expect(mockRevokeCredentials).toHaveBeenCalledWith('t2', 'c2');
      expect(mockDeleteConnectorCredential).toHaveBeenCalledTimes(2);
      expect(mockUpdateConnectorStatus).toHaveBeenCalledWith('t1', 'c1', 'disconnected');
      expect(mockUpdateConnectorStatus).toHaveBeenCalledWith('t2', 'c2', 'disconnected');
    });

    it('publishes connector.credentials_revoked for each revoked connector', async () => {
      mockAdminScopeRows([{ connector_id: 'c1', tenant_id: 't1' }]);

      await request(app)
        .post('/api/connectors/meta/deauthorize')
        .type('form')
        .send({ signed_request: buildSignedRequest(validPayload) });

      // Wait a tick for the fire-and-forget publishEvent promise to settle.
      await new Promise(resolve => setImmediate(resolve));

      expect(mockPublishEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'connector.credentials_revoked',
          entityId: 'c1',
          tenantId: 't1',
          entityVersion: 1,
          eventVersion: 1,
        }),
      );
    });

    it('returns 200 even when publishEvent rejects (fire-and-forget, non-fatal)', async () => {
      mockAdminScopeRows([{ connector_id: 'c1', tenant_id: 't1' }]);
      mockPublishEvent.mockRejectedValueOnce(new Error('pubsub down'));

      const res = await request(app)
        .post('/api/connectors/meta/deauthorize')
        .type('form')
        .send({ signed_request: buildSignedRequest(validPayload) });

      expect(res.status).toBe(200);
    });

    it('returns 500 when the DB lookup throws', async () => {
      mockWithAdminScope.mockRejectedValueOnce(new Error('DB unavailable'));

      const res = await request(app)
        .post('/api/connectors/meta/deauthorize')
        .type('form')
        .send({ signed_request: buildSignedRequest(validPayload) });

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('internal_error');
    });
  });

  // ── POST /data-deletion ───────────────────────────────────────────────────

  describe('POST /data-deletion', () => {
    it('returns { url, confirmation_code } shape', async () => {
      const res = await request(app)
        .post('/api/connectors/meta/data-deletion')
        .type('form')
        .send({ signed_request: buildSignedRequest(validPayload) });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('url');
      expect(res.body).toHaveProperty('confirmation_code');
      expect(typeof res.body.confirmation_code).toBe('string');
      expect(res.body.confirmation_code.length).toBe(24);
    });

    it('confirmation_code is deterministic for the same user+timestamp', async () => {
      // Use a fixed issued_at within the 24-hour replay window so verification passes.
      // Two requests with identical payloads must produce the same confirmation code.
      const payload = { ...validPayload, issued_at: Math.floor(Date.now() / 1000) - 60 };
      const res1 = await request(app)
        .post('/api/connectors/meta/data-deletion')
        .type('form')
        .send({ signed_request: buildSignedRequest(payload) });
      const res2 = await request(app)
        .post('/api/connectors/meta/data-deletion')
        .type('form')
        .send({ signed_request: buildSignedRequest(payload) });

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
      expect(res1.body.confirmation_code).toBe(res2.body.confirmation_code);
    });

    it('calls the full revocation pipeline when connectors are found', async () => {
      mockAdminScopeRows([{ connector_id: 'c1', tenant_id: 't1' }]);

      const res = await request(app)
        .post('/api/connectors/meta/data-deletion')
        .type('form')
        .send({ signed_request: buildSignedRequest(validPayload) });

      expect(res.status).toBe(200);
      expect(mockRevokeCredentials).toHaveBeenCalledWith('t1', 'c1');
      expect(mockDeleteConnectorCredential).toHaveBeenCalledWith('t1', 'c1');
      expect(mockUpdateConnectorStatus).toHaveBeenCalledWith('t1', 'c1', 'disconnected');
    });

    it('returns 500 when the DB lookup throws', async () => {
      mockWithAdminScope.mockRejectedValueOnce(new Error('DB unavailable'));

      const res = await request(app)
        .post('/api/connectors/meta/data-deletion')
        .type('form')
        .send({ signed_request: buildSignedRequest(validPayload) });

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('internal_error');
    });
  });

  // ── GET /data-deletion/status ─────────────────────────────────────────────

  describe('GET /data-deletion/status', () => {
    it('always returns completed', async () => {
      const code = createHash('sha256').update('test').digest('hex').slice(0, 24);
      const res = await request(app)
        .get(`/api/connectors/meta/data-deletion/status?id=${code}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('completed');
      expect(res.body.confirmation_code).toBe(code);
    });
  });
});
