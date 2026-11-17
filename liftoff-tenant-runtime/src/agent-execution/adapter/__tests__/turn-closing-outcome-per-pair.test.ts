// A terminal-only round ends the turn — the OUTCOME, per engine×provider pair.
//
// `turn-closing-per-engine.test.ts` pins the shared decision and
// `cross-adapter-equivalence.test.ts` drives the Claude batch hook; neither
// asserts what a run pays. This does: after a round that called only the
// tools the graph ends at, with the turn already spoken, the engine makes NO
// further model call, and after a round still doing other work it does. Each
// engine's mechanism is different — `continue: false` on Claude's PostToolBatch,
// the function form of `toolUseBehavior` on the OpenAI wire, simply not taking
// the next iteration on the Gen AI loop we own, `skipSummarization` on the
// function response ADK reads as final — so the vendor SDK mocks here honour
// their own contract, and the count of model turns is what is asserted.
//
// The three external processes are the FLOOR: they own their loop and offer
// no per-round hook, so a terminal round there costs the one extra model call
// every engine used to pay. They are asserted AS floor — declared, not
// forgotten, and still ending with exactly one completion.

import { engineProviderPairs, type EngineProviderPair } from '../vendors';
import { _ENGINES_WITHOUT_TURN_CLOSING } from '../../terminal-tools';
import { RESOLVABLE_EXECUTION_ENGINE_IDS } from '../types';
import type { McpToolCatalog } from '../catalog-types';
import type { InvocationInput, InvocationEvent, VendorSdkAdapter, ExecutionEngineId } from '../types';

// ── The scripted round, shared by every SDK mock ─────────────────────────
const script: { round: string[] } = { round: [] };
/** How many times the mocked vendor asked the model for a turn. */
let modelTurns = 0;

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
  getMcpClientPool: () => ({
    acquire: jest.fn(async () => ({ callTool: jest.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] })) })),
    releaseAll: jest.fn().mockResolvedValue(undefined),
  }),
}));

// ── Claude Agent SDK: the batch hook decides whether the loop continues ─────
jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: jest.fn(({ options }: { options: { hooks: { PostToolBatch: Array<{ hooks: Array<(i: unknown) => Promise<{ continue?: boolean }>> }> } } }) => {
    const gen = (async function* () {
      // Turn 1: the model speaks, then calls the round's tools.
      modelTurns += 1;
      yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Posted the review.' } } };
      yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Posted the review.' }] } };
      const hook = options.hooks.PostToolBatch[0].hooks[0];
      // The SDK names an MCP tool `mcp__<server>__<tool>` in every hook input
      // (code.claude.com/docs/en/hooks, "Match MCP tools"), so the hook sees the
      // namespaced form and never the catalog name.
      const decision = await hook({ tool_calls: script.round.map((n, i) => ({ tool_name: `mcp__liftoff-tool-gateway__${n}`, tool_use_id: `c${i}` })) });
      if (decision?.continue === false) {
        yield { type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 } };
        return;
      }
      // Turn 2: the closing sentence the hook did not spare.
      modelTurns += 1;
      yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } };
      yield { type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 } };
    })();
    return Object.assign(gen, { interrupt: jest.fn(async () => undefined) });
  }),
  AbortError: class AbortError extends Error { constructor() { super('aborted'); this.name = 'AbortError'; } },
}));

// ── OpenAI Agents SDK: toolUseBehavior decides whether the LLM runs again ───
jest.mock('@openai/agents', () => ({
  run: jest.fn((agent: { opts: { toolUseBehavior: unknown } }) => ({
    async *[Symbol.asyncIterator]() {
      modelTurns += 1;
      yield { type: 'raw_model_stream_event', data: { type: 'output_text_delta', delta: 'Posted the review.' } };
      const behaviour = agent.opts.toolUseBehavior;
      const results = script.round.map((n) => ({ tool: { name: n }, output: 'ok' }));
      let final = false;
      if (typeof behaviour === 'function') {
        const d = await (behaviour as (c: unknown, r: unknown) => Promise<{ isFinalOutput: boolean }> | { isFinalOutput: boolean })({}, results);
        final = d.isFinalOutput === true;
      }
      if (!final) {
        modelTurns += 1;
        yield { type: 'raw_model_stream_event', data: { type: 'output_text_delta', delta: ' Done.' } };
      }
    },
    completed: Promise.resolve(),
    newItems: [{ type: 'message_output_item', rawItem: { content: [{ type: 'output_text', text: 'Posted the review.' }] } }],
    rawResponses: [{ usage: { inputTokens: 1, outputTokens: 1, inputTokensDetails: [{ cached_tokens: 0 }] } }],
    history: [],
    interruptions: [],
  })),
  Agent: class MockAgent { constructor(public opts: unknown) {} },
  tool: (def: unknown) => def,
  webSearchTool: jest.fn(() => ({ type: 'hosted', name: 'web_search' })),
  protocol: jest.requireActual('@openai/agents').protocol,
}));

