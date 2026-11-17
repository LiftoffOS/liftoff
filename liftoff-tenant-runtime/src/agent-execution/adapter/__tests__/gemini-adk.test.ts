// GeminiAdkAdapter unit tests. @google/adk is mocked so no live model runs; the
// Runner yields synthetic ADK Events and we assert the InvocationEvent mapping,
// tool routing through the bridge, HITL pause, and completion.

const mockRunAsync = jest.fn();
const mockDispatch = jest.fn();

jest.mock('@google/adk', () => {
  class LlmAgent { constructor(public cfg: unknown) {} }
  class Runner {
    constructor(public cfg: { agent: { cfg: { tools: Array<{ opts: { execute: (a: unknown) => unknown } }> } } }) {}
    runAsync(params?: unknown) { return mockRunAsync(this.cfg, params); }
  }
  class FunctionTool { constructor(public opts: { name: string; execute: (a: unknown) => unknown }) {} }
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
    getFunctionCalls: (e: { _calls?: unknown[] }) => e._calls ?? [],
    getFunctionResponses: (e: { _resps?: unknown[] }) => e._resps ?? [],
    isFinalResponse: () => false,
  };
});
jest.mock('../mcp-bridge', () => ({ dispatchFunctionCall: (...a: unknown[]) => mockDispatch(...a) }));
jest.mock('../mcp-client-pool', () => ({ getMcpClientPool: () => ({ releaseAll: jest.fn().mockResolvedValue(undefined) }) }));

import { GeminiAdkAdapter } from '../gemini-adk';
import type { McpToolCatalog } from '../catalog-types';
import type { InvocationInput, InvocationEvent } from '../types';
import { makeRecorder, releaseBuffer } from '../../../trajectories/recorder';

function makeCatalog(): McpToolCatalog {
  return {
    servers: [{ kind: 'in-process', id: 'srv', config: {} } as McpToolCatalog['servers'][number]],
    tools: [{ name: 'my_tool', description: 'd', inputSchema: { type: 'object' }, serverId: 'srv' }],
  };
}
function makeInput(): InvocationInput {
  return {
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    systemPrompt: 'sys', model: 'gemini-3-pro', provider: 'google',
    tenantId: 't1', invocationId: 'inv1',
  };
}
async function drain(it: AsyncIterable<InvocationEvent>): Promise<InvocationEvent[]> {
  const out: InvocationEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}
function events(...evs: unknown[]) { return (async function* () { for (const e of evs) yield e; })(); }

beforeEach(() => { mockRunAsync.mockReset(); mockDispatch.mockReset(); });

