// What the gateway lifts comes back across the hop, and the bridge delivers it.
//
// `execute()` runs in the tool-gateway service, in its own process in every
// environment. The egress guardrail there recorded the lifted value in an
// in-process store — and the chat turn that hands such values to the surface
// drains the in-process store of the AGENT service, which never held it. So a
// field declared for the person was lifted from the model's copy and then
// reached nobody, on the one path where the guardrail actually ran.
//
// Two halves, asserted separately against the real code on each side: the
// gateway hands the lifted values back BESIDE the data and keeps nothing; the
// bridge re-records them in its own process and strips them before anything
// is serialised for the model.

jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  tool: jest.fn((_name: string, _desc: string, _schema: unknown, handler: (...args: unknown[]) => unknown) => ({ name: _name, description: _desc, handler })),
  createSdkMcpServer: jest.fn((opts: { tools: unknown[] }) => ({ type: 'sdk', name: opts.name || 'test', tools: opts.tools })),
}));

const mockExecute = jest.fn();
jest.mock('../../governance/wal', () => ({ writeWalEntry: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../governance/governance-service-flag', () => ({
  getGovernanceServiceMode: () => 'off',
  isGovernanceServiceEnabled: () => false,
  isGovernanceShadowMode: () => false,
}));
jest.mock('../../governance/shadow-mode', () => ({ withGovernanceShadowAndFallback: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../governance/governance-service-client', () => {
  const actual = jest.requireActual('../../governance/governance-service-client');
  return { ...actual, getGovernanceServiceClient: () => ({ record: jest.fn(), authorize: jest.fn() }) };
});
jest.mock('../../connectors/connector-service-client', () => ({
  getConnectorServiceClient: () => ({ execute: mockExecute, executeBatch: jest.fn() }),
}));
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../infrastructure/database', () => ({
  getPool: () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }),
  getPoolForService: () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }),
}));
jest.mock('../../admission/service', () => ({
  AdmissionService: jest.fn().mockImplementation(() => ({ checkAdmission: jest.fn().mockResolvedValue({ allowed: true }) })),
}));
jest.mock('../../action-ledger/service', () => ({
  ActionLedgerService: jest.fn().mockImplementation(() => ({
    getByIdempotencyKey: jest.fn().mockResolvedValue(null),
    recordIntent: jest.fn().mockResolvedValue('action-1'),
    recordOutcome: jest.fn().mockResolvedValue(undefined),
    recordFailure: jest.fn().mockResolvedValue(undefined),
    recordPostActionSnapshot: jest.fn().mockResolvedValue(undefined),
  })),
}));
jest.mock('../state-fetcher', () => ({
  stateFetcherRegistry: { fetchState: jest.fn().mockResolvedValue({ data: {}, fetchedAt: new Date() }) },
  ExternalStateFetcherRegistry: jest.fn(),
}));
jest.mock('../permission-validator', () => ({
  permissionValidator: { validate: jest.fn().mockResolvedValue({ allowed: true, appliedEntry: null }) },
}));
jest.mock('../conflict-policy-registry', () => ({
  ConflictPolicyRegistry: jest.fn().mockImplementation(() => ({
    get: jest.fn().mockResolvedValue({
      connector: 'google_drive', entityType: 'file', actionType: 'download_file',
      freshnessTTL: null, freshReadBeforeWriteRequired: false, versionTokenField: null,
      fieldComparisonSet: [], conflictResolutionMode: 'last-write-wins',
      escalateOnConflict: false, undoSupportMode: 'none',
    }),
  })),
}));
jest.mock('../../connectors/manifest-repository', () => ({
  connectorManifestRepository: {
    getManifestsForAgent: jest.fn().mockResolvedValue([
      { id: '8fbfbd68-fc15-47d1-b777-dca252f14a0d', connectorType: 'google_drive', alias: 'google-drive-8fbfbd68', displayName: 'Google Drive', enabled: true },
    ]),
  },
}));
jest.mock('../../tools/standard-tools', () => ({ STANDARD_TOOLS: [] }));
jest.mock('../../tools/standard-tool-handler', () => ({ executeStandardTool: jest.fn().mockResolvedValue(null) }));
jest.mock('../../platform-callback/client', () => ({
  getPlatformCallbackClient: jest.fn(() => ({ fetch: jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ count: 0 }) }) })),
}));
jest.mock('../../audit', () => ({ insertAuditLog: jest.fn().mockResolvedValue(undefined) }));

