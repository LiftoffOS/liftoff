// Gemini adapter (option C — @google/genai) tests: native web tools wiring,
// the hand-rolled tool-call loop, HITL pause, and event translation.

// mockGenerateContent queues a single response per turn (as before); the adapter
// now calls generateContentStream, so the mock wraps each queued response as a
// one-chunk async stream — the adapter's aggregation reconstructs text/parts/
// calls/usage/grounding from chunks, so existing per-turn expectations hold.
const mockGenerateContent = jest.fn();
jest.mock('@google/genai', () => ({
  GoogleGenAI: jest.fn().mockImplementation(() => ({
    models: {
      generateContentStream: async (...args: unknown[]) => {
        const resp = await mockGenerateContent(...args);
        const chunks = Array.isArray(resp) ? resp : [resp];   // array → multi-chunk stream
        return (async function* () { for (const c of chunks) yield c; })();
      },
    },
  })),
  FinishReason: { STOP: 'STOP', MAX_TOKENS: 'MAX_TOKENS', FINISH_REASON_UNSPECIFIED: 'FINISH_REASON_UNSPECIFIED', SAFETY: 'SAFETY', RECITATION: 'RECITATION' },
  FunctionCallingConfigMode: { ANY: 'ANY', AUTO: 'AUTO', NONE: 'NONE' },
}));
// createAdapter (../index) imports the sibling adapters, whose SDKs ship ESM
// that Jest can't parse — stub them so the factory import resolves.
jest.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: jest.fn(), AbortError: class AbortError extends Error {} }));
jest.mock('@openai/agents', () => ({ run: jest.fn(), Agent: class {}, tool: (d: unknown) => d, webSearchTool: jest.fn() }));

const mockDispatch = jest.fn();
jest.mock('../mcp-bridge', () => ({
  dispatchFunctionCall: (...args: unknown[]) => mockDispatch(...args),
}));
jest.mock('../mcp-client-pool', () => ({
  getMcpClientPool: () => ({ releaseAll: jest.fn().mockResolvedValue(undefined) }),
}));

import { GeminiAdapter } from '../gemini';
import { createAdapter } from '../index';
import type { McpToolCatalog } from '../catalog-types';
import type { InvocationInput, InvocationEvent } from '../types';

