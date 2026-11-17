// Plan v13 Change 2/4 wiring: the prebuilt chat catalog path must forward
// turnId and messageSenderAccountId into createToolGatewayMcpServer —
// buildChatToolCatalog → buildToolGatewayAndCatalog → gateway. (The last
// hop, gateway input.turnId → endpoint excludeTurnId, is covered in
// tool-gateway/__tests__/recall-conversations.test.ts; the first hop is the
// literal `turnId: body.turnId` fill in chat-turn-handler, schema-tested in
// interactive-chat/__tests__/chat-turn-handler.test.ts.)

const mockCreateGateway = jest.fn();
jest.mock('../../tool-gateway/mcp-server', () => ({
  createToolGatewayMcpServer: (...args: unknown[]) => mockCreateGateway(...args),
}));

const mockQuery = jest.fn().mockResolvedValue({ rows: [] });
jest.mock('../../infrastructure/database', () => ({
  getPoolForService: () => ({ query: mockQuery }),
}));

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { agentExecutionService } from '../service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const AGENT = '22222222-2222-4222-8222-222222222222';
const SENDER = '44444444-4444-4444-8444-444444444444';
const TURN = '55555555-5555-4555-8555-555555555555';

describe('buildChatToolCatalog forwarding (plan v13)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateGateway.mockResolvedValue({
      mcpServer: { tools: [] },
      modelTools: [],
      vendorMcpServers: {},
      activeBrowserSession: null,
    });
  });

  it('forwards turnId and messageSenderAccountId into createToolGatewayMcpServer', async () => {
    await agentExecutionService.buildChatToolCatalog({
      tenantId: TENANT,
      agentId: AGENT,
      instructionVersion: 1,
      integrations: [],
      invocationId: 'inv-1',
      threadId: 'thread-1',
      resolvedProvider: 'anthropic',
      messageSenderAccountId: SENDER,
      turnId: TURN,
    });

    expect(mockCreateGateway).toHaveBeenCalledTimes(1);
    const input = mockCreateGateway.mock.calls[0][0] as Record<string, unknown>;
    expect(input.turnId).toBe(TURN);
    expect(input.messageSenderAccountId).toBe(SENDER);
    expect(input.tenantId).toBe(TENANT);
    expect(input.agentId).toBe(AGENT);
  });

  it('forwards sandboxCapabilities, so a chat turn gets the workspace its tier grants', async () => {
    await agentExecutionService.buildChatToolCatalog({
      tenantId: TENANT,
      agentId: AGENT,
      instructionVersion: 1,
      integrations: [],
      invocationId: 'inv-caps',
      threadId: 'thread-caps',
      resolvedProvider: 'anthropic',
      sandboxCapabilities: ['shell', 'file', 'browser', 'vscode'],
    });

    const input = mockCreateGateway.mock.calls[0][0] as Record<string, unknown>;
    expect(input.sandboxCapabilities).toEqual(['shell', 'file', 'browser', 'vscode']);
  });

  it('leaves a connector_only agent with no sandbox capability', async () => {
    await agentExecutionService.buildChatToolCatalog({
      tenantId: TENANT,
      agentId: AGENT,
      instructionVersion: 1,
      integrations: [],
      invocationId: 'inv-none',
      threadId: 'thread-none',
      resolvedProvider: 'anthropic',
      sandboxCapabilities: [],
    });

    const input = mockCreateGateway.mock.calls[0][0] as Record<string, unknown>;
    expect(input.sandboxCapabilities).toEqual([]);
  });

  it('omits turnId cleanly when the caller has none (non-chat paths)', async () => {
    await agentExecutionService.buildChatToolCatalog({
      tenantId: TENANT,
      agentId: AGENT,
      instructionVersion: 1,
      integrations: [],
      invocationId: 'inv-2',
      threadId: 'thread-2',
      resolvedProvider: 'anthropic',
    });

    const input = mockCreateGateway.mock.calls[0][0] as Record<string, unknown>;
    expect(input.turnId).toBeUndefined();
    expect(input.messageSenderAccountId).toBeUndefined();
  });
});
