// Every engine reports the PROVIDER's failure, not just its own prose.
//
// The certification suite arms a HAPPY transport, so its
// `error_terminal_carries_provider_failure` check has nothing to inspect at
// level 1 — it passes vacuously and bites only against a real provider. That
// makes it a check nobody can rely on before a deploy, which is the same
// weakness the whole workstream is about.
//
// This arms a FAILING transport instead. Each vendor SDK is mocked to throw the
// error shape it actually throws — Anthropic's one-level `error.type`, OpenAI's
// two-level nesting, an errno-shaped transport failure — and the adapter is
// driven for real. The assertion is the one that matters downstream: the
// terminal completion carries `failure.kind`, so `classifyFailure` reads a fact
// instead of inferring one from a sentence, and `provider_request_id` is there
// when a vendor asks for it.

const anthropicThrow = Object.assign(new Error('Overloaded'), {
  status: 529,
  error: { type: 'overloaded_error', message: 'Overloaded' },
  requestID: 'req_anthropic_err',
});
const openaiThrow = Object.assign(new Error('You exceeded your current quota'), {
  status: 429,
  error: { error: { type: 'insufficient_quota', code: 'insufficient_quota' } },
  request_id: 'req_openai_err',
});
const geminiThrow = Object.assign(new Error('permission denied'), {
  status: 403,
  error: { type: 'permission_error' },
});
const transportThrow = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });

/** An async iterable whose FIRST pull rejects.
 *
 *  Closer to a throwing SDK than a generator that throws before its first
 *  yield: a real client fails when the caller asks for the next event, which is
 *  the moment the adapter's `for await` is suspended on. */
function rejectingStream(err: unknown): AsyncIterable<never> {
  return {
    [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(err) }),
  } as AsyncIterable<never>;
}

jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: jest.fn(() => Object.assign(
    rejectingStream(anthropicThrow),
    { interrupt: jest.fn(async () => undefined) },
  )),
  AbortError: class AbortError extends Error {
    constructor() { super('aborted'); this.name = 'AbortError'; }
  },
}));
jest.mock('@openai/agents', () => ({
  run: jest.fn(() => { throw openaiThrow; }),
  Agent: class MockAgent { constructor(public opts: unknown) {} },
  tool: (def: unknown) => def,
  webSearchTool: jest.fn(() => ({ type: 'hosted', name: 'web_search' })),
}));
jest.mock('@google/genai', () => ({
  GoogleGenAI: jest.fn().mockImplementation(() => ({
    models: { generateContentStream: async () => { throw geminiThrow; } },
  })),
  FinishReason: { STOP: 'STOP', MAX_TOKENS: 'MAX_TOKENS', FINISH_REASON_UNSPECIFIED: 'FINISH_REASON_UNSPECIFIED' },
  Type: { STRING: 'STRING', OBJECT: 'OBJECT', ARRAY: 'ARRAY' },
}));
jest.mock('@google/adk', () => {
  class LlmAgent { constructor(public cfg: unknown) {} }
  class Runner {
    constructor(public cfg: unknown) {}
    runAsync() {
      return { [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(geminiThrow) }) };
    }
  }
  class FunctionTool { constructor(public opts: unknown) {} }
  class InMemorySessionService {
    getSession = jest.fn(async () => undefined);
    createSession = jest.fn(async () => ({ id: 's1' }));
  }
  class TokenBasedContextCompactor { constructor(public o: unknown) {} }
  class LlmSummarizer { constructor(public o: unknown) {} }
  class Gemini { constructor(public o: unknown) {} }
  return {
    LlmAgent, Runner, FunctionTool, InMemorySessionService,
    TokenBasedContextCompactor, LlmSummarizer, Gemini,
    getFunctionCalls: () => [], getFunctionResponses: () => [], isFinalResponse: () => false,
  };
});
jest.mock('../opencode/server', () => ({
  startOpencode: jest.fn(async () => { throw transportThrow; }),
}));
jest.mock('../esm-import', () => ({
  esmImport: async () => ({
    Codex: class Codex {
      constructor(public o: unknown) {}
      startThread() {
        return {
          id: 't1',
          runStreamed: async () => { throw transportThrow; },
        };
      }
      resumeThread() { return this.startThread(); }
    },
  }),
}));
jest.mock('../tool-gateway-http-mcp', () => ({
  exposeCatalogOverHttp: jest.fn(async () => ({
    url: 'http://127.0.0.1:1/mcp', bearerToken: 'tok', close: jest.fn().mockResolvedValue(undefined),
  })),
}));
jest.mock('../mcp-client-pool', () => ({
  getMcpClientPool: () => ({ acquire: jest.fn(), releaseAll: jest.fn().mockResolvedValue(undefined) }),
}));
jest.mock('../mcp-bridge', () => ({ dispatchFunctionCall: jest.fn(), mcpToOpenAiFunctionTools: () => [] }));
jest.mock('../../../infrastructure/secrets', () => ({
  getOpenRouterApiKey: jest.fn().mockResolvedValue('test-openrouter-key'),
  getAnthropicApiKey: jest.fn().mockResolvedValue('test-anthropic-key'),
  getAnthropicApiKeyForGroup: jest.fn().mockResolvedValue('test-anthropic-key'),
}));
jest.mock('../../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { AnthropicAdapter } from '../anthropic';
import { OpenAiWireAdapter } from '../openai-wire';
import { openAiTarget } from '../openai';
import { openRouterTarget } from '../openrouter';
import { GeminiAdapter } from '../gemini';
import { CodexAdapter } from '../codex';
import { GeminiAdkAdapter } from '../gemini-adk';
import { OpencodeAdapter } from '../opencode';
import type { ExecutionEngineId, InvocationEvent, InvocationInput, VendorSdkAdapter } from '../types';

interface Case {
  engine: ExecutionEngineId;
  factory: () => VendorSdkAdapter;
  provider: InvocationInput['provider'];
  /** What the taxonomy must read off the thrown shape. */
  expectedKind: string;
  /** Present only where the SDK shape carries one. */
  expectedRequestId?: string;
}

const CASES: Case[] = [
  {
    engine: 'claude-agent-sdk', factory: () => new AnthropicAdapter(), provider: 'anthropic',
    expectedKind: 'overloaded', expectedRequestId: 'req_anthropic_err',
  },
  {
    engine: 'openai-agents', factory: () => new OpenAiWireAdapter({ target: openAiTarget }), provider: 'openai',
    expectedKind: 'quota', expectedRequestId: 'req_openai_err',
  },
  {
    engine: 'openrouter-openai-wire', factory: () => new OpenAiWireAdapter({ target: openRouterTarget }), provider: 'openrouter',
    expectedKind: 'quota', expectedRequestId: 'req_openai_err',
  },
  {
    engine: 'google-genai', factory: () => new GeminiAdapter(), provider: 'google',
    expectedKind: 'auth',
  },
  {
    engine: 'google-adk', factory: () => new GeminiAdkAdapter(), provider: 'google',
    expectedKind: 'auth',
  },
  {
    engine: 'openai-codex', factory: () => new CodexAdapter(), provider: 'openai',
    expectedKind: 'network',
  },
  {
    engine: 'opencode', factory: () => new OpencodeAdapter(), provider: 'openrouter',
    expectedKind: 'network',
  },
];

function probeInput(provider: InvocationInput['provider']): InvocationInput {
  return {
    messages: [{ role: 'user', content: [{ type: 'text', text: 'probe' }] }],
    systemPrompt: 'sys',
    model: 'test-model',
    provider,
    tenantId: 'tenant-1',
    invocationId: 'inv-1',
  };
}

async function drainToTerminal(
  stream: AsyncIterable<InvocationEvent>,
): Promise<Extract<InvocationEvent, { type: 'completion' }> | null> {
  try {
    for await (const e of stream) {
      if (e.type === 'completion') return e;
    }
  } catch {
    // An adapter that THROWS instead of yielding a terminal has not reported
    // anything, structured or otherwise — which the assertion below catches as
    // a null terminal rather than as a passing test.
  }
  return null;
}

describe.each(CASES)('$engine reports the provider failure structurally', (c) => {
  let terminal: Extract<InvocationEvent, { type: 'completion' }> | null;

  beforeAll(async () => {
    const adapter = c.factory();
    adapter.registerToolCatalog({ servers: [], tools: [] });
    adapter.registerHitlGate?.(async () => ({ allow: true }));
    adapter.registerAnomalyHandler?.(async () => ({ escalate: false }));
    terminal = await drainToTerminal(adapter.invoke(probeInput(c.provider), new AbortController().signal));
  });

  it('ends on an error terminal rather than throwing out of the stream', () => {
    expect(terminal).not.toBeNull();
    expect(terminal!.outcome).toBe('error');
  });

  // The whole point: the class persisted against the run is derived from a fact
  // the provider stated, not inferred from a sentence by ~90 lines of regex.
  it('carries a structured failure kind', () => {
    expect(terminal!.failure?.kind).toBe(c.expectedKind);
  });

  it('carries the provider\'s own error type verbatim', () => {
    expect(typeof terminal!.failure?.providerErrorType).toBe('string');
    expect(terminal!.failure!.providerErrorType!.length).toBeGreaterThan(0);
  });

  // The one field a vendor asks for on a support ticket, and the one that
  // appeared nowhere in src/agent-execution/ before this.
  if (c.expectedRequestId) {
    it('carries the provider request id', () => {
      expect(terminal!.failure?.requestId).toBe(c.expectedRequestId);
    });
  }
});

// The taxonomy is only worth having if the class it produces reaches the run's
// terminal, so the mapping is asserted end to end rather than in isolation.
describe('the structured failure decides the persisted class', () => {
  const { classifyFailure } = jest.requireActual('../../failure-classification') as {
    classifyFailure: (e: unknown, f?: { kind: string }) => string;
  };

  it.each([
    ['overloaded', 'provider_capacity'],
    ['quota', 'provider_quota'],
    ['auth', 'provider_auth'],
    ['network', 'provider_network'],
  ])('%s → %s', (kind, expected) => {
    // A message the regex path would classify differently, so the assertion is
    // about the structured input rather than about the prose.
    expect(classifyFailure(new Error('something happened'), { kind } as never)).toBe(expected);
  });
});