function makeCatalog(): McpToolCatalog {
  return {
    servers: [{ kind: 'in-process', id: 'srv', config: {} } as McpToolCatalog['servers'][number]],
    tools: [{ name: 'my_tool', description: 'd', inputSchema: { type: 'object' }, serverId: 'srv' }],
  };
}
function makeInput(): InvocationInput {
  return { messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }], systemPrompt: 's', model: 'gemini-3-pro-preview', provider: 'google', tenantId: 't1', invocationId: 'inv1', maxTurns: 5 };
}
async function drain(it: AsyncIterable<InvocationEvent>): Promise<InvocationEvent[]> {
  const out: InvocationEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

beforeEach(() => { jest.clearAllMocks(); });

describe('createAdapter', () => {
  it('returns a GeminiAdapter for provider "google" behind the genai escape hatch', () => {
    // The Gemini CLI is Google's default now; the Gen AI SDK loop this file
    // tests is the flagged alternative.
    const prev = process.env.GOOGLE_ENGINE;
    process.env.GOOGLE_ENGINE = 'genai';
    try {
      expect(createAdapter('google')).toBeInstanceOf(GeminiAdapter);
    } finally {
      if (prev === undefined) delete process.env.GOOGLE_ENGINE; else process.env.GOOGLE_ENGINE = prev;
    }
  });
});

describe('GeminiAdapter — native web tools', () => {
  it('passes googleSearch + urlContext + the catalog functionDeclarations to generateContent', async () => {
    mockGenerateContent.mockResolvedValue({ text: 'hi', functionCalls: [] });
    const adapter = new GeminiAdapter();
    adapter.registerToolCatalog(makeCatalog());
    await drain(adapter.invoke(makeInput(), new AbortController().signal));

    const tools = mockGenerateContent.mock.calls[0][0].config.tools as Array<Record<string, unknown>>;
    expect(tools).toEqual(expect.arrayContaining([{ googleSearch: {} }, { urlContext: {} }]));
    const fnTool = tools.find((t) => 'functionDeclarations' in t) as {
      functionDeclarations: Array<{ name: string; parametersJsonSchema?: unknown }>;
    };
    expect(fnTool.functionDeclarations.map((d) => d.name)).toEqual(['my_tool']);
    // MCP JSON Schema must go through parametersJsonSchema (raw JSON Schema),
    // NOT genai's `parameters` (OpenAPI Schema) — see the adapter comment.
    expect(fnTool.functionDeclarations[0].parametersJsonSchema).toEqual({ type: 'object' });
    expect('parameters' in fnTool.functionDeclarations[0]).toBe(false);
  });
});

describe('GeminiAdapter — grounding usage', () => {
  it('emits webSearchRequests = groundingMetadata.webSearchQueries.length', async () => {
    mockGenerateContent.mockResolvedValue({
      text: 'done', functionCalls: [],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      candidates: [{ content: { role: 'model', parts: [{ text: 'done' }] },
                     groundingMetadata: { webSearchQueries: ['a', 'b', 'c'] } }],
    });
    const adapter = new GeminiAdapter();
    adapter.registerToolCatalog(makeCatalog());
    const events = await drain(adapter.invoke(makeInput(), new AbortController().signal));
    const usage = events.find((e) => e.type === 'usage') as Extract<InvocationEvent, { type: 'usage' }>;
    expect(usage.usage.webSearchRequests).toBe(3);
  });
  it('omits webSearchRequests when the model did not search', async () => {
    mockGenerateContent.mockResolvedValue({
      text: 'done', functionCalls: [], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 },
      candidates: [{ content: { role: 'model', parts: [{ text: 'done' }] } }],
    });
    const adapter = new GeminiAdapter();
    adapter.registerToolCatalog(makeCatalog());
    const events = await drain(adapter.invoke(makeInput(), new AbortController().signal));
    const usage = events.find((e) => e.type === 'usage') as Extract<InvocationEvent, { type: 'usage' }>;
    expect(usage.usage.webSearchRequests).toBeUndefined();
  });

  // 1.4 — Google bills thoughtsTokenCount as output + toolUsePromptTokenCount as
  // input; toUsage must fold them in (was dropping both → undercount).
  it('folds thoughtsTokenCount into outputTokens and toolUsePromptTokenCount into inputTokens', async () => {
    mockGenerateContent.mockResolvedValue({
      text: 'done', functionCalls: [],
      usageMetadata: {
        promptTokenCount: 100, candidatesTokenCount: 40,
        thoughtsTokenCount: 25, toolUsePromptTokenCount: 10, cachedContentTokenCount: 8,
      },
      candidates: [{ content: { role: 'model', parts: [{ text: 'done' }] } }],
    });
    const adapter = new GeminiAdapter();
    adapter.registerToolCatalog(makeCatalog());
    const events = await drain(adapter.invoke(makeInput(), new AbortController().signal));
    const usage = events.find((e) => e.type === 'usage') as Extract<InvocationEvent, { type: 'usage' }>;
    expect(usage.usage.inputTokens).toBe(110);   // 100 + 10 toolUse
    expect(usage.usage.outputTokens).toBe(65);   // 40 + 25 thoughts
    expect(usage.usage.cachedTokens).toBe(8);
    // outputTokens strictly exceeds the bare candidate count (the undercount this fixes).
    expect(usage.usage.outputTokens!).toBeGreaterThan(
      (usage.usage.raw as { candidatesTokenCount: number }).candidatesTokenCount,
    );
  });
});

