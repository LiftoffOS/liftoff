// OpenAI MCP bridge end-to-end — verifies the full tool-dispatch path
// for the OpenAI adapter: catalog tool → bridge function tool →
// dispatchFunctionCall → mcp-client-pool → MCP client.callTool. This is
// the path that makes platform tools work on OpenAI agents, because the
// @openai/agents SDK has no in-process MCP support; tools come in as
// native function tools and round-trip through the bridge.
//
// The bridge has to handle both server kinds in the catalog:
//   - remote (custom_mcp_server) → HTTP transport
//   - in-process (tool-gateway) → InMemoryTransport linked pair
//
// MCP client pool is mocked so neither HTTP nor a real MCP server is
// needed. The assertions verify the dispatch contract end-to-end:
// catalog lookup, hitl gate enforcement, server resolution, callTool
// invocation, anomaly handler on error.

jest.mock('@modelcontextprotocol/sdk/client/index.js');
jest.mock('@modelcontextprotocol/sdk/client/streamableHttp.js');
jest.mock('@modelcontextprotocol/sdk/inMemory.js');

import { mcpToOpenAiFunctionTools, dispatchFunctionCall, type BridgeContext } from '../mcp-bridge';
import type { McpToolCatalog, RemoteMcpServerConfig, InProcessMcpServerConfig } from '../catalog-types';
import { getMcpClientPool } from '../mcp-client-pool';

function makeCatalogWith2Tools(): McpToolCatalog {
  const remote: RemoteMcpServerConfig = {
    kind: 'remote',
    id: 'custom-mcp-github',
    url: 'https://github.example/mcp',
    headers: {},
  };
  const inProcess: InProcessMcpServerConfig = {
    kind: 'in-process',
    id: 'liftoff-tool-gateway',
    config: { name: 'liftoff-tool-gateway', instance: { connect: jest.fn() } as never } as never,
  };
  return {
    servers: [remote, inProcess],
    tools: [
      {
        name: 'custom_mcp_server__github__create_issue',
        description: 'Open a GitHub issue',
        inputSchema: { type: 'object', properties: { title: { type: 'string' } } },
        serverId: 'custom-mcp-github',
      },
      {
        name: 'slack__send_message',
        description: 'Send Slack message',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
        serverId: 'liftoff-tool-gateway',
      },
    ],
  };
}

describe('OpenAI MCP bridge — end-to-end tool dispatch through the catalog', () => {
  let acquireMock: jest.Mock;
  let callToolMock: jest.Mock;

  beforeEach(() => {
    callToolMock = jest.fn();
    acquireMock = jest.fn().mockResolvedValue({ callTool: callToolMock, close: jest.fn() });
    // Override the singleton's acquire on every test.
    const pool = getMcpClientPool() as unknown as { acquire: jest.Mock; releaseAll: jest.Mock };
    pool.acquire = acquireMock;
    pool.releaseAll = jest.fn().mockResolvedValue(undefined);
  });

  it('produces an OpenAI function tool for every catalog tool', () => {
    const catalog = makeCatalogWith2Tools();
    const ctx: BridgeContext = {
      tenantId: 't1',
      invocationId: 'inv1',
      hitlGate: null,
      anomalyHandler: null,
    };
    const fns = mcpToOpenAiFunctionTools(catalog, ctx);
    expect(fns).toHaveLength(2);
    expect(fns.map((f) => f.name).sort()).toEqual([
      'custom_mcp_server__github__create_issue',
      'slack__send_message',
    ]);
  });

  it('dispatches a custom_mcp_server tool through the remote server', async () => {
    const catalog = makeCatalogWith2Tools();
    callToolMock.mockResolvedValue({ ok: true, issueNumber: 42 });
    const ctx: BridgeContext = {
      tenantId: 't1', invocationId: 'inv-remote', hitlGate: null, anomalyHandler: null,
    };
    const result = await dispatchFunctionCall(
      catalog,
      'custom_mcp_server__github__create_issue',
      { title: 'Test issue' },
      ctx,
    );
    expect(acquireMock).toHaveBeenCalledWith('inv-remote', expect.objectContaining({
      kind: 'remote', id: 'custom-mcp-github',
    }));
    expect(callToolMock.mock.calls[0][0]).toEqual({
      name: 'custom_mcp_server__github__create_issue',
      arguments: { title: 'Test issue' },
    });
    expect(result).toEqual({ ok: true, issueNumber: 42 });
  });

  it('dispatches a connector tool through the in-process tool gateway', async () => {
    const catalog = makeCatalogWith2Tools();
    callToolMock.mockResolvedValue({ ts: '1234.5678', ok: true });
    const ctx: BridgeContext = {
      tenantId: 't1', invocationId: 'inv-inproc', hitlGate: null, anomalyHandler: null,
    };
    const result = await dispatchFunctionCall(
      catalog,
      'slack__send_message',
      { text: 'hello' },
      ctx,
    );
    expect(acquireMock).toHaveBeenCalledWith('inv-inproc', expect.objectContaining({
      kind: 'in-process', id: 'liftoff-tool-gateway',
    }));
    expect(callToolMock.mock.calls[0][0]).toEqual({
      name: 'slack__send_message',
      arguments: { text: 'hello' },
    });
    expect(result).toEqual({ ts: '1234.5678', ok: true });
  });

  it('short-circuits with the deny reason when the HITL gate denies', async () => {
    const catalog = makeCatalogWith2Tools();
    const ctx: BridgeContext = {
      tenantId: 't1',
      invocationId: 'inv-hitl',
      hitlGate: async () => ({ allow: false, reason: 'awaiting human approval' }),
      anomalyHandler: null,
    };
    const result = await dispatchFunctionCall(
      catalog,
      'custom_mcp_server__github__create_issue',
      { title: 'risky' },
      ctx,
    );
    expect(result).toEqual({ error: 'HITL gate denied', reason: 'awaiting human approval' });
    expect(callToolMock).not.toHaveBeenCalled();
  });

  it('fires the anomaly handler and returns an error result when callTool throws', async () => {
    const catalog = makeCatalogWith2Tools();
    callToolMock.mockRejectedValue(new Error('upstream timeout'));
    const anomalies: Array<{ kind: string; toolName?: string }> = [];
    const ctx: BridgeContext = {
      tenantId: 't1',
      invocationId: 'inv-err',
      hitlGate: null,
      anomalyHandler: async (input) => {
        anomalies.push({ kind: input.kind, toolName: input.context.toolName });
        return { escalate: false };
      },
    };
    const result = await dispatchFunctionCall(
      catalog,
      'slack__send_message',
      { text: 'whatever' },
      ctx,
    );
    expect(result).toEqual({ error: 'upstream timeout' });
    expect(anomalies).toEqual([
      { kind: 'tool_call_error', toolName: 'slack__send_message' },
    ]);
  });

  it('throws a clear error when the function name is not in the catalog', async () => {
    const catalog = makeCatalogWith2Tools();
    const ctx: BridgeContext = {
      tenantId: 't1', invocationId: 'inv-missing', hitlGate: null, anomalyHandler: null,
    };
    await expect(
      dispatchFunctionCall(catalog, 'no_such_tool', {}, ctx),
    ).rejects.toThrow('Function no_such_tool not found in catalog');
  });
});
