// The run's turn budget reaches the wire engine.
//
// `input.maxTurns` is the tenant's maxToolCalls, role-clamped by the engine,
// computed for every run and — until this — read by the Anthropic adapter
// alone. The wire adapter handed `run()` no `maxTurns`, so the Agents SDK's
// own default of ten model turns applied to OpenAI, xAI and every OpenRouter
// family, and the tenant's setting was a no-op on all of them. This pins the
// option on the call the SDK receives.

jest.mock('../../../infrastructure/logging', () => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { logger, log: logger, logAudit: jest.fn() };
});
jest.mock('../../../infrastructure/database', () => ({
  getPoolForService: jest.fn(() => ({ query: jest.fn().mockResolvedValue({ rows: [] }) })),
  getPool: jest.fn(() => ({ query: jest.fn().mockResolvedValue({ rows: [] }) })),
  pool: { query: jest.fn().mockResolvedValue({ rows: [] }) },
}));
jest.mock('../../../infrastructure/secrets', () => ({
  getOpenRouterApiKey: jest.fn().mockResolvedValue('test-openrouter-key'),
  getXaiApiKey: jest.fn().mockResolvedValue('test-xai-key'),
}));
jest.mock('../mcp-client-pool', () => ({
  getMcpClientPool: () => ({ acquire: jest.fn(), releaseAll: jest.fn().mockResolvedValue(undefined) }),
}));

const mockRun = jest.fn(() => ({
  async *[Symbol.asyncIterator]() {
    yield { type: 'raw_model_stream_event', data: { type: 'response_started' } };
    yield { type: 'raw_model_stream_event', data: { type: 'output_text_delta', delta: 'done' } };
  },
  completed: Promise.resolve(),
  newItems: [{ type: 'message_output_item', rawItem: { content: [{ type: 'output_text', text: 'done' }] } }],
  rawResponses: [{ usage: { inputTokens: 1, outputTokens: 1, inputTokensDetails: [{ cached_tokens: 0 }] } }],
  history: [],
  interruptions: [],
}));

jest.mock('@openai/agents', () => ({
  run: (...args: unknown[]) => mockRun(...(args as [])),
  Agent: class MockAgent { constructor(public opts: unknown) {} },
  tool: (def: unknown) => def,
  webSearchTool: jest.fn(() => ({ type: 'hosted', name: 'web_search' })),
  protocol: jest.requireActual('@openai/agents').protocol,
}));

import { OpenAiWireAdapter } from '../openai-wire';
import { openAiTarget } from '../openai';
import { openRouterTarget } from '../openrouter';
import type { InvocationEvent, InvocationInput, McpToolCatalog } from '../types';

async function drain(it: AsyncIterable<InvocationEvent>): Promise<InvocationEvent[]> {
  const out: InvocationEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

function catalog(): McpToolCatalog {
  return {
    servers: [{ kind: 'in-process', id: 'liftoff-tool-gateway', config: { type: 'sdk', name: 'liftoff-tool-gateway', instance: {} as never } }],
    tools: [{ name: 'gmail__send_email', description: 'Send', inputSchema: { type: 'object', properties: {} }, serverId: 'liftoff-tool-gateway' }],
  };
}

function input(provider: InvocationInput['provider'], model: string, maxTurns: number | undefined): InvocationInput {
  return {
    messages: [{ role: 'user', content: [{ type: 'text', text: 'send it' }] }],
    systemPrompt: 'system', model, provider, tenantId: 't1', invocationId: `inv-${provider}`,
    ...(maxTurns !== undefined ? { maxTurns } : {}),
  };
}

beforeEach(() => mockRun.mockClear());

describe('the wire adapter forwards the run\'s turn budget', () => {
  it.each([
    ['openai', () => new OpenAiWireAdapter({ target: openAiTarget }), 'openai' as const, 'gpt-5-codex'],
    ['openrouter', () => new OpenAiWireAdapter({ target: openRouterTarget }), 'glm' as const, 'z-ai/glm-5.2'],
  ])('%s: run() receives maxTurns: 100', async (_name, build, provider, model) => {
    const adapter = build();
    adapter.registerToolCatalog(catalog());
    adapter.registerHitlGate(async () => ({ allow: true }));
    adapter.registerAnomalyHandler(async () => ({ decision: 'continue' } as never));
    await drain(adapter.invoke(input(provider, model, 100), new AbortController().signal));

    expect(mockRun).toHaveBeenCalledTimes(1);
    const options = (mockRun.mock.calls[0] as unknown[])[2] as { maxTurns?: number; stream?: boolean };
    expect(options.maxTurns).toBe(100);
    expect(options.stream).toBe(true);
  });

  it('a run with no budget leaves the SDK its own default', async () => {
    const adapter = new OpenAiWireAdapter({ target: openAiTarget });
    adapter.registerToolCatalog(catalog());
    adapter.registerHitlGate(async () => ({ allow: true }));
    adapter.registerAnomalyHandler(async () => ({ decision: 'continue' } as never));
    await drain(adapter.invoke(input('openai', 'gpt-5-codex', undefined), new AbortController().signal));

    const options = (mockRun.mock.calls[0] as unknown[])[2] as { maxTurns?: number };
    expect('maxTurns' in options).toBe(false);
  });
});