describe('GeminiAdapter — token streaming', () => {
  it('emits an assistant_delta per chunk and a terminal assistant_message of the concatenation', async () => {
    // Multi-chunk stream: three text deltas + final chunk carries usage/finish.
    mockGenerateContent.mockResolvedValueOnce([
      { text: 'Hel' },
      { text: 'lo, ' },
      { text: 'world', candidates: [{ content: { role: 'model', parts: [{ text: 'world' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 } },
    ]);
    const adapter = new GeminiAdapter();
    adapter.registerToolCatalog(makeCatalog());
    const events = await drain(adapter.invoke(makeInput(), new AbortController().signal));

    const deltas = events.filter((e) => e.type === 'assistant_delta') as Array<Extract<InvocationEvent, { type: 'assistant_delta' }>>;
    expect(deltas.map((d) => d.text)).toEqual(['Hel', 'lo, ', 'world']);
    const finalMsg = events.find((e) => e.type === 'assistant_message') as Extract<InvocationEvent, { type: 'assistant_message' }>;
    expect(finalMsg.content).toEqual([{ type: 'text', text: 'Hello, world' }]);
    expect((events.at(-1) as { type: string; outcome: string }).type).toBe('completion');
    expect((events.at(-1) as { outcome: string }).outcome).toBe('success');
  });
});

describe('GeminiAdapter — tool-call loop', () => {
  it('dispatches a function call through the bridge, feeds the result back, and completes', async () => {
    mockGenerateContent
      .mockResolvedValueOnce({
        text: 'planning',
        functionCalls: [{ id: 'c1', name: 'my_tool', args: { x: 1 } }],
        // Gemini 3 attaches a thoughtSignature to the functionCall part.
        candidates: [{ content: { role: 'model', parts: [{ functionCall: { id: 'c1', name: 'my_tool', args: { x: 1 } }, thoughtSignature: 'sig-1' }] } }],
      })
      .mockResolvedValueOnce({ text: 'done', functionCalls: [] });
    mockDispatch.mockResolvedValue({ ok: true });

    const adapter = new GeminiAdapter();
    adapter.registerToolCatalog(makeCatalog());
    adapter.registerHitlGate(async () => ({ allow: true }));
    const events = await drain(adapter.invoke(makeInput(), new AbortController().signal));

    const types = events.map((e) => e.type);
    // Streaming: each text turn emits assistant_delta(s) before the terminal
    // assistant_message (one delta here since the mock yields one chunk/turn).
    expect(types).toEqual([
      'assistant_delta', 'assistant_message', 'tool_call_started', 'tool_call_finished',
      'assistant_delta', 'assistant_message', 'completion',
    ]);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(mockDispatch.mock.calls[0][1]).toBe('my_tool'); // (catalog, name, args, ctx)
    expect((events.at(-1) as { outcome: string }).outcome).toBe('success');
    // Second request must include: (1) the model turn replayed VERBATIM (raw
    // candidate content) so Gemini 3's thoughtSignature survives, and (2) the
    // tool result fed back as a user turn.
    const secondContents = mockGenerateContent.mock.calls[1][0].contents as Array<{ role: string; parts: unknown[] }>;
    expect(secondContents.some((c) => c.role === 'model' && JSON.stringify(c.parts).includes('sig-1'))).toBe(true);
    expect(secondContents.some((c) => c.role === 'user' && JSON.stringify(c.parts).includes('functionResponse'))).toBe(true);
  });
});

describe('GeminiAdapter — native forcing is round 0 only', () => {
  it('restricts the first request to the grounding tool and lets every later round answer', async () => {
    // `mode: ANY` on every iteration forces a call on every iteration: the
    // model cannot answer, only search again. A dev turn made eleven identical
    // searches until the vendor returned 429.
    mockGenerateContent
      .mockResolvedValueOnce({
        text: '',
        functionCalls: [{ id: 'c1', name: 'my_tool', args: { query: 'refunds' } }],
        candidates: [{ content: { role: 'model', parts: [{ functionCall: { id: 'c1', name: 'my_tool', args: { query: 'refunds' } } }] } }],
      })
      .mockResolvedValueOnce({ text: 'Refunds within 30 days.', functionCalls: [] });
    mockDispatch.mockResolvedValue({ ok: true });

    const adapter = new GeminiAdapter();
    adapter.registerToolCatalog(makeCatalog());
    adapter.registerHitlGate(async () => ({ allow: true }));
    const events = await drain(adapter.invoke({ ...makeInput(), groundingToolName: 'my_tool' }, new AbortController().signal));
    expect((events.at(-1) as { outcome: string }).outcome).toBe('success');

    const configOf = (i: number) => mockGenerateContent.mock.calls[i][0].config as { toolConfig?: { functionCallingConfig?: { mode?: string; allowedFunctionNames?: string[] } } };
    expect(configOf(0).toolConfig?.functionCallingConfig?.allowedFunctionNames).toEqual(['my_tool']);
    expect(configOf(1).toolConfig).toBeUndefined();
  });
});

describe('GeminiAdapter — abnormal finish reason', () => {
  it('surfaces an anomaly + error completion (not success) when the model is blocked (SAFETY)', async () => {
    mockGenerateContent.mockResolvedValue({ text: undefined, functionCalls: [], candidates: [{ finishReason: 'SAFETY' }] });
    const adapter = new GeminiAdapter();
    adapter.registerToolCatalog(makeCatalog());
    const events = await drain(adapter.invoke(makeInput(), new AbortController().signal));

    expect(events.some((e) => e.type === 'anomaly_detected')).toBe(true);
    const completion = events.find((e) => e.type === 'completion') as { outcome: string; reason?: string };
    expect(completion.outcome).toBe('error');
    expect(completion.reason).toContain('SAFETY');
  });

  it('treats STOP / undefined finish reasons as a normal success', async () => {
    mockGenerateContent.mockResolvedValue({ text: 'ok', functionCalls: [], candidates: [{ finishReason: 'STOP' }] });
    const adapter = new GeminiAdapter();
    adapter.registerToolCatalog(makeCatalog());
    const events = await drain(adapter.invoke(makeInput(), new AbortController().signal));
    expect((events.at(-1) as { outcome: string }).outcome).toBe('success');
    expect(events.some((e) => e.type === 'anomaly_detected')).toBe(false);
  });

  it('reports MAX_TOKENS as limit_reached — a truncated answer is not a finished one', async () => {
    // This previously sat in NORMAL_FINISH_REASONS, so a reply cut off
    // mid-sentence was recorded as a clean success. It is not an anomaly
    // either: nothing malfunctioned, the model simply ran out of room.
    mockGenerateContent.mockResolvedValue({ text: 'ok', functionCalls: [], candidates: [{ finishReason: 'MAX_TOKENS' }] });
    const adapter = new GeminiAdapter();
    adapter.registerToolCatalog(makeCatalog());
    const events = await drain(adapter.invoke(makeInput(), new AbortController().signal));

    const completion = events.at(-1) as { outcome: string; reason?: string };
    expect(completion.outcome).toBe('limit_reached');
    expect(completion.reason).toContain('MAX_TOKENS');
    expect(events.some((e) => e.type === 'anomaly_detected')).toBe(false);
  });
});

describe('GeminiAdapter — seed tool history', () => {
  it('correlates a prior tool_result back to its tool name in the functionResponse', async () => {
    mockGenerateContent.mockResolvedValue({ text: 'done', functionCalls: [] });
    const adapter = new GeminiAdapter();
    adapter.registerToolCatalog(makeCatalog());
    const input: InvocationInput = {
      ...makeInput(),
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'go' }] },
        { role: 'assistant', content: [{ type: 'tool_use', toolName: 'my_tool', args: { x: 1 }, callId: 'c1' }] },
        { role: 'tool', content: [{ type: 'tool_result', callId: 'c1', result: { ok: true } }] },
      ],
    };
    await drain(adapter.invoke(input, new AbortController().signal));

    const contents = mockGenerateContent.mock.calls[0][0].contents as Array<{ role: string; parts: Array<Record<string, { name?: string }>> }>;
    const fnResp = contents.flatMap((c) => c.parts).find((p) => 'functionResponse' in p);
    expect(fnResp!.functionResponse.name).toBe('my_tool'); // correlated from the tool_use, not left undefined
  });
});

