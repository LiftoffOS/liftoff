/**
 * D-2.11 — TenantRuntimeClient tool-catalog circuit-breaker fallback tests.
 *
 * Verifies that getToolCatalog and getTenantManifests return graceful
 * fallback values (empty arrays) when the tenant-runtime is unreachable,
 * so distill can degrade to agent-type classification without throwing.
 */

// Mock fetch before importing the client
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

// Mock Google Auth (prevent real OIDC token requests)
jest.mock('google-auth-library', () => ({
  GoogleAuth: jest.fn().mockImplementation(() => ({
    getIdTokenClient: jest.fn().mockRejectedValue(new Error('no metadata server')),
  })),
}));

// resolveRuntimeBaseUrl dynamically imports the real TenantRepository and
// queries the control-plane DB for the tenant's runtime_url before every
// request. Unmocked, that meant a real pg connection attempt plus ts-jest
// compiling the tenants/repository import graph inside the first test —
// seconds of load-sensitive latency in a unit suite about breaker fallbacks.
// findById → null routes to the TENANT_RUNTIME_URL/localhost fallback URL.
jest.mock('../../tenants/repository', () => ({
  TenantRepository: jest.fn().mockImplementation(() => ({
    findById: jest.fn().mockResolvedValue(null),
  })),
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { tenantRuntimeClient } from '../tenant-runtime-client';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const MANIFEST_ID = '22222222-2222-2222-2222-222222222222';

describe('D-2.11 — TenantRuntimeClient catalog fallback', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockReset();
  });

  describe('getToolCatalog', () => {
    it('returns tools on success', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          schemaVersion: 1,
          connectorType: 'salesforce',
          alias: 'sf_prod',
          tools: [{ name: 'sf_prod__read_record', description: 'Read', input_schema: {} }],
        }),
      });

      const result = await tenantRuntimeClient.getToolCatalog(TENANT_ID, MANIFEST_ID);
      expect(result.tools).toHaveLength(1);
      expect(result.tools[0].name).toBe('sf_prod__read_record');
    });

    it('returns empty fallback when tenant-runtime is unreachable', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await tenantRuntimeClient.getToolCatalog(TENANT_ID, MANIFEST_ID);
      expect(result.tools).toEqual([]);
      expect(result.connectorType).toBe('');
    });

    it('returns empty fallback on HTTP 500', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 500 });

      const result = await tenantRuntimeClient.getToolCatalog(TENANT_ID, MANIFEST_ID);
      expect(result.tools).toEqual([]);
    });
  });

  describe('getTenantManifests', () => {
    it('returns manifests on success', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          schemaVersion: 1,
          manifests: [
            { manifestId: MANIFEST_ID, connectorType: 'salesforce', alias: 'sf', displayName: 'SF' },
          ],
        }),
      });

      const result = await tenantRuntimeClient.getTenantManifests(TENANT_ID);
      expect(result.manifests).toHaveLength(1);
    });

    it('returns empty fallback when tenant-runtime is unreachable', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await tenantRuntimeClient.getTenantManifests(TENANT_ID);
      expect(result.manifests).toEqual([]);
    });

    it('returns empty fallback on HTTP 404', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 404 });

      const result = await tenantRuntimeClient.getTenantManifests(TENANT_ID);
      expect(result.manifests).toEqual([]);
    });
  });
});
