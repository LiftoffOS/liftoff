// A source that rejects the arguments says so in a form the caller can pass
// on: the wire's own code when it names one, the shared message classifier
// when the wire could not classify it, and the source's error envelope on the
// platform-funded actor path.

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../connectors/connector-service-client', () => ({
  getCatalog: jest.fn(),
  getConnectorServiceClient: jest.fn(),
  listConnectorsForTenant: jest.fn(),
}));
jest.mock('../../connectors/connector-type-registry', () => ({ fetchRegistry: jest.fn() }));
jest.mock('../../mcp/tool-classifier', () => ({ toolClassifier: { getCachedClassification: jest.fn() } }));
jest.mock('../evidence', () => ({ recordUsageEvidence: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../cost-attribution/repository', () => ({
  ingestEventWithBuckets: jest.fn().mockResolvedValue(1),
  resolveAccountIdForTenant: jest.fn().mockResolvedValue('acct-1'),
}));
jest.mock('../apify-executor', () => ({ runApifyActor: jest.fn() }));

import { toolClassifier } from '../../mcp/tool-classifier';
import { getCatalog, getConnectorServiceClient, listConnectorsForTenant } from '../../connectors/connector-service-client';
import { fetchRegistry } from '../../connectors/connector-type-registry';
import { runApifyActor } from '../apify-executor';
import { executeVendorTool } from '../vendor-execution';

const executeMock = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  executeMock.mockReset();
  (getCatalog as jest.Mock).mockResolvedValue({
    connectors: [{ type: 'apify', status: 'internal' }, { type: 'zoho', status: 'available' }],
  });
  (fetchRegistry as jest.Mock).mockResolvedValue(
    new Map([['zoho', { connectorType: 'zoho', functionNames: ['list_accounts'] }]]),
  );
  (toolClassifier.getCachedClassification as jest.Mock).mockResolvedValue({
    categories: ['read'], isManualOverride: false, toolDescriptionHash: 'h',
  });
  (getConnectorServiceClient as jest.Mock).mockReturnValue({ execute: executeMock });
  (listConnectorsForTenant as jest.Mock).mockResolvedValue([{ id: 'conn-zoho-1', type: 'zoho', status: 'active' }]);
});

const listAccounts = (args: Record<string, unknown>) =>
  executeVendorTool({ tenantId: 't1', accountId: 'acct-7', connectorType: 'zoho', toolName: 'list_accounts', args, caller: 'caio' });

describe('a connector function that rejects the arguments', () => {
  it('is an argument rejection when the wire says so', async () => {
    executeMock.mockResolvedValue({ success: false, error: 'fields must be a string', errorCode: 'invalid_arguments', costUsd: 0 });
    const out = await listAccounts({ fields: ['Account_Name'] });
    expect(out).toEqual({ success: false, argumentsRejected: true, reason: 'fields must be a string' });
  });

  it('is an argument rejection when the wire could not classify a validation message', async () => {
    executeMock.mockResolvedValue({
      success: false,
      error: 'Invalid request data provided\n- Input should be a valid string on parameter `fields`',
      errorCode: 'internal_error',
      costUsd: 0,
    });
    const out = await listAccounts({ fields: ['Account_Name'] });
    expect(out).toMatchObject({ success: false, argumentsRejected: true });
  });

  it('is not one when the wire names another cause', async () => {
    executeMock.mockResolvedValue({ success: false, error: 'invalid request: account not found', errorCode: 'not_found', costUsd: 0 });
    const out = await listAccounts({ fields: 'Account_Name' });
    expect(out).toEqual({ success: false, reason: 'invalid request: account not found' });
  });
});

describe('an actor run that rejects its input', () => {
  it('is an argument rejection carrying the source’s account of it', async () => {
    (runApifyActor as jest.Mock).mockResolvedValue({
      success: false,
      error: 'Input is not valid: Field input.searchTerms must be array',
      argumentsRejected: true,
    });
    const out = await executeVendorTool({
      tenantId: 't1', accountId: 'acct-7', connectorType: 'apify', toolName: 'run_actor',
      args: { searchTerms: 'Shopify' }, presetArgs: { actorId: 'someone/reddit-search' }, caller: 'caio',
    });
    expect(out).toEqual({ success: false, argumentsRejected: true, reason: 'Input is not valid: Field input.searchTerms must be array' });
  });

  it('a run that failed for another reason stays a plain failure', async () => {
    (runApifyActor as jest.Mock).mockResolvedValue({ success: false, error: 'the source returned an error (400): {"error":{"type":"run-failed"}}' });
    const out = await executeVendorTool({
      tenantId: 't1', accountId: 'acct-7', connectorType: 'apify', toolName: 'run_actor',
      args: {}, presetArgs: { actorId: 'someone/reddit-search' }, caller: 'caio',
    });
    expect(out).toEqual({ success: false, reason: 'the source returned an error (400): {"error":{"type":"run-failed"}}' });
  });
});