describe('GeminiAdapter — HITL pause', () => {
  it('emits pause_requested(hitl_gate) when the bridge signals an oversight hitlPause', async () => {
    mockGenerateContent.mockResolvedValue({ text: '', functionCalls: [{ id: 'c1', name: 'my_tool', args: {} }] });
    // Simulate the bridge setting pendingHitlGate (4th arg is the BridgeContext).
    mockDispatch.mockImplementation((_catalog: unknown, _name: unknown, _args: unknown, ctx: { pendingHitlGate: unknown }) => {
      ctx.pendingHitlGate = { gateReason: 'review', pendingToolCalls: [] };
      return { error: 'paused_for_human_approval' };
    });

    const adapter = new GeminiAdapter();
    adapter.registerToolCatalog(makeCatalog());
    adapter.registerHitlGate(async () => ({ allow: false, hitlPause: { gateReason: 'review', pendingToolCalls: [] } }));
    const events = await drain(adapter.invoke(makeInput(), new AbortController().signal));

    const pause = events.find((e) => e.type === 'pause_requested') as { reason: string; gateContext?: { gateReason: string } } | undefined;
    expect(pause).toBeDefined();
    expect(pause!.reason).toBe('hitl_gate');
    expect(pause!.gateContext?.gateReason).toBe('review');
    expect(events.some((e) => e.type === 'completion')).toBe(false); // paused, not completed
  });
});

