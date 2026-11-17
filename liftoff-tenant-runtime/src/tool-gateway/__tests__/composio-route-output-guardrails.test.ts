// The Composio route runs the output guardrails, and what it lifts reaches the surface.
//
// The in-process bridge dispatches Composio tools itself — most catalog tools,
// on the engine most runs use — and handed the vendor's response straight to
// the model. `execute()` ran the secret scrubber and the egress lift; this
// branch ran neither, and both guardrails' tests passed against the path that
// never carried them. So Google Drive `download_file` could return a signed
// URL declared `egressOnly`, and the model would quote it back in full.
//
// This drives the real bridge with the real guardrails and the real schema
// lookup; only the vendor is a stub. Three things must hold at once: the
// model's copy carries the placeholder and no secret, the ledger got the same
// guarded copy, and the lifted value is waiting in THIS process for the chat
// turn that delivers it.

jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  tool: jest.fn((_name: string, _desc: string, _schema: unknown, handler: (...args: unknown[]) => unknown) => ({ name: _name, description: _desc, handler })),
  createSdkMcpServer: jest.fn((opts: { tools: unknown[] }) => ({ type: 'sdk', name: opts.name || 'test', tools: opts.tools })),
}));

const DOWNLOAD_FILE = {
  name: 'download_file',
  description: 'Download a file',
  inputSchema: { type: 'object', properties: { file_id: { type: 'string' } }, required: ['file_id'] },
  categories: ['read'],
  entityType: 'file',
  definitionSource: 'composio',
  vendorToolName: 'GOOGLEDRIVE_DOWNLOAD_FILE',
  egressOnly: ['downloaded_file_content.s3url'],
};
jest.mock('../../connectors/tool-schema-cache', () => ({
  getToolSchemas: jest.fn().mockReturnValue([DOWNLOAD_FILE]),
  // The guardrail resolves the declaration the way the gateway does: by the
  // connector on the context, normalised to the catalog key.
  getToolSchema: (type: string, name: string) => (type === 'google_drive' && name === 'download_file' ? DOWNLOAD_FILE : null),
  catalogTypeFor: (alias: string) => alias.replace(/-[0-9a-f]{8}$/, '').replace(/-/g, '_'),
  listConnectorTypes: jest.fn().mockReturnValue(['google_drive']),
}));
jest.mock('../../connectors/manifest-repository', () => ({
  connectorManifestRepository: {
    getManifestsForAgent: jest.fn().mockResolvedValue([
      { id: '8fbfbd68-fc15-47d1-b777-dca252f14a0d', connectorType: 'google_drive', alias: 'google-drive-8fbfbd68', displayName: 'Google Drive', enabled: true, externalAccountId: 'ca_1' },
    ]),
  },
}));
jest.mock('../../tools/standard-tools', () => ({ STANDARD_TOOLS: [] }));
jest.mock('../../tools/standard-tool-handler', () => ({ executeStandardTool: jest.fn().mockResolvedValue(null) }));
jest.mock('../../platform-callback/client', () => ({
  getPlatformCallbackClient: jest.fn(() => ({ fetch: jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ count: 0 }) }) })),
}));
jest.mock('../../infrastructure/database', () => ({
  getPoolForService: () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }),
  getPool: () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }),
}));
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../connectors/connector-service-client', () => ({ getConnectorServiceClient: jest.fn().mockReturnValue({}) }));
const insertAuditLog = jest.fn().mockResolvedValue(undefined);
jest.mock('../../audit', () => ({ insertAuditLog: (...a: unknown[]) => insertAuditLog(...a) }));

const SIGNED_URL = 'https://temp.example.r2.cloudflarestorage.com/x/response/abc?X-Amz-Signature=deadbeef';
const dispatchComposio = jest.fn();
jest.mock('../composio-dispatcher', () => ({
  dispatchComposio: (...a: unknown[]) => dispatchComposio(...a),
  dispatchComposioWithPolling: (...a: unknown[]) => dispatchComposio(...a),
}));

import { createToolGatewayMcpServer } from '../mcp-server';
import { drainHostDelivered, _resetHostDeliveredForTesting } from '../host-delivered';
import { EGRESS_ONLY_PLACEHOLDER } from '../output-guardrails';

const INVOCATION = '11111111-2222-4333-8444-555555555555';
const recordSelfDispatched = jest.fn().mockResolvedValue(undefined);
const toolGateway = {
  execute: jest.fn(),
  preDispatchGuards: jest.fn().mockResolvedValue(null),
  // The stage/apply protocol's dispatch half; nothing here stages or applies.
  stagedApplyPayload: jest.fn().mockReturnValue(undefined),
  settleStagedApply: jest.fn().mockResolvedValue(undefined),
  recordSelfDispatched: (...a: unknown[]) => recordSelfDispatched(...a),
  setCredentialService: jest.fn(),
};

beforeEach(() => {
  jest.clearAllMocks();
  _resetHostDeliveredForTesting();
  const { __resetKnowledgeExposureCache } = jest.requireActual('../knowledge-exposure-cache');
  __resetKnowledgeExposureCache();
  dispatchComposio.mockResolvedValue({
    display_url: 'https://docs.google.com/document/d/f1/edit',
    downloaded_file_content: { name: 'nda.txt', mimetype: 'text/plain', s3url: SIGNED_URL },
    // A credential-shaped value in a vendor response, which the scrubber
    // exists for and which this branch never showed it.
    note: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    id: 'f1',
  });
});

async function callDownload() {
  const server = await createToolGatewayMcpServer({
    tenantId: 't1', agentId: 'a1', instructionVersion: 1, traceId: 'trace', invocationId: INVOCATION,
    allowedConnectors: ['google_drive'],
    toolGateway: toolGateway as never,
  } as never);
  const tool = server.mcpServer.tools.find((t: { name: string }) => t.name === 'google-drive-8fbfbd68__download_file') as { handler: (args: unknown) => Promise<{ content: Array<{ text: string }> }> };
  expect(tool).toBeDefined();
  return tool.handler({ file_id: 'f1' });
}

it('the model sees the placeholder and no secret; the person can still collect the link', async () => {
  const out = await callDownload();
  const text = out.content.map((c) => c.text).join('\n');
  expect(dispatchComposio).toHaveBeenCalledTimes(1);

  expect(text).toContain(EGRESS_ONLY_PLACEHOLDER);
  expect(text).not.toContain(SIGNED_URL);
  expect(text).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
  expect(text).toContain('[REDACTED:');

  expect(drainHostDelivered(INVOCATION)).toEqual([
    { toolName: 'download_file', fields: { 'downloaded_file_content.s3url': SIGNED_URL } },
  ]);
});

it('the ledger and the audit row get the guarded copy, not the vendor\'s', async () => {
  await callDownload();
  const ledgered = JSON.stringify(recordSelfDispatched.mock.calls[0]?.[1]);
  expect(ledgered).not.toContain(SIGNED_URL);
  expect(ledgered).toContain(EGRESS_ONLY_PLACEHOLDER);
  const audited = JSON.stringify(insertAuditLog.mock.calls[0]?.[2]);
  expect(audited).not.toContain(SIGNED_URL);
  expect(audited).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
});