describe('GeminiAdkAdapter', () => {
  it('forwards the run\'s turn budget as the ADK\'s own llm-call ceiling, and reads that ceiling as the budget spent', async () => {
    // `RunConfig.maxLlmCalls` is "a limit on the total number of llm calls
    // for a given run", enforced on every model call; the tenant's budget
    // reaches this engine through it.
    mockRunAsync.mockReturnValueOnce(events(
      { content: { parts: [{ text: 'hello' }] }, usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 } },
    ));
    const a = new GeminiAdkAdapter();
    a.registerToolCatalog(makeCatalog());
    await drain(a.invoke({ ...makeInput(), maxTurns: 100 }, new AbortController().signal));
    expect(mockRunAsync.mock.calls[0][1]).toEqual(expect.objectContaining({ runConfig: { maxLlmCalls: 100 } }));

    // No budget on the run leaves the ADK its own default.
    mockRunAsync.mockReturnValueOnce(events(
      { content: { parts: [{ text: 'hello' }] }, usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 } },
    ));
    const b = new GeminiAdkAdapter();
    b.registerToolCatalog(makeCatalog());
    await drain(b.invoke(makeInput(), new AbortController().signal));
    expect('runConfig' in (mockRunAsync.mock.calls[1][1] as object)).toBe(false);

    // The ADK throws past the loop when the ceiling is exceeded: a run cut
    // off while working, not a fault.
    mockRunAsync.mockImplementationOnce(async function* () {
      yield { content: { parts: [{ text: 'partial' }] } };
      throw new Error('Max number of llm calls limit of 100 exceeded');
    });
    const c = new GeminiAdkAdapter();
    c.registerToolCatalog(makeCatalog());
    const out = await drain(c.invoke({ ...makeInput(), maxTurns: 100 }, new AbortController().signal));
    expect((out[out.length - 1] as { outcome: string }).outcome).toBe('limit_reached');
  });

  it('maps ADK events to InvocationEvents and completes', async () => {
    mockRunAsync.mockReturnValueOnce(events(
      { content: { parts: [{ text: 'hello' }] }, usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 } },
    ));
    const a = new GeminiAdkAdapter();
    a.registerToolCatalog(makeCatalog());
    const out = await drain(a.invoke(makeInput(), new AbortController().signal));
    const types = out.map((e) => e.type);
    expect(types[0]).toBe('session_started');
    expect(types).toContain('assistant_message');
    expect(types).toContain('usage');
    expect(types[types.length - 1]).toBe('completion');
    expect((out[out.length - 1] as { outcome: string }).outcome).toBe('success');
  });

  it('bills thinking as output and the function-calling prompt as input, the way Google charges them', async () => {
    // Google puts neither count inside the one beside it — the SDK states the
    // arithmetic on `totalTokenCount`: prompt + candidates + toolUsePrompt +
    // thoughts. Reading only `promptTokenCount` and `candidatesTokenCount`
    // under-attributes every run with thinking or function-calling on, and the
    // platform absorbs the difference. The Gemini adapter has always folded both
    // in; this adapter did not.
    mockRunAsync.mockReturnValueOnce(events(
      {
        content: { parts: [{ text: 'hello' }] },
        usageMetadata: {
          promptTokenCount: 1200,
          candidatesTokenCount: 40,
          thoughtsTokenCount: 3500,
          toolUsePromptTokenCount: 800,
          cachedContentTokenCount: 256,
        },
      },
    ));
    const a = new GeminiAdkAdapter();
    a.registerToolCatalog(makeCatalog());
    const out = await drain(a.invoke(makeInput(), new AbortController().signal));
    const usage = out.find((e) => e.type === 'usage') as { usage: Record<string, unknown> };
    expect(usage.usage.outputTokens).toBe(3540);
    expect(usage.usage.inputTokens).toBe(2000);
    expect(usage.usage.cachedTokens).toBe(256);
    // The prompt total already carries the cached part, so the context is that
    // figure unchanged rather than the sum of the two.
    expect(usage.usage.contextTokens).toBe(2000);
  });

  it('surfaces an ADK error event (errorCode/errorMessage) as anomaly + completion error, not empty success', async () => {
    mockRunAsync.mockReturnValueOnce(events(
      { errorCode: 'UNKNOWN_ERROR', errorMessage: '{"error":"invalid_grant","error_subtype":"invalid_rapt"}' },
    ));
    const a = new GeminiAdkAdapter();
    a.registerToolCatalog(makeCatalog());
    const out = await drain(a.invoke(makeInput(), new AbortController().signal));
    const anomaly = out.find((e) => e.type === 'anomaly_detected') as { kind: string } | undefined;
    expect(anomaly?.kind).toBe('auth_failed');
    const last = out[out.length - 1] as { type: string; outcome: string; reason?: string };
    expect(last.type).toBe('completion');
    expect(last.outcome).toBe('error');
    expect(last.reason).toContain('invalid_rapt');
  });

  it('sink enabled: recording adk_event events never turns the turn into an error', async () => {
    mockRunAsync.mockReturnValueOnce(events(
      { content: { parts: [{ text: 'hello' }] }, usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 } },
    ));
    const a = new GeminiAdkAdapter();
    a.registerToolCatalog(makeCatalog());
    const input = makeInput();
    a.registerTrajectoryRecorder(makeRecorder(input.invocationId));
    const out = await drain(a.invoke(input, new AbortController().signal));
    const last = out[out.length - 1];
    expect(last.type).toBe('completion');
    expect((last as { outcome: string }).outcome).toBe('success');
    releaseBuffer(input.invocationId);
  });

  it('emits tool_call events for ADK function calls/responses', async () => {
    mockRunAsync.mockReturnValueOnce(events(
      { content: { parts: [] }, _calls: [{ name: 'my_tool', args: { x: 1 }, id: 'c1' }] },
      { content: { parts: [] }, _resps: [{ name: 'my_tool', id: 'c1', response: { ok: true } }] },
    ));
    const a = new GeminiAdkAdapter();
    a.registerToolCatalog(makeCatalog());
    const out = await drain(a.invoke(makeInput(), new AbortController().signal));
    expect(out.find((e) => e.type === 'tool_call_started')).toBeTruthy();
    expect(out.find((e) => e.type === 'tool_call_finished')).toBeTruthy();
  });

  it('pauses (pause_requested/hitl_gate) when a tool execute trips the HITL gate', async () => {
    const a = new GeminiAdkAdapter();
    a.registerToolCatalog(makeCatalog());
    // dispatchFunctionCall (mocked) sets pendingHitlGate on the shared bridge ctx (4th arg).
    mockDispatch.mockImplementation(async (_cat: unknown, _name: unknown, _args: unknown, ctx: { pendingHitlGate: unknown }) => {
      ctx.pendingHitlGate = { gateReason: 'needs approval', pendingToolCalls: [] };
      return { content: [{ type: 'text', text: 'gated' }], isError: true };
    });
    // Runner invokes the agent's first tool execute (→ dispatch → gate set), then yields an event.
    mockRunAsync.mockImplementation(async function* (cfg: { agent: { cfg: { tools: Array<{ opts: { execute: (a: unknown) => unknown } }> } } }) {
      await cfg.agent.cfg.tools[0].opts.execute({});
      yield { content: { parts: [{ text: 'partial' }] } } as never;
    });
    const out = await drain(a.invoke(makeInput(), new AbortController().signal));
    const last = out[out.length - 1];
    expect(last.type).toBe('pause_requested');
    expect((last as { reason: string }).reason).toBe('hitl_gate');
    expect((last as { gateContext?: { gateReason: string } }).gateContext?.gateReason).toBe('needs approval');
  });
});

