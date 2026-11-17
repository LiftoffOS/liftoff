// FITNESS FUNCTION — a vendor tool call that cannot report usage is not
// shippable, whoever's key paid for it (the same property the byok-gateway
// enumerating test encodes for LLM calls, applied to data vendors).
//
// Enumerates PLATFORM_EXECUTABLE_VENDORS rather than a hand-written list: a
// vendor added there without flowing through the evidence-recording dispatch
// path fails here, at the point it is added.

jest.mock('../../connectors/connector-service-client', () => ({
  getCatalog: jest.fn(),
  getConnectorServiceClient: jest.fn(),
}));
jest.mock('../../connectors/connector-type-registry', () => ({
  fetchRegistry: jest.fn(),
}));
jest.mock('../../mcp/tool-classifier', () => ({
  toolClassifier: { getCachedClassification: jest.fn() },
}));
jest.mock('../evidence', () => ({
  recordUsageEvidence: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../cost-attribution/repository', () => ({
  ingestEventWithBuckets: jest.fn().mockResolvedValue(1),
  resolveAccountIdForTenant: jest.fn().mockResolvedValue('acct-1'),
}));

import { toolClassifier } from '../../mcp/tool-classifier';
import {
  getCatalog,
  getConnectorServiceClient,
} from '../../connectors/connector-service-client';
import { fetchRegistry } from '../../connectors/connector-type-registry';
import { recordUsageEvidence } from '../evidence';
import { ingestEventWithBuckets, resolveAccountIdForTenant } from '../../cost-attribution/repository';
import {
  executeVendorTool,
  _BYO_ONLY_VENDORS,
  _PLATFORM_EXECUTABLE_VENDORS,
} from '../vendor-execution';

const TOOL = 'some_read_tool';
const executeMock = jest.fn();

function wireHappyPath(vendor: string) {
  (getCatalog as jest.Mock).mockResolvedValue({
    connectors: [{ type: vendor, status: 'internal' }],
  });
  (fetchRegistry as jest.Mock).mockResolvedValue(
    new Map([[vendor, { connectorType: vendor, functionNames: [TOOL] }]]),
  );
  (toolClassifier.getCachedClassification as jest.Mock).mockResolvedValue({
    categories: ['read'],
    isManualOverride: false,
    toolDescriptionHash: 'h',
  });
  (getConnectorServiceClient as jest.Mock).mockReturnValue({ execute: executeMock });
}

describe('vendor usage invariant — every platform-funded vendor records evidence', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const vendors = [..._PLATFORM_EXECUTABLE_VENDORS];
  it('enumerates a non-empty vendor registry', () => {
    expect(vendors.length).toBeGreaterThan(0);
  });

  for (const vendor of vendors) {
    it(`${vendor}: success writes a usage-evidence row with the reported cost`, async () => {
      wireHappyPath(vendor);
      executeMock.mockResolvedValue({
        success: true,
        result: { ok: true },
        error: '',
        vendorLatencyMs: 12n,
        costUsd: 0.03,
      });
      const out = await executeVendorTool({ tenantId: 't-1', connectorType: vendor, toolName: TOOL, args: {} });
      expect(out.success).toBe(true);
      // The dispatch addresses the platform identity, never a phantom UUID.
      expect(executeMock.mock.calls[0][0].connectorId).toBe(`internal:${vendor}`);
      expect(recordUsageEvidence).toHaveBeenCalledWith(
        expect.objectContaining({ sourceRef: `${vendor}:${TOOL}`, success: true, costUsd: 0.03 }),
      );
    });

    it(`${vendor}: a vendor failure STILL writes a usage-evidence row`, async () => {
      wireHappyPath(vendor);
      executeMock.mockResolvedValue({
        success: false,
        result: {},
        error: 'vendor said no',
        vendorLatencyMs: 5n,
        costUsd: 0,
      });
      const out = await executeVendorTool({ tenantId: 't-1', connectorType: vendor, toolName: TOOL, args: {} });
      expect(out).toEqual({ success: false, reason: 'vendor said no' });
      expect(recordUsageEvidence).toHaveBeenCalledWith(
        expect.objectContaining({ sourceRef: `${vendor}:${TOOL}`, success: false }),
      );
    });

    it(`${vendor}: a transport failure STILL writes a usage-evidence row`, async () => {
      wireHappyPath(vendor);
      executeMock.mockRejectedValue(new Error('rpc down'));
      const out = await executeVendorTool({ tenantId: 't-1', connectorType: vendor, toolName: TOOL, args: {} });
      expect(out.success).toBe(false);
      expect(recordUsageEvidence).toHaveBeenCalledWith(
        expect.objectContaining({ sourceRef: `${vendor}:${TOOL}`, success: false }),
      );
    });
  }
});

