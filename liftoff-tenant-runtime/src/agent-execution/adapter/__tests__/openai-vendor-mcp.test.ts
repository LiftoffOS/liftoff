// OpenAI adapter — vendor-hosted MCP servers are NOT registered natively. They
// are enumerated into catalog.tools upstream and dispatched through the bridge,
// so the Agent is constructed with `mcpServers: []`. This is what moves vendor
// MCP onto the tool-error recovery + per-tool HITL path instead of the
// SDK-native MCP path.

jest.mock('@openai/agents', () => ({
  run: jest.fn(),
  Agent: jest.fn().mockImplementation(function (this: Record<string, unknown>, opts: unknown) { this.opts = opts; }),
  tool: (def: unknown) => def,
  webSearchTool: jest.fn(() => ({ type: 'hosted', name: 'web_search' })),
}));
jest.mock('../openai/provider', () => ({
  getSdkOpenAIProvider: jest.fn().mockResolvedValue(null),
}));

import { run, Agent } from '@openai/agents';
import { OpenAiWireAdapter } from '../openai-wire';
import { openAiTarget } from '../openai';
import type { McpToolCatalog, RemoteMcpServerConfig, InProcessMcpServerConfig } from '../catalog-types';
import type { InvocationInput, InvocationEvent } from '../types';

function makeInput(): InvocationInput {
  return { messages: [], systemPrompt: 's', model: 'gpt-5.4', provider: 'openai', tenantId: 't1', invocationId: 'inv1', maxTurns: 5 };
}
async function drain(it: AsyncIterable<InvocationEvent>): Promise<InvocationEvent[]> {
  const out: InvocationEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

// Post-enumeration catalog: a remote vendor server in catalog.servers AND its
// (now enumerated) namespaced tool in catalog.tools, plus an in-process tool.
function makeCatalog(): McpToolCatalog {
  const remote: RemoteMcpServerConfig = {
    kind: 'remote', id: 'github-x', url: 'https://api.githubcopilot.com/mcp/',
    transport: 'streamable-http', headers: { Authorization: 'Bearer gh_x' },
  };
  const inProcess: InProcessMcpServerConfig = {
    kind: 'in-process', id: 'liftoff-tool-gateway',
    config: { name: 'liftoff-tool-gateway', instance: { connect: jest.fn() } as never } as never,
  };
  return {
    servers: [remote, inProcess],
    tools: [
      { name: 'github-x__merge_pull_request', description: 'Merge a PR', inputSchema: { type: 'object' }, serverId: 'github-x', remoteToolName: 'merge_pull_request' },
      { name: 'slack__send_message', description: 'Send', inputSchema: { type: 'object' }, serverId: 'liftoff-tool-gateway' },
    ],
  };
}

beforeEach(() => jest.clearAllMocks());

it('constructs the Agent with mcpServers: [] (vendor MCP no longer registered natively)', async () => {
  (run as jest.Mock).mockResolvedValue({
    async *[Symbol.asyncIterator]() { /* no streamed events */ },
    completed: Promise.resolve(),
    newItems: [],
    history: [],
    interruptions: [],
  });

  const adapter = new OpenAiWireAdapter({ target: openAiTarget });
  adapter.registerToolCatalog(makeCatalog());
  const events = await drain(adapter.invoke(makeInput(), new AbortController().signal));

  expect(events.at(-1)).toMatchObject({ type: 'completion', outcome: 'success' });
  const opts = (Agent as jest.Mock).mock.calls.at(-1)?.[0] as { mcpServers: unknown[]; tools: unknown[] };
  expect(opts.mcpServers).toEqual([]);
  // The vendor tool is exposed as a bridge function tool instead (in `tools`).
  expect(opts.tools.length).toBeGreaterThanOrEqual(2);
});
