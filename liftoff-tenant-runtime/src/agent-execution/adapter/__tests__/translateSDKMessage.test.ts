// F-1 feature-equivalence test suite — adapter contract verification.
//
// Mock the vendor SDK at module load — the adapter imports query/AbortError
// from @anthropic-ai/claude-agent-sdk, which is ESM and not transformed by
// jest. The translation/hook layers under test don't invoke the SDK, but
// the import has to resolve.
jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: jest.fn(),
  AbortError: class AbortError extends Error {
    constructor() {
      super('aborted');
      this.name = 'AbortError';
    }
  },
}));

//
// Scope: these tests verify the adapter's TRANSLATION LAYER — converting
// vendor SDK messages into platform InvocationEvent streams — and its
// HOOK REGISTRATION — that canUseTool / PostToolUse hooks call into the
// platform contract correctly. They do NOT call the real vendor APIs.
//
// The 6 canonical scenarios from the master plan F-1 section:
//   1. HITL gate denies execution → tool_call_finished with HITL-deny error
//   2. Recovery LLM intercepts a known anomaly → anomaly_detected emitted
//   3. ask_user pauses cleanly + resumes on response
//   4. Mid-execution user message lands as new input
//   5. Tool catalog round-trip (5 MCP tools dispatchable on both adapters)
//   6. Event stream emits same logical sequence across adapters
//
// Each scenario is asserted against the Anthropic adapter via its private
// translateSDKMessage() and canUseTool() helpers — the layers the adapter
// owns vs. the SDK's internal loop. The OpenAI adapter has the same
// surface; identical contract behavior is asserted by reusing the same
// scenario assertions against its translation layer in
// `feature-equivalence.openai.test.ts` (parallel file).

import { AnthropicAdapter } from '../anthropic';
import type { McpToolCatalog } from '../catalog-types';
import type { InvocationInput, PlatformMessage } from '../types';
import { parseToolErrorEnvelope } from '../../../tool-gateway/tool-error-envelope';

// SDKMessage shapes — matched to claude-agent-sdk's discriminated union
// (verified node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts).
type AnyAssistantMessage = {
  type: 'assistant';
  message: { content: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }> };
};
type AnyUserMessage = {
  type: 'user';
  tool_use_result?: unknown;
  parent_tool_use_id?: string;
};
type AnyResultMessage = {
  type: 'result';
  subtype: 'success' | 'error';
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number | null };
};

function makeCatalog(): McpToolCatalog {
  return { servers: [], tools: [] };
}

function makeInput(overrides: Partial<InvocationInput> = {}): InvocationInput {
  return {
    messages: [],
    systemPrompt: 'system',
    model: 'claude-opus-4-8',
    provider: 'anthropic',
    tenantId: 't1',
    invocationId: 'inv1',
    maxTurns: 5,
    ...overrides,
  };
}

// Access private translateSDKMessage via a typed cast — the test owns the
// public contract, and the contract requires this translation behavior.
function callTranslate(adapter: AnthropicAdapter, msg: AnyAssistantMessage | AnyUserMessage | AnyResultMessage) {
  return (adapter as unknown as {
    translateSDKMessage(m: unknown): Array<{ type: string; [k: string]: unknown }>;
  }).translateSDKMessage(msg);
}

