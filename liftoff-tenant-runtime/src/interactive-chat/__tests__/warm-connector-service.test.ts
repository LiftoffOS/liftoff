// Phase 1a-ii perf fix #3 — verify fire-and-forget warm() on invocation
// start calls ConnectorService.warm once with the agent's connectorTypes.

const mockWarm = jest.fn();
jest.mock('../../connectors/connector-service-client', () => ({
  getConnectorServiceClient: () => ({ warm: mockWarm }),
}));

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../../infrastructure/logging', () => ({ logger: mockLogger }));

// Minimal mocks for the rest of the chat-turn-handler module's transitive
// imports. We only exercise warmConnectorServiceFireAndForget so most of
// this is just to let the module load cleanly under Jest.
jest.mock('express', () => ({ Router: () => ({ use: jest.fn(), post: jest.fn() }) }), {
  virtual: false,
});
jest.mock('../../security/service-auth', () => ({ requireServiceAuth: () => (_req: unknown, _res: unknown, next: () => void) => next() }));
jest.mock('@anthropic-ai/claude-agent-sdk', () => ({}), { virtual: true });
jest.mock('../../tool-gateway/mcp-server', () => ({ createToolGatewayMcpServer: jest.fn() }));
jest.mock('../../tool-gateway/service', () => ({ ToolGatewayService: jest.fn() }));
jest.mock('../../agent-execution/engine/claude-md-materializer', () => ({ materializeInvocationWorkspace: jest.fn() }));
jest.mock('../../memory/service', () => ({ memoryService: { retrieveMemories: jest.fn() } }));
jest.mock('../../invocations', () => ({ invocationsService: {} }));
jest.mock('../../connectors/manifest-repository', () => ({ connectorManifestRepository: {} }));
jest.mock('../../infrastructure/database', () => ({
  getPoolForService: () => ({ query: jest.fn() }),
  getPool: () => ({ query: jest.fn() }),
}));
jest.mock('../../audit/service', () => ({ insertAuditLog: jest.fn() }));
jest.mock('../system-prompt', () => ({ buildAgentChatSystemPrompt: jest.fn(), getHitlDescription: jest.fn() }));
jest.mock('../chat-sdk-hooks', () => ({ writeSSE: jest.fn() }));
jest.mock('../locks', () => ({
  tryAcquireLock: jest.fn(),
  releaseLock: jest.fn(),
  LockServiceUnavailableError: class {},
}));
jest.mock('../sigterm-handler', () => ({ drainController: { register: jest.fn(), unregister: jest.fn() } }));
jest.mock('../../workspace/path-isolation', () => ({ buildPathIsolationHook: jest.fn() }));
jest.mock('../../workspace/untrusted-content-wrapper', () => ({ UntrustedContentFramer: jest.fn() }));
jest.mock('../../observability/scrub-logger', () => ({ scrubLogger: mockLogger }));
jest.mock('../../startup/schema-check', () => ({ isSchemaReady: () => true }));

import { warmConnectorServiceFireAndForget } from '../chat-turn-handler';

describe('warmConnectorServiceFireAndForget', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('calls ConnectorService.warm exactly once with the supplied connector types', async () => {
    mockWarm.mockResolvedValueOnce({ warmedConnectorTypes: ['slack', 'google_mail'], failures: [] });

    warmConnectorServiceFireAndForget('tenant-1', ['slack', 'google_mail']);

    // Allow the detached promise to resolve.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(mockWarm).toHaveBeenCalledTimes(1);
    expect(mockWarm).toHaveBeenCalledWith({
      tenantContext: { tenantId: 'tenant-1' },
      connectorTypes: ['slack', 'google_mail'],
    });
  });

  it('returns immediately (fire-and-forget — does not await warm response)', () => {
    // Never resolve so we prove the function returns without waiting.
    mockWarm.mockImplementationOnce(() => new Promise(() => {}));

    const ret = warmConnectorServiceFireAndForget('tenant-2', ['github']);
    expect(ret).toBeUndefined(); // sync return
  });

  it('skips the RPC entirely when connectorTypes is empty', async () => {
    warmConnectorServiceFireAndForget('tenant-3', []);
    await new Promise((r) => setImmediate(r));
    expect(mockWarm).not.toHaveBeenCalled();
  });

  it('swallows warm errors (never throws on failure)', async () => {
    mockWarm.mockRejectedValueOnce(new Error('connector-service down'));

    expect(() => warmConnectorServiceFireAndForget('tenant-4', ['slack'])).not.toThrow();

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(mockLogger.debug).toHaveBeenCalled();
  });
});
