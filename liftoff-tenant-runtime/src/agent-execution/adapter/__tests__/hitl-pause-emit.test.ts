// Adapter HITL pause emission — Anthropic + OpenAI.
//
// Verifies the load-bearing fix from
// registered hitlGate returns `{ allow: false, hitlPause: {...} }`, both
// adapters stash the gate context on their own state, end the SDK
// invocation cleanly (Anthropic: deny+interrupt on canUseTool; OpenAI:
// error-shaped tool result from the bridge), and emit
// `pause_requested(reason: 'hitl_gate', gateContext: {...})` post-loop
// rather than yielding `completion: error` (the pre-fix behaviour that
// silently bypassed HITL approval on autonomous adapter-driven loops).

jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  AbortError: class AbortError extends Error {},
  query: jest.fn(),
}));

jest.mock('@openai/agents', () => ({
  run: jest.fn(),
  Agent: class MockAgent { constructor(public opts: unknown) {} },
  tool: (def: unknown) => def,
}));

import type { McpToolCatalog } from '../catalog-types';
import type { InvocationInput, HitlGateResult, PauseGateContext } from '../types';

function makeCatalog(): McpToolCatalog { return { servers: [], tools: [] }; }
function makeInput(overrides: Partial<InvocationInput> = {}): InvocationInput {
  return {
    messages: [], systemPrompt: 's', model: 'm', provider: 'anthropic',
    tenantId: 't1', invocationId: 'inv1', maxTurns: 5,
    ...overrides,
  };
}

const gateContext: PauseGateContext = {
  gateReason: 'communication_review',
  pendingToolCalls: [{ id: 'pending-1', name: 'gmail__send_email', input: { to: 'x@y.com' } }],
  matchedCategory: 'externalPublishing',
};

describe('Anthropic adapter — canUseTool hitlPause → pause_requested', () => {
  it('canUseTool stashes pendingHitlGate and returns deny+interrupt', async () => {
    const { AnthropicAdapter } = await import('../anthropic');
    const adapter = new AnthropicAdapter();
    adapter.registerToolCatalog(makeCatalog());
    adapter.registerHitlGate(async () => ({
      allow: false,
      hitlPause: gateContext,
    } as HitlGateResult));

    const canUseTool = (adapter as unknown as {
      makeCanUseTool(input: InvocationInput): (
        toolName: string,
        toolInput: unknown,
        ctx: { signal: AbortSignal },
      ) => Promise<{ behavior: string; message?: string; interrupt?: boolean }>;
    }).makeCanUseTool(makeInput());

    const ctrl = new AbortController();
    const result = await canUseTool('gmail__send_email', { to: 'x@y.com' }, { signal: ctrl.signal });
    expect(result.behavior).toBe('deny');
    expect(result.interrupt).toBe(true);
    expect((adapter as unknown as { pendingHitlGate: PauseGateContext | null }).pendingHitlGate)
      .toEqual(gateContext);
  });

  it('canUseTool returns plain deny (no interrupt) for hard admission deny', async () => {
    const { AnthropicAdapter } = await import('../anthropic');
    const adapter = new AnthropicAdapter();
    adapter.registerToolCatalog(makeCatalog());
    adapter.registerHitlGate(async () => ({ allow: false, reason: 'admission denied' }));

    const canUseTool = (adapter as unknown as {
      makeCanUseTool(input: InvocationInput): (
        toolName: string, toolInput: unknown, ctx: { signal: AbortSignal },
      ) => Promise<{ behavior: string; message?: string; interrupt?: boolean }>;
    }).makeCanUseTool(makeInput());

    const result = await canUseTool('gmail__send_email', {}, { signal: new AbortController().signal });
    expect(result.behavior).toBe('deny');
    expect(result.interrupt).toBeUndefined();
    expect((adapter as unknown as { pendingHitlGate: PauseGateContext | null }).pendingHitlGate)
      .toBeNull();
  });
});

describe('the gate is told the engine\'s id for the call, where the engine has one', () => {
  // The Claude SDK names a tool_use at canUseTool; the bridge engines hand the
  // model's call id down with the dispatch. The pause stamps it on the pending
  // call, and the resume finds the call in the checkpointed record by it.
  it('Anthropic passes the SDK\'s toolUseID', async () => {
    const { AnthropicAdapter } = await import('../anthropic');
    const adapter = new AnthropicAdapter();
    adapter.registerToolCatalog(makeCatalog());
    const gate = jest.fn(async () => ({ allow: true } as HitlGateResult));
    adapter.registerHitlGate(gate);
    const canUseTool = (adapter as unknown as {
      makeCanUseTool(input: InvocationInput): (
        toolName: string, toolInput: unknown, ctx: { signal: AbortSignal; toolUseID?: string },
      ) => Promise<unknown>;
    }).makeCanUseTool(makeInput());
    await canUseTool('gmail__send_email', { to: 'x@y.com' }, { signal: new AbortController().signal, toolUseID: 'toolu_01abc' });
    expect(gate).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'gmail__send_email', callId: 'toolu_01abc' }));
  });

  it('the bridge passes the model\'s call id', async () => {
    const { dispatchFunctionCall } = await import('../mcp-bridge');
    const catalog: McpToolCatalog = {
      servers: [{ kind: 'in-process', id: 's1', config: { type: 'sdk' } as never }],
      tools: [{ name: 'gmail__send_email', inputSchema: {}, serverId: 's1' }],
    };
    const gate = jest.fn(async () => ({ allow: false, hitlPause: gateContext } as HitlGateResult));
    const bridgeContext = {
      tenantId: 't1', invocationId: 'inv1', hitlGate: gate, anomalyHandler: null,
      pendingHitlGate: null as PauseGateContext | null, abort: jest.fn(),
    };
    await dispatchFunctionCall(catalog, 'gmail__send_email', { to: 'x@y.com' }, bridgeContext, { callId: 'call_9' });
    expect(gate).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'gmail__send_email', callId: 'call_9' }));
  });
});

