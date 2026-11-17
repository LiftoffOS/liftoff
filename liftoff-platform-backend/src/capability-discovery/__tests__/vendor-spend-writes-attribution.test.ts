// The cost row a capability call books says WHO spent it.
//
// The gap this closes is in my own earlier work, not in the original code: I
// added `agentId` and `purpose` to bookVendorSpend and threaded them through
// three call sites, and then tested only the caller-to-surface MAPPING. Nothing
// asserted that the values reach `ingestEventWithBuckets` — which is the one
// step that actually writes them onto cost_attribution_events, and the only
// step whose failure is invisible: a row booked without them still bills
// correctly, it just stops being answerable, which is precisely how $6.59 of
// vendor spend in a week came to be reported as "Unattributed".
//
// Three call sites book: the connector-registry path, the platform Apify rung,
// and the workspace-account Apify rung. All three are covered, because a rung
// that books anonymously while its siblings book by name is how this started.

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
const mockIngest = jest.fn().mockResolvedValue(1);
jest.mock('../../cost-attribution/repository', () => ({
  ingestEventWithBuckets: (...a: unknown[]) => mockIngest(...a),
  resolveAccountIdForTenant: jest.fn().mockResolvedValue('acct-1'),
}));
jest.mock('../apify-executor', () => ({ runApifyActor: jest.fn() }));
jest.mock('../../billing/execution-guard', () => ({
  checkExecutionAllowed: jest.fn().mockResolvedValue({ allowed: true }),
}));

import { toolClassifier } from '../../mcp/tool-classifier';
import { getCatalog, getConnectorServiceClient, listConnectorsForTenant } from '../../connectors/connector-service-client';
import { fetchConnectorFunctions, fetchRegistry } from '../../connectors/connector-type-registry';
import { runApifyActor } from '../apify-executor';
import { executeVendorTool } from '../vendor-execution';

const executeMock = jest.fn();
const schema = { type: 'object' as const, properties: { query: { type: 'string' } } };
const TEAM = '44444444-4444-4444-8444-444444444444';

/** The ledger template handed to ingestEventWithBuckets on the first booking. */
const booked = () => mockIngest.mock.calls[0]?.[3] as Record<string, unknown> | undefined;

beforeEach(() => {
  jest.clearAllMocks();
  mockIngest.mockResolvedValue(1);
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
  (runApifyActor as jest.Mock).mockResolvedValue({ success: true, items: [], costUsd: 0.01, runId: 'r1', fundingSource: 'platform_key' });
});

const run = (over: Record<string, unknown> = {}) =>
  executeVendorTool({
    tenantId: 't1', accountId: 'acct-7', connectorType: 'locus', toolName: 'email_verify',
    args: { query: 'x' }, caller: 'assistant', ...over,
  } as Parameters<typeof executeVendorTool>[0]);

describe('a connector call books who spent it', () => {
  it("an agent's run carries its internal_agents id", async () => {
    await run({ caller: 'agent', agentId: TEAM });
    expect(booked()).toMatchObject({ eventType: 'connector_call', agentId: TEAM });
  });

  it('an agent carries NO surface — it is not one', async () => {
    await run({ caller: 'agent', agentId: TEAM });
    expect(booked()!.purpose).toBeUndefined();
  });

  it("Liftoff's run carries its surface and no agent", async () => {
    await run({ caller: 'assistant' });
    expect(booked()).toMatchObject({ purpose: 'liftoff' });
    expect(booked()!.agentId).toBeUndefined();
  });

  it("the Chief AI Officer's run carries team_plan", async () => {
    await run({ caller: 'caio' });
    expect(booked()).toMatchObject({ purpose: 'team_plan' });
  });

  it('a team run with no id still books, unattributed rather than wrong', async () => {
    // The runtime omits the id when its reverse mapping misses. Billing must
    // not depend on attribution being known.
    await run({ caller: 'agent' });
    expect(mockIngest).toHaveBeenCalledTimes(1);
    expect(booked()!.agentId).toBeUndefined();
    expect(booked()!.purpose).toBeUndefined();
  });
});

describe('every rung books the same way', () => {
  it('the platform Apify rung carries the attribution too', async () => {
    await run({ connectorType: 'apify', toolName: 'run_actor', caller: 'agent', agentId: TEAM,
      presetArgs: { actorId: 'memo23/crunchbase-scraper' } });
    expect(booked()).toMatchObject({ connector: 'apify', agentId: TEAM });
  });

  it("the workspace's OWN Apify account rung carries it as well", async () => {
    // This rung books through a different function. It booked anonymously
    // while its siblings booked by name until it was threaded too, which is
    // the shape of the defect this whole change removes.
    (listConnectorsForTenant as jest.Mock).mockResolvedValue([{ id: 'conn-apify-own', type: 'apify', status: 'active' }]);
    executeMock.mockResolvedValue({
      success: true, result: { runId: 'r9', items: [{ a: 1 }] }, costUsd: 0.02, fundingSource: 'tenant_key',
    });

    await run({ connectorType: 'apify', toolName: 'run_actor', caller: 'assistant',
      presetArgs: { actorId: 'memo23/crunchbase-scraper' } });

    expect(mockIngest).toHaveBeenCalled();
    expect(booked()).toMatchObject({ connector: 'apify', purpose: 'liftoff' });
  });
});

describe('what the page reads back', () => {
  it('the surface written here is one the Cost Breakdown can name', async () => {
    // A surface this writes but `assistantForPurpose` does not recognise would
    // land the spend right back under "Unattributed" — the defect surviving
    // its own fix.
    const { assistantForPurpose } = await import('../../insights/platform-assistants');
    for (const caller of ['assistant', 'caio'] as const) {
      mockIngest.mockClear();
      await run({ caller });
      const purpose = booked()!.purpose as string;
      expect(assistantForPurpose(purpose)).not.toBeNull();
    }
  });
});
