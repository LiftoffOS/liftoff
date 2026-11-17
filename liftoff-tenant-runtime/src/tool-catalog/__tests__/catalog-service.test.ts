/**
 * Phase 2 — catalog-service unit tests.
 *
 * Verifies that getAvailableTools() produces the same aliased tool names
 * that buildToolsSchema() would for a given manifest.
 */

import { getAvailableTools, getTenantManifests } from '../catalog-service';

// Mock dependencies
jest.mock('../../connectors/tool-schema-cache', () => ({
  getToolSchemas: jest.fn((connectorType: string) => {
    if (connectorType === 'salesforce') {
      return [
        { name: 'read_record', description: 'Read a Salesforce record', inputSchema: { type: 'object', properties: {} }, categories: ['read'], entityType: 'record' },
        { name: 'create_contact', description: 'Create a Contact', inputSchema: { type: 'object', properties: {} }, categories: ['write'], entityType: 'Contact' },
      ];
    }
    return [];
  }),
}));

jest.mock('../../connectors/manifest-repository', () => ({
  connectorManifestRepository: {
    getById: jest.fn(),
    getManifestsForAgent: jest.fn(),
    listManifests: jest.fn(),
  },
}));

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { connectorManifestRepository } = jest.requireMock('../../connectors/manifest-repository');

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const MANIFEST_ID = '22222222-2222-2222-2222-222222222222';

describe('Phase 2 — getAvailableTools', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns aliased tool names for a self-hosted connector', async () => {
    connectorManifestRepository.getById.mockResolvedValue({
      id: MANIFEST_ID,
      tenantId: TENANT_ID,
      connectorType: 'salesforce',
      alias: 'salesforce_prod',
      displayName: 'Salesforce (prod)',
      enabled: true,
    });

    const result = await getAvailableTools(TENANT_ID, MANIFEST_ID);

    expect(result).not.toBeNull();
    expect(result!.connectorType).toBe('salesforce');
    expect(result!.alias).toBe('salesforce_prod');
    expect(result!.tools).toHaveLength(2);
    expect(result!.tools[0].name).toBe('salesforce_prod__read_record');
    expect(result!.tools[1].name).toBe('salesforce_prod__create_contact');
  });

  it('sanitizes alias characters in tool names', async () => {
    connectorManifestRepository.getById.mockResolvedValue({
      id: MANIFEST_ID,
      tenantId: TENANT_ID,
      connectorType: 'salesforce',
      alias: 'My Salesforce (prod)',
      displayName: 'My Salesforce',
      enabled: true,
    });

    const result = await getAvailableTools(TENANT_ID, MANIFEST_ID);

    // Spaces and parens should be replaced with underscores
    expect(result!.tools[0].name).toBe('My_Salesforce__prod___read_record');
  });

  it('returns null for unknown manifest', async () => {
    connectorManifestRepository.getById.mockResolvedValue(null);

    const result = await getAvailableTools(TENANT_ID, 'unknown-id');
    expect(result).toBeNull();
  });

  it('returns empty tools for unknown connector type', async () => {
    connectorManifestRepository.getById.mockResolvedValue({
      id: MANIFEST_ID,
      tenantId: TENANT_ID,
      connectorType: 'unknown_connector',
      alias: 'unknown',
      displayName: 'Unknown',
      enabled: true,
    });

    const result = await getAvailableTools(TENANT_ID, MANIFEST_ID);
    expect(result).not.toBeNull();
    expect(result!.tools).toHaveLength(0);
  });

  it('includes categories and entityType from the registry', async () => {
    connectorManifestRepository.getById.mockResolvedValue({
      id: MANIFEST_ID,
      tenantId: TENANT_ID,
      connectorType: 'salesforce',
      alias: 'sf',
      displayName: 'SF',
      enabled: true,
    });

    const result = await getAvailableTools(TENANT_ID, MANIFEST_ID);
    expect(result!.tools[0].categories).toEqual(['read']);
    expect(result!.tools[0].entityType).toBe('record');
    expect(result!.tools[1].categories).toEqual(['write']);
  });
});

describe('Phase 2 — getTenantManifests', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns manifest summaries for a tenant', async () => {
    connectorManifestRepository.listManifests.mockResolvedValue([
      { id: MANIFEST_ID, tenantId: TENANT_ID, connectorType: 'salesforce', alias: 'sf_prod', displayName: 'Salesforce (prod)', enabled: true },
      { id: '33333333-3333-3333-3333-333333333333', tenantId: TENANT_ID, connectorType: 'slack', alias: 'slack', displayName: 'Slack', enabled: true },
    ]);

    const manifests = await getTenantManifests(TENANT_ID);

    expect(manifests).toHaveLength(2);
    expect(manifests[0]).toEqual({
      manifestId: MANIFEST_ID,
      connectorType: 'salesforce',
      alias: 'sf_prod',
      displayName: 'Salesforce (prod)',
    });
    expect(manifests[1].connectorType).toBe('slack');
  });

  it('returns empty array for tenant with no manifests', async () => {
    connectorManifestRepository.listManifests.mockResolvedValue([]);
    const manifests = await getTenantManifests(TENANT_ID);
    expect(manifests).toHaveLength(0);
  });
});