describe('OpenAI bridge — checkHitlGate hitlPause stash on BridgeContext', () => {
  it('dispatchFunctionCall stashes pendingHitlGate and returns error-shaped result (no throw)', async () => {
    const { dispatchFunctionCall } = await import('../mcp-bridge');
    const catalog: McpToolCatalog = {
      servers: [{ kind: 'in-process', id: 's1', config: { type: 'sdk' } as never }],
      tools: [{ name: 'gmail__send_email', inputSchema: {}, serverId: 's1' }],
    };
    const abortFn = jest.fn();
    const bridgeContext = {
      tenantId: 't1', invocationId: 'inv1',
      hitlGate: async () => ({ allow: false, hitlPause: gateContext } as HitlGateResult),
      anomalyHandler: null,
      pendingHitlGate: null as PauseGateContext | null,
      abort: abortFn,
    };

    const result = await dispatchFunctionCall(
      catalog, 'gmail__send_email', { to: 'x@y.com' }, bridgeContext,
    ) as { error?: string; reason?: string };

    expect(result.error).toBe('paused_for_human_approval');
    expect(bridgeContext.pendingHitlGate).toEqual(gateContext);
    // Critical: abort MUST fire to tear down the OpenAI run loop —
    // otherwise the model would keep emitting tool calls within the
    // same run after the gate (the Gap 1 correctness flaw we fixed).
    expect(abortFn).toHaveBeenCalledTimes(1);
  });

  it('dispatchFunctionCall returns plain { error } for hard admission deny (no stash, no abort)', async () => {
    const { dispatchFunctionCall } = await import('../mcp-bridge');
    const catalog: McpToolCatalog = {
      servers: [{ kind: 'in-process', id: 's1', config: { type: 'sdk' } as never }],
      tools: [{ name: 'gmail__send_email', inputSchema: {}, serverId: 's1' }],
    };
    const abortFn = jest.fn();
    const bridgeContext = {
      tenantId: 't1', invocationId: 'inv1',
      hitlGate: async () => ({ allow: false, reason: 'admission denied' } as HitlGateResult),
      anomalyHandler: null,
      pendingHitlGate: null as PauseGateContext | null,
      abort: abortFn,
    };

    const result = await dispatchFunctionCall(
      catalog, 'gmail__send_email', {}, bridgeContext,
    ) as { error?: string; reason?: string };

    expect(result.error).toBe('HITL gate denied');
    expect(result.reason).toBe('admission denied');
    expect(bridgeContext.pendingHitlGate).toBeNull();
    expect(abortFn).not.toHaveBeenCalled();
  });
});

// The pre-existing tests above prove canUseTool stashes the pause. This one covers
// the race that can make that stash useless: the SDK, having been
// interrupted BY that deny, then reports subtype 'error_during_execution'.
// translateSDKMessage turned it into completion{outcome:'error'} from INSIDE the
// stream loop, while pause_requested is only emitted AFTER the loop — so the
// consumer concluded the run as an error before the pause arrived.
//
// Left that way, a denied Slack send records outcome=error /
// error_during_execution with no approval row and nothing on /dashboard/review:
// the gate blocks the work and gives the user nothing to approve.
describe('Anthropic adapter — a deliberate HITL interrupt is not a failed run', () => {
  async function translateResult(subtype: string, pausePending: boolean) {
    const { AnthropicAdapter } = await import('../anthropic');
    const adapter = new AnthropicAdapter();
    if (pausePending) {
      (adapter as unknown as { pendingHitlGate: PauseGateContext }).pendingHitlGate = gateContext;
    }
    return (adapter as unknown as {
      translateSDKMessage(m: unknown): Array<{ type: string; outcome?: string }>;
    }).translateSDKMessage({ type: 'result', subtype, is_error: true, num_turns: 5 });
  }

  it('suppresses the error completion while a pause is stashed', async () => {
    const out = await translateResult('error_during_execution', true);
    expect(out.find((e) => e.type === 'completion')).toBeUndefined();
  });

  // Narrow on purpose: a genuine failure with no pause pending must still complete,
  // or real errors would silently vanish.
  it('still completes with error when no pause is stashed', async () => {
    const out = await translateResult('error_during_execution', false);
    expect(out.find((e) => e.type === 'completion')?.outcome).toBe('error');
  });

  // A successful run must be unaffected even if a pause somehow lingered.
  it('never suppresses a successful completion', async () => {
    const out = await translateResult('success', true);
    expect(out.find((e) => e.type === 'completion')?.outcome).toBe('success');
  });
});
