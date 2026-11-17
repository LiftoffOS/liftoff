// The park writer is the one sandbox consumer with nobody to retry for it.
//
// sandbox-executor answers `vendor_unavailable` + `retryable: true` +
// `retryAfterMs` while a workspace is provisioning, deliberately rather than
// holding the request open — "the caller's own deadline is shorter than a
// provision". Every model-facing sandbox tool honours that: mcp-server forwards
// the flags through buildToolErrorContent precisely so "a retryable condition —
// a workspace still starting — reads identically to a permanent one and gets
// abandoned".
//
// writeWorkspaceFile had no such party. It is called BY THE PLATFORM to park an
// oversized result, so no model ever sees its error and nothing downstream reads
// the flag: `result.success === true` dropped it, result-dataset fell back to an
// unparked payload, and the SDK spilled it to a file the model then has to slice
// by character range. Provisioning takes about a minute and a scheduled run gets
// a per-run workspace (session identity falls to invocationId with no thread),
// so the cold window lands on the FIRST oversized result of a run — the one most
// worth parking — for a reason that clears itself in seconds.
jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  tool: jest.fn((name: string, _d: unknown, _s: unknown, handler: unknown) => ({ name, handler })),
  createSdkMcpServer: jest.fn((opts: { tools: unknown[] }) => ({ type: 'sdk', tools: opts.tools })),
}));
jest.mock('../../connectors/tool-schema-cache', () => ({
  getToolSchemas: jest.fn().mockReturnValue([]),
  listConnectorTypes: jest.fn().mockReturnValue([]),
}));
jest.mock('../../connectors/manifest-repository', () => ({
  connectorManifestRepository: { getManifestsForAgent: jest.fn().mockResolvedValue([]) },
}));
jest.mock('../../tools/standard-tools', () => ({ STANDARD_TOOLS: [] }));
jest.mock('../../tools/standard-tool-handler', () => ({ executeStandardTool: jest.fn() }));

const mockQuery = jest.fn().mockResolvedValue({ rows: [] });
jest.mock('../../infrastructure/database', () => ({
  getPoolForService: () => ({ query: mockQuery }),
}));
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../connectors/connector-service-client', () => ({
  getConnectorServiceClient: jest.fn().mockReturnValue({}),
}));
jest.mock('../../audit', () => ({ insertAuditLog: jest.fn().mockResolvedValue(undefined) }));

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

import { createToolGatewayMcpServer } from '../mcp-server';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const AGENT_ID = '22222222-2222-2222-2222-222222222222';

/** A provisioning answer, byte-shaped like sandbox-executor's. */
const stillStarting = {
  success: false,
  data: {},
  traceId: 't',
  error: 'The workspace for this run is still starting.',
  errorCode: 'vendor_unavailable',
  retryable: true,
  retryAfterMs: 1,
};
const ok = { success: true, data: {}, traceId: 't' };

async function writerWith(execute: jest.Mock) {
  const result = await createToolGatewayMcpServer({
    tenantId: TENANT_ID,
    agentId: AGENT_ID,
    instructionVersion: 1,
    traceId: 'trace',
    allowedConnectors: [],
    toolGateway: { execute },
    sandboxCapabilities: ['shell', 'file'],
    invocationId: 'inv-1',

  } as never);
  return (result as unknown as {
    writeWorkspaceFile: ((p: string, c: string) => Promise<boolean>) | null;
  }).writeWorkspaceFile;
}

beforeEach(() => {
  mockFetch.mockReset();
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
  process.env.PLATFORM_BACKEND_URL = 'http://platform-backend-test';
  process.env.PLATFORM_CALLBACK_TOKEN = 'test-callback-token';
  mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ count: 0 }) });
  const { __resetKnowledgeExposureCache } = jest.requireActual('../knowledge-exposure-cache');
  __resetKnowledgeExposureCache();
});

describe('workspace park write', () => {
  it('waits out a provisioning workspace instead of giving up on the park', async () => {
    const execute = jest.fn()
      .mockResolvedValueOnce(stillStarting)
      .mockResolvedValueOnce(stillStarting)
      .mockResolvedValueOnce(ok);

    const write = await writerWith(execute);
    await expect(write!('/datasets/x.json', '{}')).resolves.toBe(true);
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it('does not retry a failure the executor called permanent', async () => {
    const execute = jest.fn().mockResolvedValue({
      success: false, data: {}, traceId: 't',
      error: 'sandbox tool call failed', errorCode: 'internal_error', retryable: false,
    });

    const write = await writerWith(execute);
    await expect(write!('/datasets/x.json', '{}')).resolves.toBe(false);
    // Retrying a permanent failure burns the budget the parked result exists to
    // protect — the run's wall clock is the thing under pressure here.
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('gives up rather than retrying forever, and fails open', async () => {
    const execute = jest.fn().mockResolvedValue(stillStarting);

    const write = await writerWith(execute);
    // False, not a throw: result-dataset reads this as "no parked copy" and
    // passes the payload through inline, which is the pre-existing behaviour.
    await expect(write!('/datasets/x.json', '{}')).resolves.toBe(false);
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it('reuses one idempotency key across attempts', async () => {
    const execute = jest.fn()
      .mockResolvedValueOnce(stillStarting)
      .mockResolvedValueOnce(ok);

    const write = await writerWith(execute);
    await write!('/datasets/x.json', '{}');

    const keys = execute.mock.calls.map((c) => (c[0] as { idempotencyKey: string }).idempotencyKey);
    expect(new Set(keys).size).toBe(1);
  });

  it('is null when the agent has no file capability, so nothing is attempted', async () => {
    const execute = jest.fn();
    const result = await createToolGatewayMcpServer({
      tenantId: TENANT_ID,
      agentId: AGENT_ID,
      instructionVersion: 1,
      traceId: 'trace',
      allowedConnectors: [],
      toolGateway: { execute },
      sandboxCapabilities: ['shell'],
      invocationId: 'inv-1',

    } as never);

    expect((result as unknown as { writeWorkspaceFile: unknown }).writeWorkspaceFile).toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });
});