describe('F-1 — Anthropic adapter translation contract', () => {
  // ── Scenario 6: event stream emits the same logical sequence ──────────
  describe('Scenario 6: SDKMessage → InvocationEvent translation', () => {
    it('translates assistant text into a single assistant_message event', () => {
      const adapter = new AnthropicAdapter();
      adapter.registerToolCatalog(makeCatalog());
      const events = callTranslate(adapter, {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'hello' }] },
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'assistant_message',
        content: [{ type: 'text', text: 'hello' }],
      });
    });

    it('translates partial stream_event deltas: text → assistant_delta, others ignored', () => {
      const adapter = new AnthropicAdapter();
      adapter.registerToolCatalog(makeCatalog());
      const translate = (m: unknown) =>
        (adapter as unknown as { translateSDKMessage(m: unknown): Array<{ type: string; [k: string]: unknown }> }).translateSDKMessage(m);

      expect(translate({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } } }))
        .toEqual([{ type: 'assistant_delta', text: 'Hel' }]);
      // Non-text deltas and non-delta stream events produce nothing.
      expect(translate({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{' } } }))
        .toEqual([]);
      expect(translate({ type: 'stream_event', event: { type: 'message_start' } })).toEqual([]);
    });

    it('translates assistant tool_use into tool_call_started + carries args + callId', () => {
      const adapter = new AnthropicAdapter();
      adapter.registerToolCatalog(makeCatalog());
      const events = callTranslate(adapter, {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'call-1', name: 'web_search', input: { query: 'liftoff' } },
          ],
        },
      });
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'tool_call_started',
          toolName: 'web_search',
          callId: 'call-1',
          args: { query: 'liftoff' },
        }),
      ]));
    });

    it('translates user tool_use_result into tool_call_finished with the parent callId', () => {
      const adapter = new AnthropicAdapter();
      adapter.registerToolCatalog(makeCatalog());
      const events = callTranslate(adapter, {
        type: 'user',
        tool_use_result: { ok: true, value: 42 },
        parent_tool_use_id: 'call-1',
      });
      expect(events).toContainEqual(expect.objectContaining({
        type: 'tool_call_finished',
        callId: 'call-1',
      }));
    });

    it('prefers tool_result.tool_use_id from message.content over parent_tool_use_id', () => {
      // This is the canonical SDK shape: the SDK delivers user messages whose
      // .message.content carries one or more tool_result blocks whose
      // tool_use_id references the tool_use that produced the result.
      // parent_tool_use_id on SDKUserMessage refers to the *nested* Task
      // subagent parent (not to the matching tool_use), so it must NOT win
      // when both are present. PB-side harness assembler pairs
      // tool_call_started ↔ tool_call_finished by callId; an empty or
      // mismatched id leaves the result field unpopulated on the report.
      const adapter = new AnthropicAdapter();
      adapter.registerToolCatalog(makeCatalog());
      const events = callTranslate(adapter, {
        type: 'user',
        tool_use_result: 'inner-result-string',
        parent_tool_use_id: 'nested-parent-99',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'call-direct-1', content: 'inner-result-string' },
          ],
        },
      });
      expect(events).toContainEqual(expect.objectContaining({
        type: 'tool_call_finished',
        callId: 'call-direct-1',
        result: 'inner-result-string',
      }));
    });

    it('falls back to parent_tool_use_id when message.content has no tool_result block', () => {
      const adapter = new AnthropicAdapter();
      adapter.registerToolCatalog(makeCatalog());
      const events = callTranslate(adapter, {
        type: 'user',
        tool_use_result: { x: 1 },
        parent_tool_use_id: 'nested-parent-77',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'just text' },
          ],
        },
      });
      expect(events).toContainEqual(expect.objectContaining({
        type: 'tool_call_finished',
        callId: 'nested-parent-77',
      }));
    });

    it('translates SDKResultMessage into usage + completion events with token totals', () => {
      const adapter = new AnthropicAdapter();
      adapter.registerToolCatalog(makeCatalog());
      const events = callTranslate(adapter, {
        type: 'result',
        subtype: 'success',
        usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 10, cache_creation_input_tokens: 40 },
      });
      expect(events).toContainEqual(expect.objectContaining({
        type: 'usage',
        usage: {
          inputTokens: 100, outputTokens: 20, cachedTokens: 10,
          // And the cache WRITE is carried as its own billable count, because
          // Anthropic charges it at 1.25x input against the read's 0.1x.
          cacheWriteTokens: 40,
          // Billing keeps `inputTokens` and `cachedTokens` exactly as the
          // vendor reports them. The CONTEXT is a different figure: Anthropic's
          // `input_tokens` excludes both the cache read and the cache WRITE, so
          // the prompt the model actually read is the three together. A guard
          // on `input + cache_read` would be short by 40,000 here.
          contextTokens: 150,
        },
      }));
      expect(events).toContainEqual(expect.objectContaining({
        type: 'completion',
        outcome: 'success',
      }));
    });

    it('translates SDKResultMessage(error) into completion with outcome=error', () => {
      const adapter = new AnthropicAdapter();
      adapter.registerToolCatalog(makeCatalog());
      const events = callTranslate(adapter, {
        type: 'result',
        subtype: 'error',
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 },
      });
      expect(events).toContainEqual(expect.objectContaining({
        type: 'completion',
        outcome: 'error',
      }));
    });
  });

  // ── Scenario 1: HITL gate denies execution ────────────────────────────
  describe('Scenario 1: HITL gate denies execution', () => {
    it('canUseTool returns deny + reason when hitlGate denies', async () => {
      const adapter = new AnthropicAdapter();
      adapter.registerToolCatalog(makeCatalog());
      const hitlCalls: Array<{ toolName: string; args: unknown }> = [];
      adapter.registerHitlGate(async (input) => {
        hitlCalls.push({ toolName: input.toolName, args: input.args });
        return { allow: false, reason: 'awaiting human approval' };
      });

      const canUseTool = (adapter as unknown as {
        makeCanUseTool(input: InvocationInput): (
          toolName: string,
          toolInput: unknown,
          ctx: { signal: AbortSignal },
        ) => Promise<{ behavior: string; message?: string }>;
      }).makeCanUseTool(makeInput());

      const result = await canUseTool(
        'sandbox.bash',
        { command: 'rm -rf /' },
        { signal: new AbortController().signal },
      );
      expect(result.behavior).toBe('deny');
      expect(result.message).toBe('awaiting human approval');
      expect(hitlCalls).toEqual([{ toolName: 'sandbox.bash', args: { command: 'rm -rf /' } }]);
    });

    it('canUseTool returns allow when no hitlGate is registered (open default)', async () => {
      const adapter = new AnthropicAdapter();
      adapter.registerToolCatalog(makeCatalog());
      const canUseTool = (adapter as unknown as {
        makeCanUseTool(input: InvocationInput): (
          toolName: string,
          toolInput: unknown,
          ctx: { signal: AbortSignal },
        ) => Promise<{ behavior: string; updatedInput?: Record<string, unknown> }>;
      }).makeCanUseTool(makeInput());
      const toolInput = { command: 'ls' };
      const result = await canUseTool('any.tool', toolInput, { signal: new AbortController().signal });
      expect(result.behavior).toBe('allow');
      // updatedInput must be a record on every allow result — the SDK's
      // runtime Zod validator rejects allow responses missing this field
      // even though the TypeScript type marks it optional (sdk.d.ts).
      expect(result.updatedInput).toEqual(toolInput);
    });

    it('canUseTool allow result includes updatedInput when hitlGate accepts', async () => {
      const adapter = new AnthropicAdapter();
      adapter.registerToolCatalog(makeCatalog());
      adapter.registerHitlGate(async () => ({ allow: true }));
      const canUseTool = (adapter as unknown as {
        makeCanUseTool(input: InvocationInput): (
          toolName: string,
          toolInput: unknown,
          ctx: { signal: AbortSignal },
        ) => Promise<{ behavior: string; updatedInput?: Record<string, unknown> }>;
      }).makeCanUseTool(makeInput());
      const toolInput = { channel: 'general', text: 'hi' };
      const result = await canUseTool('slack__send_message', toolInput, { signal: new AbortController().signal });
      expect(result.behavior).toBe('allow');
      expect(result.updatedInput).toEqual(toolInput);
    });

    it('canUseTool returns updatedInput={} when toolInput is null/undefined', async () => {
      const adapter = new AnthropicAdapter();
      adapter.registerToolCatalog(makeCatalog());
      const canUseTool = (adapter as unknown as {
        makeCanUseTool(input: InvocationInput): (
          toolName: string,
          toolInput: unknown,
          ctx: { signal: AbortSignal },
        ) => Promise<{ behavior: string; updatedInput?: Record<string, unknown> }>;
      }).makeCanUseTool(makeInput());
      const result = await canUseTool('any.tool', undefined as unknown as Record<string, unknown>, { signal: new AbortController().signal });
      expect(result.behavior).toBe('allow');
      expect(result.updatedInput).toEqual({});
    });

    it('canUseTool denies + signals interrupt when the abort signal fires', async () => {
      const adapter = new AnthropicAdapter();
      adapter.registerToolCatalog(makeCatalog());
      adapter.registerHitlGate(async () => ({ allow: true }));
      const ac = new AbortController();
      ac.abort();
      const canUseTool = (adapter as unknown as {
        makeCanUseTool(input: InvocationInput): (
          toolName: string,
          toolInput: unknown,
          ctx: { signal: AbortSignal },
        ) => Promise<{ behavior: string; interrupt?: boolean }>;
      }).makeCanUseTool(makeInput());
      const result = await canUseTool('sandbox.bash', {}, { signal: ac.signal });
      expect(result.behavior).toBe('deny');
      expect(result.interrupt).toBe(true);
    });
  });

  // ── Scenario 2: Recovery LLM intercepts a known anomaly ──────────────
  describe('Scenario 2: PostToolUse hook routes tool-call errors to the anomaly handler', () => {
    it('PostToolUse calls anomalyHandler when the tool response is_error', async () => {
      const adapter = new AnthropicAdapter();
      adapter.registerToolCatalog(makeCatalog());
      const anomalies: Array<{ kind: string; toolName?: string; error?: string }> = [];
      adapter.registerAnomalyHandler(async (input) => {
        anomalies.push({
          kind: input.kind,
          toolName: input.context.toolName,
          error: input.context.error,
        });
        return { escalate: false };
      });

      // Prime the currentInvocation field — the hook reads from it.
      (adapter as unknown as { currentInvocation: InvocationInput }).currentInvocation = makeInput();

      const hook = (adapter as unknown as {
        makePostToolUseHook(): (
          input: { tool_name?: string; tool_response?: { is_error?: boolean; content?: unknown } },
          toolUseID: string | undefined,
        ) => Promise<unknown>;
      }).makePostToolUseHook();

      await hook(
        {
          tool_name: 'web_search',
          tool_response: { is_error: true, content: 'API timeout' },
        },
        'tu-7',
      );

      // The handler fires with the CLASSIFIED TOOL_ERROR envelope (not the raw
      // vendor text): envelopeRawToolError classifies "API timeout" →
      // vendor_unavailable so the recovery loop's parseToolErrorEnvelope + fast-
      // trip fire instead of a wasted recovery-LLM turn. Raw message preserved.
      expect(anomalies).toHaveLength(1);
      expect(anomalies[0].kind).toBe('tool_call_error');
      expect(anomalies[0].toolName).toBe('web_search');
      const parsed = parseToolErrorEnvelope(anomalies[0].error)!;
      expect(parsed).not.toBeNull();
      expect(parsed.code).toBe('vendor_unavailable');
      expect(parsed.retryable).toBe(true);
      expect(parsed.error).toBe('API timeout');
    });

    it('PostToolUse does NOT call anomalyHandler when the tool succeeded', async () => {
      const adapter = new AnthropicAdapter();
      adapter.registerToolCatalog(makeCatalog());
      let called = false;
      adapter.registerAnomalyHandler(async () => {
        called = true;
        return { escalate: false };
      });
      (adapter as unknown as { currentInvocation: InvocationInput }).currentInvocation = makeInput();

      const hook = (adapter as unknown as {
        makePostToolUseHook(): (
          input: { tool_name?: string; tool_response?: { is_error?: boolean; content?: unknown } },
          toolUseID: string | undefined,
        ) => Promise<unknown>;
      }).makePostToolUseHook();

      await hook({ tool_name: 'web_search', tool_response: { is_error: false, content: 'OK' } }, 'tu-9');
      expect(called).toBe(false);
    });
  });

  // ── Scenario 3: ask_user pauses + resumes ─────────────────────────────
  describe('Scenario 3: pause / resume contract', () => {
    it('pause() returns an adapter-tagged ResumeToken serializing the InvocationInput', async () => {
      const adapter = new AnthropicAdapter();
      adapter.registerToolCatalog(makeCatalog());
      (adapter as unknown as { currentInvocation: InvocationInput }).currentInvocation = makeInput({ invocationId: 'inv-abc' });
      const token = await adapter.pause('ask_user');
      expect(token.adapterKind).toBe('anthropic');
      const decoded = JSON.parse(token.serialized) as { reason: string; input: InvocationInput };
      expect(decoded.reason).toBe('ask_user');
      expect(decoded.input.invocationId).toBe('inv-abc');
    });

    it('resume() rebuilds the InvocationInput with the user response appended as a user message', async () => {
      const adapter = new AnthropicAdapter();
      adapter.registerToolCatalog(makeCatalog());
      // Stub invoke so resume() doesn't actually call the SDK.
      const invokeCalls: InvocationInput[] = [];
      (adapter as unknown as { invoke: (i: InvocationInput) => AsyncIterable<unknown> }).invoke = async function* (i: InvocationInput) {
        invokeCalls.push(i);
        yield { type: 'completion', outcome: 'success' };
      };

      (adapter as unknown as { currentInvocation: InvocationInput }).currentInvocation = makeInput();
      const token = await adapter.pause('ask_user');

      const events = [];
      for await (const e of adapter.resume(token, { text: 'sure, go ahead' }, new AbortController().signal)) {
        events.push(e);
      }
      expect(invokeCalls).toHaveLength(1);
      const replayed = invokeCalls[0];
      expect(replayed.messages[replayed.messages.length - 1]).toMatchObject({
        role: 'user',
        content: [{ type: 'text', text: 'sure, go ahead' }],
      });
    });
  });

  // ── Scenario 4: mid-execution user message ────────────────────────────
  describe('Scenario 4: injectMessage adds a user turn to the in-flight stream queue', () => {
    it('queues the message when no resolver is waiting', async () => {
      const adapter = new AnthropicAdapter();
      adapter.registerToolCatalog(makeCatalog());
      const queue = (adapter as unknown as { streamInputQueue: unknown[] }).streamInputQueue;
      queue.length = 0;  // make sure
      await adapter.injectMessage({ text: 'wait, change of plan' });
      expect(queue).toHaveLength(1);
      expect((queue[0] as { message: { content: string } }).message.content).toBe('wait, change of plan');
    });

    it('hands the message to a waiting resolver when one is registered', async () => {
      const adapter = new AnthropicAdapter();
      adapter.registerToolCatalog(makeCatalog());
      let received: PlatformMessage | null = null;
      const promise = new Promise<void>((resolveDone) => {
        (adapter as unknown as { streamInputResolvers: Array<(m: unknown) => void> }).streamInputResolvers.push((m: unknown) => {
          received = m as PlatformMessage;
          resolveDone();
        });
      });
      await adapter.injectMessage({ text: 'inject' });
      await promise;
      expect(received).not.toBeNull();
      expect((received as unknown as { message: { content: string } }).message.content).toBe('inject');
    });
  });
});