describe('GeminiAdapter — vendor MCP exposure', () => {
  // Post-enumeration catalog: a remote vendor server + its enumerated namespaced
  // tool live in catalog.tools alongside an in-process tool. Pre-P2 the Gemini
  // adapter read only catalog.tools (never catalog.servers), so vendor MCP was
  // invisible; now the enumerated entries flow in for free.
  function makeVendorCatalog(): McpToolCatalog {
    return {
      servers: [
        { kind: 'remote', id: 'github-x', url: 'https://api.githubcopilot.com/mcp/', transport: 'streamable-http', headers: {} } as McpToolCatalog['servers'][number],
        { kind: 'in-process', id: 'srv', config: {} } as McpToolCatalog['servers'][number],
      ],
      tools: [
        { name: 'github-x__merge_pull_request', description: 'Merge a PR', inputSchema: { type: 'object' }, serverId: 'github-x', remoteToolName: 'merge_pull_request' },
        { name: 'my_tool', description: 'd', inputSchema: { type: 'object' }, serverId: 'srv' },
      ],
    };
  }

  it('exposes enumerated vendor MCP tools as functionDeclarations and dispatches them through the bridge', async () => {
    mockGenerateContent
      .mockResolvedValueOnce({ text: '', functionCalls: [{ id: 'c1', name: 'github-x__merge_pull_request', args: { number: 7 } }] })
      .mockResolvedValueOnce({ text: 'done', functionCalls: [] });
    mockDispatch.mockResolvedValue({ ok: true });

    const adapter = new GeminiAdapter();
    adapter.registerToolCatalog(makeVendorCatalog());
    adapter.registerHitlGate(async () => ({ allow: true }));
    await drain(adapter.invoke(makeInput(), new AbortController().signal));

    // The vendor tool now appears in functionDeclarations.
    const tools = mockGenerateContent.mock.calls[0][0].config.tools as Array<Record<string, unknown>>;
    const fnTool = tools.find((t) => 'functionDeclarations' in t) as { functionDeclarations: Array<{ name: string }> };
    expect(fnTool.functionDeclarations.map((d) => d.name)).toEqual(
      expect.arrayContaining(['github-x__merge_pull_request', 'my_tool']),
    );
    // Dispatched through the bridge by its namespaced catalog name (the real
    // bridge maps to the bare remoteToolName on the wire — see mcp-bridge.test.ts).
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(mockDispatch.mock.calls[0][1]).toBe('github-x__merge_pull_request');
  });
});