import { __setToolSchemaCacheForTests, __clearToolSchemaCacheForTests } from '../../connectors/tool-schema-cache';
import { ToolGatewayService } from '../service';
import { createToolGatewayMcpServer } from '../mcp-server';
import { drainHostDelivered, _resetHostDeliveredForTesting } from '../host-delivered';
import { EGRESS_ONLY_PLACEHOLDER } from '../output-guardrails';
import type { ExecuteInput } from '../types';

const SIGNED_URL = 'https://temp.example.r2.cloudflarestorage.com/x/response/abc?X-Amz-Signature=deadbeef';
const INVOCATION = '11111111-2222-4333-8444-555555555555';

beforeEach(() => {
  jest.clearAllMocks();
  _resetHostDeliveredForTesting();
  __setToolSchemaCacheForTests([{
    connectorType: 'google_drive',
    functions: [{
      name: 'download_file', description: '', categories: ['read'], entityType: 'file',
      inputSchema: { type: 'object', properties: { file_id: { type: 'string' } } },
      egressOnly: ['downloaded_file_content.s3url'],
    }],
  }]);
  const { __resetKnowledgeExposureCache } = jest.requireActual('../knowledge-exposure-cache');
  __resetKnowledgeExposureCache();
});
afterEach(() => __clearToolSchemaCacheForTests());

describe('the gateway side', () => {
  it('lifts the field, hands it back beside the data, and keeps nothing in its own store', async () => {
    mockExecute.mockResolvedValueOnce({
      success: true,
      result: { id: 'f1', downloaded_file_content: { name: 'nda.txt', mimetype: 'text/plain', s3url: SIGNED_URL } },
      error: '',
    });
    const svc = new ToolGatewayService();
    const result = await svc.execute({
      tenantId: 't1', agentId: 'a1', instructionVersion: 1, traceId: 'tr', idempotencyKey: 'k1',
      connector: 'google-drive-8fbfbd68', entityType: 'file', actionType: 'download_file',
      payload: { file_id: 'f1' }, invocationId: INVOCATION,
    } as ExecuteInput);

    expect(result.success).toBe(true);
    expect((result.data as { downloaded_file_content: { s3url: string } }).downloaded_file_content.s3url).toBe(EGRESS_ONLY_PLACEHOLDER);
    expect(result.hostDelivered).toEqual([
      { toolName: 'download_file', fields: { 'downloaded_file_content.s3url': SIGNED_URL } },
    ]);
    // Drained, not copied: the value has left this process with the response
    // and must not also wait here for a chat turn that runs elsewhere.
    expect(drainHostDelivered(INVOCATION)).toEqual([]);
  });
});

describe('the bridge side', () => {
  it('re-records what came back and serialises none of it for the model', async () => {
    const toolGateway = {
      execute: jest.fn().mockResolvedValue({
        success: true, traceId: 'tr',
        data: { id: 'f1', downloaded_file_content: { name: 'nda.txt', s3url: EGRESS_ONLY_PLACEHOLDER } },
        hostDelivered: [{ toolName: 'download_file', fields: { 'downloaded_file_content.s3url': SIGNED_URL } }],
      }),
      preDispatchGuards: jest.fn().mockResolvedValue(null),
  // The stage/apply protocol's dispatch half; nothing here stages or applies.
  stagedApplyPayload: jest.fn().mockReturnValue(undefined),
  settleStagedApply: jest.fn().mockResolvedValue(undefined),
      recordSelfDispatched: jest.fn().mockResolvedValue(undefined),
      setCredentialService: jest.fn(),
    };
    const server = await createToolGatewayMcpServer({
      tenantId: 't1', agentId: 'a1', instructionVersion: 1, traceId: 'trace', invocationId: INVOCATION,
      allowedConnectors: ['google_drive'],
      toolGateway: toolGateway as never,
    } as never);
    const tool = server.mcpServer.tools.find((t: { name: string }) => t.name === 'google-drive-8fbfbd68__download_file') as { handler: (args: unknown) => Promise<{ content: Array<{ text: string }> }> };
    expect(tool).toBeDefined();

    const out = await tool.handler({ file_id: 'f1' });
    const text = out.content.map((c) => c.text).join('\n');
    expect(text).toContain(EGRESS_ONLY_PLACEHOLDER);
    expect(text).not.toContain(SIGNED_URL);
    expect(text).not.toContain('hostDelivered');
    expect(drainHostDelivered(INVOCATION)).toEqual([
      { toolName: 'download_file', fields: { 'downloaded_file_content.s3url': SIGNED_URL } },
    ]);
  });
});
