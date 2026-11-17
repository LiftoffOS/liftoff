// PR-A audit fix #4/#8: native OpenAI web search wiring.
// Covers the pure model-gate helpers AND the call site (Agent.tools), so a
// regression that drops the hosted web_search tool can't pass CI silently.

const WEB_SEARCH_MARKER = { type: 'hosted', name: 'web_search' };

jest.mock('@openai/agents', () => ({
  run: jest.fn(),
  // Agent as a jest.fn so we can read the constructor opts (incl. tools).
  Agent: jest.fn().mockImplementation(function (this: Record<string, unknown>, opts: unknown) {
    this.opts = opts;
  }),
  tool: (def: unknown) => def,
  webSearchTool: jest.fn(() => WEB_SEARCH_MARKER),
}));

import { run, Agent } from '@openai/agents';
import { OpenAiWireAdapter } from '../openai-wire';
import { openAiTarget } from '../openai';
import { isOpenAiResponsesModel, nativeOpenAiWebTools } from '../openai';
import type { McpToolCatalog } from '../catalog-types';
import type { InvocationInput } from '../types';

function makeInput(model: string): InvocationInput {
  return { messages: [], systemPrompt: 's', model, provider: 'openai', tenantId: 't1', invocationId: 'inv1', maxTurns: 5 };
}
const emptyCatalog: McpToolCatalog = { servers: [], tools: [] };

async function capturedAgentTools(model: string): Promise<unknown[]> {
  (run as jest.Mock).mockRejectedValue(new Error('stop-after-construct'));
  const adapter = new OpenAiWireAdapter({ target: openAiTarget });
  adapter.registerToolCatalog(emptyCatalog);
  // Drain invoke — run() rejects, so invoke constructs the Agent then yields a
  // completion error and returns.
  for await (const _ of adapter.invoke(makeInput(model), new AbortController().signal)) { void _; }
  const lastCall = (Agent as jest.Mock).mock.calls.at(-1);
  return (lastCall?.[0] as { tools: unknown[] }).tools;
}

beforeEach(() => jest.clearAllMocks());

describe('isOpenAiResponsesModel', () => {
  it.each(['gpt-5', 'gpt-5.4', 'gpt-5-codex', 'gpt-4.1', 'gpt-4.1-mini'])('true for Responses family: %s', (m) => {
    expect(isOpenAiResponsesModel(m)).toBe(true);
  });
  it.each(['gpt-4o', 'gpt-4o-mini', 'o1', 'o3-mini', 'gpt-3.5-turbo', ''])('false for non-Responses: %s', (m) => {
    expect(isOpenAiResponsesModel(m)).toBe(false);
  });
});

describe('nativeOpenAiWebTools', () => {
  it('returns the hosted web_search tool on a Responses model', () => {
    expect(nativeOpenAiWebTools('gpt-5.4')).toEqual([WEB_SEARCH_MARKER]);
  });
  it('returns [] on a non-Responses model (platform web_fetch_advanced covers fetch)', () => {
    expect(nativeOpenAiWebTools('gpt-4o')).toEqual([]);
  });
});

describe('OpenAiWireAdapter — Agent.tools wiring (call site)', () => {
  it('includes the hosted web_search tool for a Responses model', async () => {
    expect(await capturedAgentTools('gpt-5.4')).toContainEqual(WEB_SEARCH_MARKER);
  });
  it('omits the hosted web_search tool for a non-Responses model', async () => {
    expect(await capturedAgentTools('gpt-4o')).not.toContainEqual(WEB_SEARCH_MARKER);
  });
});
