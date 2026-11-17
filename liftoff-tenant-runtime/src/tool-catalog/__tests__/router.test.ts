/**
 * Phase 2 fixes — router-level tests (D-2.11 missing test cases).
 * Tests the Express route handlers for tenant cross-check, rate limiting,
 * ETag/304, and error handling.
 */

import express from 'express';
import request from 'supertest';
import { toolCatalogRouter } from '../router';

// Mock dependencies
jest.mock('../catalog-service', () => ({
  getAvailableTools: jest.fn(),
  getTenantManifests: jest.fn(),
}));

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const { getAvailableTools, getTenantManifests } = jest.requireMock('../catalog-service');

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_TENANT = '99999999-9999-9999-9999-999999999999';
const MANIFEST_ID = '22222222-2222-2222-2222-222222222222';

function createApp(headerTenantId?: string) {
  const app = express();
  // Simulate the tenant-ID middleware
  app.use((req, _res, next) => {
    (req as any).ctx = headerTenantId ? { tenantId: headerTenantId } : {};
    next();
  });
  app.use('/api/v1/tool-catalog', toolCatalogRouter);
  return app;
}

describe('D-2.11 — tool-catalog router', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('GET /tenant/:tenantId/manifest/:manifestId/tools', () => {
    it('returns 403 when header tenantId mismatches path tenantId', async () => {
      const app = createApp(OTHER_TENANT);

      const res = await request(app)
        .get(`/api/v1/tool-catalog/tenant/${TENANT_ID}/manifest/${MANIFEST_ID}/tools`);

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Tenant mismatch');
    });

    it('returns 404 for unknown manifest', async () => {
      getAvailableTools.mockResolvedValue(null);
      const app = createApp(TENANT_ID);

      const res = await request(app)
        .get(`/api/v1/tool-catalog/tenant/${TENANT_ID}/manifest/${MANIFEST_ID}/tools`);

      expect(res.status).toBe(404);
    });

    it('returns 200 with tools, ETag, Cache-Control, Vary headers', async () => {
      getAvailableTools.mockResolvedValue({
        connectorType: 'salesforce',
        alias: 'sf_prod',
        tools: [{ name: 'sf_prod__read_record', description: 'Read', input_schema: {} }],
      });
      const app = createApp(TENANT_ID);

      const res = await request(app)
        .get(`/api/v1/tool-catalog/tenant/${TENANT_ID}/manifest/${MANIFEST_ID}/tools`);

      expect(res.status).toBe(200);
      expect(res.body.schemaVersion).toBe(1);
      expect(res.body.tools).toHaveLength(1);
      expect(res.headers['cache-control']).toBe('private, max-age=300');
      expect(res.headers['etag']).toBeDefined();
      expect(res.headers['vary']).toBe('Authorization');
    });

    it('returns 304 when If-None-Match matches ETag', async () => {
      getAvailableTools.mockResolvedValue({
        connectorType: 'salesforce',
        alias: 'sf_prod',
        tools: [{ name: 'sf_prod__read_record', description: 'Read', input_schema: {} }],
      });
      const app = createApp(TENANT_ID);

      // First call to get the ETag
      const firstRes = await request(app)
        .get(`/api/v1/tool-catalog/tenant/${TENANT_ID}/manifest/${MANIFEST_ID}/tools`);
      const etag = firstRes.headers['etag'];

      // Second call with If-None-Match
      const secondRes = await request(app)
        .get(`/api/v1/tool-catalog/tenant/${TENANT_ID}/manifest/${MANIFEST_ID}/tools`)
        .set('If-None-Match', etag);

      expect(secondRes.status).toBe(304);
    });

    it('returns 500 on service error (graceful, no throw)', async () => {
      getAvailableTools.mockRejectedValue(new Error('DB connection lost'));
      const app = createApp(TENANT_ID);

      const res = await request(app)
        .get(`/api/v1/tool-catalog/tenant/${TENANT_ID}/manifest/${MANIFEST_ID}/tools`);

      expect(res.status).toBe(500);
      expect(res.body.error).toMatch(/internal error/i);
    });
  });

  describe('GET /tenant/:tenantId/manifests', () => {
    it('returns 403 when header tenantId mismatches', async () => {
      const app = createApp(OTHER_TENANT);

      const res = await request(app)
        .get(`/api/v1/tool-catalog/tenant/${TENANT_ID}/manifests`);

      expect(res.status).toBe(403);
    });

    it('returns manifest list with ETag headers', async () => {
      getTenantManifests.mockResolvedValue([
        { manifestId: MANIFEST_ID, connectorType: 'salesforce', alias: 'sf', displayName: 'SF' },
      ]);
      const app = createApp(TENANT_ID);

      const res = await request(app)
        .get(`/api/v1/tool-catalog/tenant/${TENANT_ID}/manifests`);

      expect(res.status).toBe(200);
      expect(res.body.schemaVersion).toBe(1);
      expect(res.body.manifests).toHaveLength(1);
      expect(res.headers['etag']).toBeDefined();
      expect(res.headers['vary']).toBe('Authorization');
    });
  });

  describe('rate limiting (D-2.6)', () => {
    it('returns 429 after 100 requests in the same minute', async () => {
      getAvailableTools.mockResolvedValue({
        connectorType: 'salesforce', alias: 'sf',
        tools: [{ name: 'sf__read', description: 'r', input_schema: {} }],
      });
      const app = createApp(TENANT_ID);

      // Fire 100 requests (should all pass)
      for (let i = 0; i < 100; i++) {
        await request(app)
          .get(`/api/v1/tool-catalog/tenant/${TENANT_ID}/manifest/${MANIFEST_ID}/tools`);
      }

      // 101st should be rate-limited
      const res = await request(app)
        .get(`/api/v1/tool-catalog/tenant/${TENANT_ID}/manifest/${MANIFEST_ID}/tools`);

      expect(res.status).toBe(429);
      expect(res.headers['retry-after']).toBeDefined();
      expect(res.body.error).toMatch(/too many/i);
    });

    it('does not rate-limit a different tenant', async () => {
      const TENANT_B = '44444444-4444-4444-4444-444444444444';
      getAvailableTools.mockResolvedValue({
        connectorType: 'salesforce', alias: 'sf',
        tools: [{ name: 'sf__read', description: 'r', input_schema: {} }],
      });

      // Exhaust TENANT_ID's limit
      const appA = createApp(TENANT_ID);
      for (let i = 0; i < 100; i++) {
        await request(appA)
          .get(`/api/v1/tool-catalog/tenant/${TENANT_ID}/manifest/${MANIFEST_ID}/tools`);
      }

      // TENANT_B should still be allowed
      const appB = createApp(TENANT_B);
      const res = await request(appB)
        .get(`/api/v1/tool-catalog/tenant/${TENANT_B}/manifest/${MANIFEST_ID}/tools`);

      expect(res.status).toBe(200);
    });
  });
});
