// The gate reads the classification cache first and the registry's own
// categories second. The cache is hand-seeded per vendor and stops at the
// function names of its day; the registry is where the function is actually
// implemented, with the effect its author gave it. A function only the
// registry knows runs under the author's class; a function neither knows does
// not run.

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../connectors/connector-service-client', () => ({
  getCatalog: jest.fn(),
  getConnectorServiceClient: jest.fn(),
  listConnectorsForTenant: jest.fn(),
}));
jest.mock('../../connectors/connector-type-registry', () => ({
  fetchRegistry: jest.fn(),
  fetchConnectorFunctions: jest.fn(),
}));
jest.mock('../../mcp/tool-classifier', () => ({ toolClassifier: { getCachedClassification: jest.fn() } }));
jest.mock('../evidence', () => ({ recordUsageEvidence: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../cost-attribution/repository', () => ({
  ingestEventWithBuckets: jest.fn().mockResolvedValue(1),
  resolveAccountIdForTenant: jest.fn().mockResolvedValue('acct-1'),
}));
jest.mock('../apify-executor', () => ({ runApifyActor: jest.fn() }));

import { toolClassifier } from '../../mcp/tool-classifier';
import { getCatalog, getConnectorServiceClient, listConnectorsForTenant } from '../../connectors/connector-service-client';
import { fetchConnectorFunctions, fetchRegistry } from '../../connectors/connector-type-registry';
import { capabilityRequiresApproval, executeVendorTool } from '../vendor-execution';

const executeMock = jest.fn();
const schema = { type: 'object' as const, properties: { query: { type: 'string' } } };

beforeEach(() => {
  jest.clearAllMocks();
  executeMock.mockReset();
  (getCatalog as jest.Mock).mockResolvedValue({ connectors: [{ type: 'google_sheets', status: 'available' }] });
  (fetchRegistry as jest.Mock).mockResolvedValue(
    new Map([['google_sheets', { connectorType: 'google_sheets', functionNames: ['search_spreadsheets', 'append_values', 'delete_sheet', 'share_spreadsheet', 'post_to_team', 'unknown_fn'] }]]),
  );
  (fetchConnectorFunctions as jest.Mock).mockResolvedValue([
    { name: 'search_spreadsheets', description: 'Find spreadsheets', inputSchema: schema, categories: ['read'] },
    { name: 'append_values', description: 'Append rows', inputSchema: schema, categories: ['write'] },
    { name: 'delete_sheet', description: 'Delete a tab', inputSchema: schema, categories: ['write', 'destructive'] },
    { name: 'share_spreadsheet', description: 'Share with someone outside', inputSchema: schema, categories: ['outbound'] },
    { name: 'post_to_team', description: 'Message the workspace', inputSchema: schema, categories: ['write', 'internalCollaboration'] },
  ]);
  (toolClassifier.getCachedClassification as jest.Mock).mockResolvedValue(null);
  (getConnectorServiceClient as jest.Mock).mockReturnValue({ execute: executeMock });
  (listConnectorsForTenant as jest.Mock).mockResolvedValue([{ id: 'conn-sheets-1', type: 'google_sheets', status: 'active' }]);
  executeMock.mockResolvedValue({ success: true, result: { items: [] }, costUsd: 0, fundingSource: 'tenant_key' });
});

const run = (toolName: string) =>
  executeVendorTool({ tenantId: 't1', accountId: 'acct-7', connectorType: 'google_sheets', toolName, args: {}, caller: 'caio' });

describe('a function with no classification row', () => {
  it('runs under the registry’s own class when its author called it a read', async () => {
    const out = await run('search_spreadsheets');
    expect(out.success).toBe(true);
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(fetchConnectorFunctions).toHaveBeenCalledWith('google_sheets');
  });

  it('runs when its author called it a write: an edit to the workspace’s own data is not held', async () => {
    const out = await run('append_values');
    expect(out.success).toBe(true);
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it('runs unheld when its author called it internal collaboration, whatever else it is tagged', async () => {
    // A message into the workspace's own collaboration surface is how a team
    // talks to its people; the runtime reads the same category the same way.
    const out = await run('post_to_team');
    expect(out.success).toBe(true);
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(await capabilityRequiresApproval('google_sheets:post_to_team')).toBe(false);
  });

  it('is held for approval when its author called it destructive or outbound', async () => {
    expect(await run('delete_sheet')).toMatchObject({ success: false, requiresApproval: true });
    expect(await run('share_spreadsheet')).toMatchObject({ success: false, requiresApproval: true });
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('does not run when neither the cache nor the registry knows it', async () => {
    const out = await run('unknown_fn');
    expect(out).toEqual({ success: false, reason: 'tool unknown_fn has no classification yet; refusing to execute' });
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('does not run when the registry cannot be read', async () => {
    (fetchConnectorFunctions as jest.Mock).mockResolvedValue([]);
    const out = await run('search_spreadsheets');
    expect(out.success).toBe(false);
    expect(executeMock).not.toHaveBeenCalled();
  });
});

describe('a function with a classification row', () => {
  it('is gated by the row, not the registry', async () => {
    (toolClassifier.getCachedClassification as jest.Mock).mockResolvedValue({
      categories: ['externalPublishing'], isManualOverride: true, toolDescriptionHash: 'h',
    });
    const out = await run('search_spreadsheets');
    expect(out).toMatchObject({ success: false, requiresApproval: true });
    expect(fetchConnectorFunctions).not.toHaveBeenCalled();
  });
});

describe('capabilityRequiresApproval at mint time', () => {
  it('reads the registry when the cache has no row', async () => {
    await expect(capabilityRequiresApproval('google_sheets:search_spreadsheets')).resolves.toBe(false);
    await expect(capabilityRequiresApproval('google_sheets:append_values')).resolves.toBe(false);
    await expect(capabilityRequiresApproval('google_sheets:delete_sheet')).resolves.toBe(true);
    await expect(capabilityRequiresApproval('google_sheets:share_spreadsheet')).resolves.toBe(true);
    await expect(capabilityRequiresApproval('google_sheets:unknown_fn')).resolves.toBe(true);
  });
});