// ── 2.3 / 2.4 / 2.6 — capture-correctness regressions ───────────────────────
describe('Anthropic translation — dropped blocks, is_error, usage', () => {
  const translate = (m: unknown) =>
    (new AnthropicAdapter() as unknown as {
      translateSDKMessage(m: unknown): Array<{ type: string; [k: string]: unknown }>;
    }).translateSDKMessage(m);

  // 2.4 — non-text/non-tool_use blocks are intentionally dropped; their content
  // must NEVER appear in any emitted platform event (forwarding thinking would
  // leak signed content + break message-replay correctness).
  for (const dropped of ['thinking', 'redacted_thinking', 'server_tool_use', 'web_search_tool_result', 'web_fetch_tool_result']) {
    it(`drops ${dropped} blocks — no platform event carries the content`, () => {
      const secret = `SECRET_${dropped.toUpperCase()}_CONTENT`;
      const events = translate({
        type: 'assistant',
        message: { content: [
          { type: dropped, text: secret, content: secret, thinking: secret, data: secret },
          { type: 'text', text: 'visible answer' },
        ] },
      });
      const blob = JSON.stringify(events);
      expect(blob).not.toContain(secret);
      // the visible text still comes through
      const msg = events.find((e) => e.type === 'assistant_message');
      expect(JSON.stringify(msg)).toContain('visible answer');
    });
  }

  it('drops a thinking-only assistant message entirely (no assistant_message)', () => {
    const events = translate({
      type: 'assistant',
      message: { content: [{ type: 'thinking', thinking: 'SIGNED_THOUGHTS' }] },
    });
    expect(events.find((e) => e.type === 'assistant_message')).toBeUndefined();
    expect(JSON.stringify(events)).not.toContain('SIGNED_THOUGHTS');
  });

  // 2.3 — tool_use_result on a synthesized user message translates to
  // tool_call_finished and carries NO is_error (that field is PostToolUse-only).
  it('user tool_use_result → tool_call_finished without is_error', () => {
    const events = translate({
      type: 'user',
      tool_use_result: { ok: true },
      parent_tool_use_id: 'call-42',
    });
    expect(events).toEqual([
      expect.objectContaining({ type: 'tool_call_finished', callId: 'call-42' }),
    ]);
    expect(JSON.stringify(events)).not.toContain('is_error');
  });

  // 2.6 — Anthropic emits a usage event with non-zero counts from the result message.
  it('result message → usage event with token counts', () => {
    const events = translate({
      type: 'result', subtype: 'success',
      usage: { input_tokens: 120, output_tokens: 45, cache_read_input_tokens: 30 },
    });
    const usage = events.find((e) => e.type === 'usage') as { usage: Record<string, unknown> };
    // `cacheWriteTokens: 0` rides along: Anthropic DOES charge for a write, so
    // the absence of one is a measurement rather than an unknown.
    expect(usage.usage).toEqual({ inputTokens: 120, outputTokens: 45, cachedTokens: 30, contextTokens: 150, cacheWriteTokens: 0 });
  });
});