describe('capability calls book spend per funding_source (INV-PB-013 / INV-PB-014)', () => {
  // A capability run executes the vendor call inside platform-backend, so it
  // never reaches the tenant-runtime usage-ledger feed the poller ingests.
  // This is the only site that can book the spend; the charge follows
  // connector-service's funding_source.
  beforeEach(() => jest.clearAllMocks());

  it("an x402-funded success books a connector_call row via the wallet-funded branch", async () => {
    wireHappyPath('gloria');
    executeMock.mockResolvedValue({
      success: true,
      result: { summary: 'BTC up' },
      error: '',
      vendorLatencyMs: 20n,
      costUsd: 0.05,
      fundingSource: 'x402_wallet',
    });
    const out = await executeVendorTool({ tenantId: 't-1', accountId: 'caller-1', connectorType: 'gloria', toolName: TOOL, args: {} });
    expect(out.success).toBe(true);
    expect(resolveAccountIdForTenant).toHaveBeenCalledWith('t-1');
    expect(ingestEventWithBuckets).toHaveBeenCalledWith(
      'acct-1',
      expect.any(String),
      0.05,
      expect.objectContaining({
        tenantId: 't-1',
        eventType: 'connector_call',
        connector: 'gloria',
        actionType: TOOL,
        x402Funded: true,
        usageQuantity: 1,
        usageUnit: 'call',
      }),
    );
  });

  it("a platform_key call with a real cost charges the workspace OUs (customer path, not x402, not byok)", async () => {
    wireHappyPath('tikhub');
    executeMock.mockResolvedValue({
      success: true,
      result: { posts: [] },
      error: '',
      vendorLatencyMs: 8n,
      costUsd: 0.01,
      fundingSource: 'platform_key',
    });
    const out = await executeVendorTool({ tenantId: 't-1', accountId: '', connectorType: 'tikhub', toolName: TOOL, args: {} });
    expect(out.success).toBe(true);
    const call = (ingestEventWithBuckets as jest.Mock).mock.calls[0];
    expect(call[0]).toBe('acct-1');
    expect(call[2]).toBe(0.01);
    expect(call[3]).toEqual(expect.objectContaining({ eventType: 'connector_call', connector: 'tikhub', usageUnit: 'call' }));
    expect(call[3]).not.toHaveProperty('x402Funded');
    expect(call[3]).not.toHaveProperty('byokFunded');
  });

  it("a tenant_key (BYOK) call is zero-rated but still recorded (INV-PB-014, no double charge)", async () => {
    // funding_source is the authority on which key paid; when connector-service
    // reports the tenant's own key funded the call, the booking zero-rates it.
    wireHappyPath('tikhub');
    executeMock.mockResolvedValue({
      success: true,
      result: { ok: true },
      error: '',
      vendorLatencyMs: 8n,
      costUsd: 0.02,
      fundingSource: 'tenant_key',
    });
    const out = await executeVendorTool({ tenantId: 't-1', accountId: 'c', connectorType: 'tikhub', toolName: TOOL, args: {} });
    expect(out.success).toBe(true);
    const call = (ingestEventWithBuckets as jest.Mock).mock.calls[0];
    expect(call[3]).toEqual(expect.objectContaining({ byokFunded: true, eventType: 'connector_call' }));
    expect(call[3]).not.toHaveProperty('x402Funded');
  });

  it("a zero-cost platform call (gloria free, nasdaq) books nothing", async () => {
    wireHappyPath('nasdaq');
    executeMock.mockResolvedValue({
      success: true,
      result: { price: 1 },
      error: '',
      vendorLatencyMs: 8n,
      costUsd: 0,
      fundingSource: 'platform_key',
    });
    const out = await executeVendorTool({ tenantId: 't-1', accountId: '', connectorType: 'nasdaq', toolName: TOOL, args: {} });
    expect(out.success).toBe(true);
    expect(ingestEventWithBuckets).not.toHaveBeenCalled();
  });

  it("an x402 booking failure does NOT fail the tool result (billing swallowed)", async () => {
    wireHappyPath('gloria');
    executeMock.mockResolvedValue({
      success: true,
      result: { summary: 'ok' },
      error: '',
      vendorLatencyMs: 9n,
      costUsd: 0.05,
      fundingSource: 'x402_wallet',
    });
    (ingestEventWithBuckets as jest.Mock).mockRejectedValueOnce(new Error('billing down'));
    const out = await executeVendorTool({ tenantId: 't-1', accountId: 'c', connectorType: 'gloria', toolName: TOOL, args: {} });
    expect(out.success).toBe(true);
  });
});