describe('GeminiAdapter — remember before the model acts', () => {
  it('forwards the observer to the bridge and marks a call the bridge confirmed remembered', async () => {
    mockGenerateContent
      .mockResolvedValueOnce({ text: '', functionCalls: [{ id: 'c1', name: 'my_tool', args: { x: 1 } }] })
      .mockResolvedValueOnce({ text: 'done', functionCalls: [] });
    // The real bridge marks `context.recordedCalls` after the observer it was
    // handed answers true; the mock does the same, which is what the adapter
    // must then reflect on its event.
    const observer = jest.fn(async () => true);
    mockDispatch.mockImplementation(async (_cat: unknown, _name: unknown, _args: unknown, ctx: { toolResultObserver?: unknown; recordedCalls?: Set<string> }, call?: { callId?: string }) => {
      expect(ctx.toolResultObserver).toBe(observer);
      if (call?.callId) ctx.recordedCalls?.add(call.callId);
      return { ok: true };
    });
    const adapter = new GeminiAdapter();
    adapter.registerToolCatalog(makeCatalog());
    adapter.registerHitlGate(async () => ({ allow: true }));
    adapter.registerToolResultObserver(observer);
    const events = await drain(adapter.invoke(makeInput(), new AbortController().signal));
    const finished = events.find((e) => e.type === 'tool_call_finished') as { callId: string; recordedAtDispatch?: boolean };
    expect(finished.callId).toBe('c1');
    expect(finished.recordedAtDispatch).toBe(true);
  });
});

describe('GeminiAdapter — the run\'s turn budget bounds the loop', () => {
  // A model that calls a tool on every turn, forever. The loop must stop at
  // the run's own `maxTurns`, not at the adapter's fifty, and say that the
  // budget was spent rather than that something went wrong.
  const endlessToolTurn = (n: number) => ({
    text: `round ${n}`,
    functionCalls: [{ id: `c${n}`, name: 'my_tool', args: { n } }],
    candidates: [{ content: { role: 'model', parts: [{ functionCall: { id: `c${n}`, name: 'my_tool', args: { n } } }] } }],
  });

  it('stops at input.maxTurns (5) with limit_reached, not at 50', async () => {
    let n = 0;
    mockGenerateContent.mockImplementation(async () => endlessToolTurn(++n));
    mockDispatch.mockResolvedValue({ ok: true });

    const adapter = new GeminiAdapter();
    adapter.registerToolCatalog(makeCatalog());
    adapter.registerHitlGate(async () => ({ allow: true }));
    const events = await drain(adapter.invoke(makeInput(), new AbortController().signal));

    expect(mockGenerateContent).toHaveBeenCalledTimes(5);
    expect(mockDispatch).toHaveBeenCalledTimes(5);
    const last = events[events.length - 1] as { type: string; outcome?: string; reason?: string };
    expect(last.type).toBe('completion');
    expect(last.outcome).toBe('limit_reached');
    expect(last.reason).toContain('5');
  });

  it('falls back to the adapter\'s own safety stop when the run carries no budget', async () => {
    let n = 0;
    mockGenerateContent.mockImplementation(async () => endlessToolTurn(++n));
    mockDispatch.mockResolvedValue({ ok: true });

    const adapter = new GeminiAdapter();
    adapter.registerToolCatalog(makeCatalog());
    adapter.registerHitlGate(async () => ({ allow: true }));
    const { maxTurns: _dropped, ...noBudget } = makeInput();
    const events = await drain(adapter.invoke(noBudget, new AbortController().signal));

    expect(mockGenerateContent).toHaveBeenCalledTimes(50);
    expect((events[events.length - 1] as { outcome?: string }).outcome).toBe('limit_reached');
  });
});
