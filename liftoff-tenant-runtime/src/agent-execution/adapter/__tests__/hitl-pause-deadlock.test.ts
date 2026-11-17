// Regression: the interactive-chat HITL deadlock.
//
// Sequence under test:
//   1. The model calls an oversight-gated tool; canUseTool consults the registered
//      hitlGate, which returns { allow:false, hitlPause } → the adapter stashes
//      pendingHitlGate and returns deny + interrupt:true.
//   2. The SDK does NOT throw AbortError and does NOT end its stream. It emits a
//      result message (subtype 'error_during_execution'), whose error completion
//      translateSDKMessage deliberately suppresses because the pause is stashed
//      (a HITL interrupt is not a failed run).
//   3. In streaming-input mode the query then waits for the next user message
//      forever — so before the fix, invoke()'s message loop parked on the next
//      iteration, the post-loop pause emit was unreachable, and the run hung
//      until PB's 5-minute chat-stream cap with NO approval ever created.
//
// The fix emits pause_requested(hitl_gate) IN-LOOP, right after the message whose
// events were suppressed — the same in-loop check the delegation/wake pauses have
// and the same shape the bridge engines (gemini/codex/opencode) already use.
//
// This test drives the REAL invoke() against a mocked query whose stream never
// ends after the result message. If the in-loop emit regresses, the for-await
// below never terminates and the test fails by timeout instead of passing
// vacuously.

const mockInterrupt = jest.fn(async () => undefined);
let mockCapturedOptions: {
  canUseTool?: (
    _toolName: string,
    _toolInput: unknown,
    _ctx: { signal: AbortSignal },
  ) => Promise<{ behavior: string; interrupt?: boolean }>;
} = {};

jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  AbortError: class AbortError extends Error {},
  query: jest.fn((args: { options: typeof mockCapturedOptions }) => {
    mockCapturedOptions = args.options;
    return {
      interrupt: mockInterrupt,
      async *[Symbol.asyncIterator]() {
        // The SDK consults canUseTool while the query is between messages.
        // Drive the REAL makeCanUseTool → hitlGate → stash path.
        const deny = await mockCapturedOptions.canUseTool!(
          'mcp__liftoff-tool-gateway__slack-d77db9a0__send_message',
          { channel: '#ci-alerts', text: 'testing 1, 2, 3' },
          { signal: new AbortController().signal },
        );
        if (deny.behavior !== 'deny' || deny.interrupt !== true) {
          throw new Error(`expected deny+interrupt from canUseTool, got ${JSON.stringify(deny)}`);
        }
        // The result message the SDK emits after the interrupted turn.
        yield {
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          num_turns: 5,
          stop_reason: 'tool_use',
          usage: { input_tokens: 6, output_tokens: 291, cache_read_input_tokens: 0 },
        };
        // Streaming-input mode: the stream stays open awaiting the next user
        // message. Before the fix, invoke() parked here forever.
        await new Promise<never>(() => { /* never resolves */ });
      },
    };
  }),
}));

import { AnthropicAdapter } from '../anthropic';
import type { McpToolCatalog } from '../catalog-types';
import type {
  HitlGateResult,
  InvocationEvent,
  InvocationInput,
  PauseGateContext,
} from '../types';

const gateContext: PauseGateContext = {
  gateReason: 'communication_review',
  pendingToolCalls: [{
    id: 'pending-1',
    name: 'mcp__liftoff-tool-gateway__slack-d77db9a0__send_message',
    input: { channel: '#ci-alerts', text: 'testing 1, 2, 3' },
  }],
};

function makeInput(): InvocationInput {
  return {
    messages: [], systemPrompt: 's', model: 'm', provider: 'anthropic',
    tenantId: 't1', invocationId: 'inv1', maxTurns: 5,
  };
}

describe('Anthropic adapter — canUseTool HITL deny must emit pause_requested in-loop, not hang', () => {
  it('yields pause_requested(hitl_gate) and returns even though the SDK stream never ends', async () => {
    const adapter = new AnthropicAdapter();
    adapter.registerToolCatalog({ servers: [], tools: [] } as McpToolCatalog);
    adapter.registerHitlGate(async () => ({
      allow: false,
      hitlPause: gateContext,
    } as HitlGateResult));

    const events: InvocationEvent[] = [];
    // If the in-loop emit regresses this for-await never terminates and jest
    // times the test out — the deadlock reproduced.
    for await (const event of adapter.invoke(makeInput(), new AbortController().signal)) {
      events.push(event);
    }

    // The suppressed error completion must NOT surface.
    expect(events.find((e) => e.type === 'completion')).toBeUndefined();

    // Token accounting from the result message is preserved ahead of the pause.
    const usage = events.find((e) => e.type === 'usage');
    expect(usage).toBeDefined();

    // The terminal event is the oversight pause, carrying the stashed context.
    const last = events[events.length - 1];
    expect(last).toMatchObject({
      type: 'pause_requested',
      reason: 'hitl_gate',
      gateContext,
    });

    // The SDK subprocess was told to shut down.
    expect(mockInterrupt).toHaveBeenCalled();

    // The stash is consumed — a later natural stream end cannot double-emit.
    expect((adapter as unknown as { pendingHitlGate: PauseGateContext | null }).pendingHitlGate)
      .toBeNull();
  }, 10_000);
});