describe('gates that refuse BEFORE transport', () => {
  beforeEach(() => jest.clearAllMocks());

  it('BYO-only vendors never execute from this surface', async () => {
    for (const vendor of _BYO_ONLY_VENDORS) {
      (getCatalog as jest.Mock).mockResolvedValue({
        connectors: [{ type: vendor, status: 'available' }],
      });
      const out = await executeVendorTool({ tenantId: 't-1', connectorType: vendor, toolName: TOOL, args: {} });
      expect(out.success).toBe(false);
    }
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('a vendor outside the platform-executable set refuses honestly', async () => {
    // apify is composio-managed (no native internal: executor), so it is not in
    // the platform-executable set and, with no tenant connector, refuses.
    (getCatalog as jest.Mock).mockResolvedValue({
      connectors: [{ type: 'apify', status: 'internal' }],
    });
    const out = await executeVendorTool({ tenantId: 't-1', connectorType: 'apify', toolName: TOOL, args: {} });
    expect(out).toEqual(
      expect.objectContaining({ success: false, reason: expect.stringContaining('no platform execution path') }),
    );
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('an unclassified tool does not run (fail-closed)', async () => {
    wireHappyPath('tikhub');
    (toolClassifier.getCachedClassification as jest.Mock).mockResolvedValue(null);
    const out = await executeVendorTool({ tenantId: 't-1', connectorType: 'tikhub', toolName: TOOL, args: {} });
    expect(out).toEqual(expect.objectContaining({ success: false }));
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('a write-classified tool does not run from this surface', async () => {
    wireHappyPath('tikhub');
    (toolClassifier.getCachedClassification as jest.Mock).mockResolvedValue({
      categories: ['write'],
      isManualOverride: false,
      toolDescriptionHash: 'h',
    });
    const out = await executeVendorTool({ tenantId: 't-1', connectorType: 'tikhub', toolName: TOOL, args: {} });
    expect(out).toEqual(expect.objectContaining({ success: false }));
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('a tool outside the curated registry does not run, whatever a live server advertises', async () => {
    wireHappyPath('tikhub');
    (fetchRegistry as jest.Mock).mockResolvedValue(
      new Map([['tikhub', { connectorType: 'tikhub', functionNames: ['other_tool'] }]]),
    );
    const out = await executeVendorTool({ tenantId: 't-1', connectorType: 'tikhub', toolName: TOOL, args: {} });
    expect(out).toEqual(expect.objectContaining({ success: false }));
    expect(executeMock).not.toHaveBeenCalled();
  });
});