// ── Gemini (Gen AI SDK): we own the loop; each call is a model turn ─────────
jest.mock('@google/genai', () => ({
  GoogleGenAI: jest.fn().mockImplementation(() => ({
    models: {
      generateContentStream: async () => (async function* () {
        modelTurns += 1;
        if (modelTurns === 1) {
          const calls = script.round.map((n, i) => ({ id: `c${i}`, name: n, args: {} }));
          yield {
            text: 'Posted the review.',
            candidates: [{ content: { role: 'model', parts: [{ text: 'Posted the review.' }, ...calls.map((fc) => ({ functionCall: fc }))] }, finishReason: 'STOP' }],
            functionCalls: calls,
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
          };
          return;
        }
        yield {
          text: 'Done.',
          candidates: [{ content: { role: 'model', parts: [{ text: 'Done.' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
        };
      })(),
    },
  })),
  FinishReason: { STOP: 'STOP', MAX_TOKENS: 'MAX_TOKENS', FINISH_REASON_UNSPECIFIED: 'FINISH_REASON_UNSPECIFIED' },
  Type: { STRING: 'STRING', NUMBER: 'NUMBER', INTEGER: 'INTEGER', BOOLEAN: 'BOOLEAN', OBJECT: 'OBJECT', ARRAY: 'ARRAY', TYPE_UNSPECIFIED: 'TYPE_UNSPECIFIED' },
  FunctionCallingConfigMode: { ANY: 'ANY', AUTO: 'AUTO' },
}));

// ── ADK: the Runner runs the tools and reads skipSummarization off the response
jest.mock('@google/adk', () => {
  class FunctionTool { constructor(public opts: { name: string; execute: (a: unknown, c: unknown) => Promise<unknown> }) {} }
  class LlmAgent { constructor(public cfg: { tools?: FunctionTool[] }) {} }
  class Runner {
    constructor(public cfg: { agent: LlmAgent }) {}
    runAsync() {
      const agent = this.cfg.agent;
      return (async function* () {
        modelTurns += 1;
        yield {
          content: { role: 'model', parts: [{ text: 'Posted the review.' }, ...script.round.map((n, i) => ({ functionCall: { id: `c${i}`, name: n, args: {} } }))] },
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
        };
        const actions: { skipSummarization?: boolean } = {};
        for (const [i, name] of script.round.entries()) {
          const tool = (agent.cfg.tools ?? []).find((t) => t.opts.name === name);
          if (tool) await tool.opts.execute({}, { functionCallId: `c${i}`, actions });
        }
        yield { content: { role: 'user', parts: script.round.map((n) => ({ functionResponse: { name: n, response: { ok: true } } })) }, actions };
        // isFinalResponse: a function-response event with skipSummarization ends the loop.
        if (actions.skipSummarization) return;
        modelTurns += 1;
        yield { content: { parts: [{ text: 'Done.' }] }, usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } };
      })();
    }
  }
  class InMemorySessionService { getSession = jest.fn(async () => undefined); createSession = jest.fn(async () => ({ id: 's1' })); }
  class TokenBasedContextCompactor { constructor(public o: unknown) {} }
  class LlmSummarizer { constructor(public o: unknown) {} }
  class Gemini { constructor(public o: unknown) {} }
  return {
    LlmAgent, Runner, FunctionTool, InMemorySessionService, TokenBasedContextCompactor, LlmSummarizer, Gemini,
    getFunctionCalls: (e: { content?: { parts?: Array<{ functionCall?: unknown }> } }) =>
      (e.content?.parts ?? []).map((p) => p.functionCall).filter(Boolean),
    getFunctionResponses: (e: { content?: { parts?: Array<{ functionResponse?: unknown }> } }) =>
      (e.content?.parts ?? []).map((p) => p.functionResponse).filter(Boolean),
    isFinalResponse: () => false,
  };
});

// ── The external processes: their loop, their end ───────────────────────────
jest.mock('../tool-gateway-http-mcp', () => ({
  exposeCatalogOverHttp: jest.fn(async () => ({ url: 'http://127.0.0.1:1/mcp', bearerToken: 'tok', close: jest.fn().mockResolvedValue(undefined) })),
}));
jest.mock('../opencode/server', () => ({
  startOpencode: jest.fn(async () => ({
    client: {
      session: {
        create: jest.fn(async () => ({ data: { id: 's1' } })),
        prompt: jest.fn(async () => { modelTurns += 2; return { data: { info: {}, parts: [] } }; }),
        abort: jest.fn(async () => ({})),
        status: jest.fn(async () => ({ data: { s1: { type: 'idle' } } })),
        messages: jest.fn(async () => ({ data: [] })),
      },
      event: {
        subscribe: jest.fn(async () => ({
          stream: (async function* () {
            yield { type: 'message.part.updated', properties: { part: { sessionID: 's1', type: 'text', text: 'Posted the review.' } } };
            yield { type: 'message.part.updated', properties: { part: { sessionID: 's1', type: 'step-finish', tokens: { input: 1, output: 1, cache: { read: 0 } } } } };
            yield { type: 'session.idle', properties: { sessionID: 's1' } };
          })(),
        })),
      },
      tool: { ids: jest.fn(async () => ({ data: [] })) },
      postSessionIdPermissionsPermissionId: jest.fn(async () => ({})),
    },
    server: { url: 'http://127.0.0.1:1', close: jest.fn() },
  })),
}));
jest.mock('../esm-import', () => ({
  esmImport: async () => ({
    Codex: class Codex {
      constructor(public o: unknown) {}
      startThread() {
        return {
          id: 't1',
          runStreamed: async () => ({
            events: (async function* () {
              yield { type: 'thread.started', thread_id: 't1' };
              modelTurns += 1;
              yield { type: 'item.completed', item: { id: 'a1', type: 'agent_message', text: 'Posted the review.' } };
              for (const [i, n] of script.round.entries()) {
                yield { type: 'item.completed', item: { id: `c${i}`, type: 'mcp_tool_call', server: 'liftoff', tool: n, arguments: {}, status: 'completed', result: { content: [], structured_content: null } } };
              }
              // The external loop always writes its closing turn.
              modelTurns += 1;
              yield { type: 'item.completed', item: { id: 'a2', type: 'agent_message', text: 'Done.' } };
              yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 } };
            })(),
          }),
        };
      }
      resumeThread() { return this.startThread(); }
    },
  }),
}));
jest.mock('child_process', () => {
  const actual = jest.requireActual('child_process');
  const { EventEmitter } = jest.requireActual('events');
  const { PassThrough } = jest.requireActual('stream');
  return {
    ...actual,
    spawn: () => {
      const proc = new EventEmitter();
      proc.stdout = new PassThrough();
      proc.stderr = new PassThrough();
      proc.stdin = { end: () => undefined, on: () => undefined };
      proc.exitCode = null;
      proc.killed = false;
      proc.kill = () => { proc.killed = true; proc.exitCode = 143; proc.stdout.end(); setImmediate(() => proc.emit('close', null, 'SIGTERM')); return true; };
      setImmediate(() => {
        modelTurns += 2;
        proc.stdout.write(`${JSON.stringify({ type: 'init', session_id: 'sess-1', model: 'gemini' })}\n`);
        proc.stdout.write(`${JSON.stringify({ type: 'message', role: 'assistant', content: 'Posted the review.', delta: true })}\n`);
        proc.stdout.write(`${JSON.stringify({ type: 'message', role: 'assistant', content: ' Done.', delta: true })}\n`);
        proc.stdout.write(`${JSON.stringify({ type: 'result', status: 'success', stats: { input_tokens: 1, output_tokens: 1, cached: 0, tool_calls: script.round.length } })}\n`);
        proc.exitCode = 0;
        proc.stdout.end();
        setImmediate(() => proc.emit('close', 0, null));
      });
      return proc;
    },
  };
});

import { constructAdapterForEngine } from '../index';

const TERMINAL = 'crm__post_review';
const MID_GRAPH = 'crm__read_next';

function catalog(): McpToolCatalog {
  return {
    servers: [{ kind: 'in-process', id: 'liftoff-tool-gateway', config: { type: 'sdk' } as never }],
    tools: [
      { name: TERMINAL, description: 'Post the review', inputSchema: { type: 'object', properties: {} }, serverId: 'liftoff-tool-gateway', effect: 'write' as never },
      { name: MID_GRAPH, description: 'Read the next item', inputSchema: { type: 'object', properties: {} }, serverId: 'liftoff-tool-gateway', effect: 'read' as never },
    ],
  };
}

const MODEL: Record<string, string> = {
  anthropic: 'claude-opus-4-8', openai: 'gpt-5-codex', google: 'gemini-3-pro-preview', xai: 'grok-4.6', glm: 'z-ai/glm-5.2',
};

function input(pair: EngineProviderPair): InvocationInput {
  return {
    messages: [{ role: 'user', content: [{ type: 'text', text: 'review it' }] }],
    systemPrompt: 'system', model: MODEL[pair.provider] ?? 'm', provider: pair.provider as InvocationInput['provider'],
    tenantId: 't1', invocationId: `inv-${pair.engine}-${pair.provider}`, maxTurns: 5,
    // The graph ends at the review post.
    terminalToolNames: [TERMINAL],
  };
}

async function drain(it: AsyncIterable<InvocationEvent>): Promise<InvocationEvent[]> {
  const out: InvocationEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

function build(engine: ExecutionEngineId): VendorSdkAdapter {
  const adapter = constructAdapterForEngine(engine);
  adapter.registerToolCatalog(catalog());
  adapter.registerHitlGate(async () => ({ allow: true }));
  adapter.registerAnomalyHandler(async () => ({ decision: 'continue' } as never));
  return adapter;
}

const PAIRS = engineProviderPairs();

beforeEach(() => { modelTurns = 0; });

it('the floor is declared, and every other resolvable engine has a mechanism', () => {
  for (const e of _ENGINES_WITHOUT_TURN_CLOSING) expect(RESOLVABLE_EXECUTION_ENGINE_IDS).toContain(e);
  expect(new Set(PAIRS.map((p) => p.engine)).size).toBe(RESOLVABLE_EXECUTION_ENGINE_IDS.length);
});

describe.each(PAIRS.map((p) => [`${p.engine} as ${p.provider}`, p] as const))('%s', (_label, pair) => {
  const floor = _ENGINES_WITHOUT_TURN_CLOSING.includes(pair.engine);

  if (floor) {
    it('is the floor: the external loop ends the turn on its own terms, once', async () => {
      script.round = [TERMINAL];
      const events = await drain(build(pair.engine).invoke(input(pair), new AbortController().signal));
      const completions = events.filter((e) => e.type === 'completion');
      expect(completions).toHaveLength(1);
      expect((completions[0] as { outcome: string }).outcome).toBe('success');
      // Two model turns: the work and the closing sentence. The floor pays it.
      expect(modelTurns).toBe(2);
    });
    return;
  }

  it('a terminal-only round ends the turn: one model turn, no closing call', async () => {
    script.round = [TERMINAL];
    const events = await drain(build(pair.engine).invoke(input(pair), new AbortController().signal));
    const last = events[events.length - 1] as { type: string; outcome?: string };
    expect(last.type).toBe('completion');
    expect(last.outcome).toBe('success');
    expect(modelTurns).toBe(1);
  });

  it('a round still doing other work does NOT end the turn', async () => {
    // The guard: a round that posted the review AND read the next item is
    // mid-plan; ending it there would truncate the run.
    script.round = [TERMINAL, MID_GRAPH];
    const events = await drain(build(pair.engine).invoke(input(pair), new AbortController().signal));
    const last = events[events.length - 1] as { type: string; outcome?: string };
    expect(last.type).toBe('completion');
    expect(last.outcome).toBe('success');
    expect(modelTurns).toBe(2);
  });

  it('an agent with no graph keeps every model turn', async () => {
    script.round = [TERMINAL];
    const events = await drain(build(pair.engine).invoke({ ...input(pair), terminalToolNames: undefined }, new AbortController().signal));
    expect((events[events.length - 1] as { type: string }).type).toBe('completion');
    expect(modelTurns).toBe(2);
  });
});