describe('GeminiAdkAdapter — remember before the model acts', () => {
  it('forwards the observer to the bridge and marks a call the bridge confirmed remembered', async () => {
    const observer = jest.fn(async () => true);
    // The ADK runner executes the tool (→ dispatch, where the real bridge
    // marks the call after the observer answers true), then reports the
    // function call and its response as events.
    mockDispatch.mockImplementation(async (_cat: unknown, _name: unknown, _args: unknown, ctx: { toolResultObserver?: unknown; recordedCalls?: Set<string> }, call?: { callId?: string }) => {
      expect(ctx.toolResultObserver).toBe(observer);
      if (call?.callId) ctx.recordedCalls?.add(call.callId);
      return { ok: true };
    });
    mockRunAsync.mockImplementation(async function* (cfg: { agent: { cfg: { tools: Array<{ opts: { execute: (a: unknown, ctx?: unknown) => unknown } }> } } }) {
      await cfg.agent.cfg.tools[0].opts.execute({ x: 1 }, { functionCallId: 'c1' });
      yield { content: { parts: [] }, _calls: [{ name: 'my_tool', args: { x: 1 }, id: 'c1' }] } as never;
      yield { content: { parts: [] }, _resps: [{ name: 'my_tool', id: 'c1', response: { ok: true } }] } as never;
    });
    const a = new GeminiAdkAdapter();
    a.registerToolCatalog(makeCatalog());
    a.registerToolResultObserver(observer);
    const out = await drain(a.invoke(makeInput(), new AbortController().signal));
    const finished = out.find((e) => e.type === 'tool_call_finished') as { callId: string; recordedAtDispatch?: boolean };
    expect(finished.callId).toBe('c1');
    expect(finished.recordedAtDispatch).toBe(true);
  });
});
