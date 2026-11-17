// A platform-funded call is paid before its cost is booked, so the money
// authority is asked before the vendor is: a workspace that is suspended, or
// under the prepaid floor, has nothing dispatched on its behalf and the
// vendor is not paid. A workspace's own connector is its own money and is
// not asked.

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
const mockGuard = jest.fn();
jest.mock('../../billing/execution-guard', () => ({ checkExecutionAllowed: (...a: unknown[]) => mockGuard(...a) }));

import { toolClassifier } from '../../mcp/tool-classifier';
import { getCatalog, getConnectorServiceClient, listConnectorsForTenant } from '../../connectors/connector-service-client';
import { fetchConnectorFunctions, fetchRegistry } from '../../connectors/connector-type-registry';
import { runApifyActor } from '../apify-executor';
import { executeVendorTool } from '../vendor-execution';

const executeMock = jest.fn();
const schema = { type: 'object' as const, properties: { query: { type: 'string' } } };
const REFUSAL = 'Your credit balance is too low to continue. Please add credit to continue.';

beforeEach(() => {
  jest.clearAllMocks();
  (getCatalog as jest.Mock).mockResolvedValue({ connectors: [{ type: 'locus', status: 'internal' }, { type: 'apify', status: 'available' }] });
  (fetchRegistry as jest.Mock).mockResolvedValue(new Map([
    ['locus', { connectorType: 'locus', functionNames: ['email_verify'] }],
    ['apify', { connectorType: 'apify', functionNames: ['run_actor'] }],
  ]));
  (fetchConnectorFunctions as jest.Mock).mockResolvedValue([
    { name: 'email_verify', description: 'Verify', inputSchema: schema, categories: ['read'] },
    { name: 'run_actor', description: 'Run', inputSchema: schema, categories: ['read'] },
  ]);
  (toolClassifier.getCachedClassification as jest.Mock).mockResolvedValue({ categories: [], isManualOverride: true });
  (getConnectorServiceClient as jest.Mock).mockReturnValue({ execute: executeMock });
  (listConnectorsForTenant as jest.Mock).mockResolvedValue([]);
  executeMock.mockResolvedValue({ success: true, result: { status: 'valid' }, costUsd: 0.008, fundingSource: 'platform_key' });
  (runApifyActor as jest.Mock).mockResolvedValue({ success: true, items: [], costUsd: 0.01, runId: 'r1', fundingSource: 'x402_wallet' });
  mockGuard.mockResolvedValue({ allowed: true });
});

const run = (connectorType: string, toolName: string) =>
  executeVendorTool({
    tenantId: 't1', accountId: 'acct-7', connectorType, toolName, args: { query: 'x' }, caller: 'assistant',
    ...(connectorType === 'apify' ? { presetArgs: { actorId: 'memo23/crunchbase-scraper' } } : {}),
  });

it('a platform-funded call on an unfunded workspace is refused before the vendor is reached, with the guard\'s own words', async () => {
  mockGuard.mockResolvedValue({ allowed: false, reason: REFUSAL });
  const out = await run('locus', 'email_verify');
  expect(out).toEqual({ success: false, skipped: 'unfunded', reason: REFUSAL });
  expect(executeMock).not.toHaveBeenCalled();
  expect(mockGuard).toHaveBeenCalledWith('t1');
});

it('a platform Apify run is asked the same question, and refused the same way', async () => {
  mockGuard.mockResolvedValue({ allowed: false, reason: REFUSAL });
  const out = await run('apify', 'run_actor');
  expect(out).toMatchObject({ success: false, skipped: 'unfunded', reason: REFUSAL });
  expect(runApifyActor).not.toHaveBeenCalled();
});

it('a funded workspace runs, and a workspace on its own connector is never asked', async () => {
  const funded = await run('locus', 'email_verify');
  expect(funded.success).toBe(true);
  expect(mockGuard).toHaveBeenCalledTimes(1);
  mockGuard.mockClear();
  (listConnectorsForTenant as jest.Mock).mockResolvedValue([{ id: 'conn-locus-own', type: 'locus', status: 'active' }]);
  executeMock.mockResolvedValue({ success: true, result: { status: 'valid' }, costUsd: 0, fundingSource: 'tenant_key' });
  const own = await run('locus', 'email_verify');
  expect(own.success).toBe(true);
  expect(mockGuard).not.toHaveBeenCalled();
});
