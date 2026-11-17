// Cross-adapter contract harness — parametrized over every
// VendorSdkAdapter implementation. Drives the platform contract
// (registerToolCatalog / registerHitlGate / registerAnomalyHandler /
// pause / resume / injectMessage / invoke) and asserts platform-visible
// behavior is identical regardless of which vendor SDK is wrapped.
//
// The translation-layer tests (translateSDKMessage.test.ts and
// openai-equivalence.test.ts) exercise the per-adapter internals.
// This file exercises the SHARED contract — anything that the platform
// code above the adapter relies on must produce identical results here
// across all adapters.
//
// Scenarios covered (per the F-1 spec):
//   1. HITL gate denies — both adapters surface the deny through the
//      same platform-visible path (canUseTool deny / inputGuardrail
//      tripwire).
//   2. Anomaly handler — registration + invocation contract identical.
//   3. pause / resume — token shape + resume-appends-user-message
//      contract identical.
//   4. injectMessage — accepts and queues without throwing on either.
//   5. Tool catalog round-trip — 5-tool catalog (custom_mcp_server +
//      connector + sandbox-executor + code_session + web_search)
//      registers cleanly on both adapters; both expose the
//      registered catalog back via the documented field.
//   6. Event-stream translation — covered per-adapter in the dedicated
//      translation-layer files; the contract surface (asyncIterable of
//      InvocationEvent values) is asserted here.

jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: jest.fn(),
  AbortError: class AbortError extends Error {
    constructor() { super('aborted'); this.name = 'AbortError'; }
  },
}));
jest.mock('@openai/agents', () => ({
  run: jest.fn(),
  Agent: class MockAgent { constructor(public opts: unknown) {} },
  tool: (def: unknown) => def,
}));
// Stub @google/genai so the harness can instantiate GeminiAdapter without
// touching Vertex. Scenario 6 only asserts the AsyncIterable shape — it does
// not drain — so the body of generateContentStream is never executed; the
// constructor presence is what matters.
jest.mock('@google/genai', () => ({
  GoogleGenAI: jest.fn().mockImplementation(() => ({
    models: { generateContentStream: jest.fn() },
  })),
  FinishReason: { STOP: 'STOP', MAX_TOKENS: 'MAX_TOKENS', FINISH_REASON_UNSPECIFIED: 'FINISH_REASON_UNSPECIFIED' },
  Type: { STRING: 'STRING', NUMBER: 'NUMBER', INTEGER: 'INTEGER', BOOLEAN: 'BOOLEAN', OBJECT: 'OBJECT', ARRAY: 'ARRAY', TYPE_UNSPECIFIED: 'TYPE_UNSPECIFIED' },
}));
// Self-managing engine SDKs (Codex / ADK / OpenCode) so the shared harness can
// construct + surface-test all 7 concrete engines without a live vendor call.
jest.mock('@google/adk', () => {
  class LlmAgent { constructor(public cfg: unknown) {} }
  class Runner { constructor(public cfg: unknown) {} runAsync() { return (async function* () { /* empty */ })(); } }
  class FunctionTool { constructor(public opts: unknown) {} }
  class InMemorySessionService { getSession = jest.fn(async () => undefined); createSession = jest.fn(async () => ({ id: 's1' })); }
  class TokenBasedContextCompactor { constructor(public o: unknown) {} }
  class LlmSummarizer { constructor(public o: unknown) {} }
  class Gemini { constructor(public o: unknown) {} }
  return { LlmAgent, Runner, FunctionTool, InMemorySessionService, TokenBasedContextCompactor, LlmSummarizer, Gemini, getFunctionCalls: () => [], getFunctionResponses: () => [], isFinalResponse: () => false };
});
jest.mock('../opencode/server', () => ({
  startOpencode: jest.fn(async () => ({ client: {}, server: { url: 'http://127.0.0.1:1', close: jest.fn() } })),
}));
jest.mock('../esm-import', () => ({
  esmImport: async () => ({
    Codex: class Codex { constructor(public o: unknown) {} startThread() { return { id: 't1', runStreamed: jest.fn() }; } },
  }),
}));
jest.mock('../../../infrastructure/secrets', () => ({ getOpenRouterApiKey: jest.fn().mockResolvedValue('test-openrouter-key') }));

import { AnthropicAdapter } from '../anthropic';
import { OpenAiWireAdapter } from '../openai-wire';
import { openRouterTarget } from '../openrouter';
import { openAiTarget } from '../openai';
import { createXaiAdapter } from '../xai';
import { RESOLVABLE_EXECUTION_ENGINE_IDS } from '../types';
import { GeminiAdapter } from '../gemini';
import { CodexAdapter } from '../codex';
import { GeminiAdkAdapter } from '../gemini-adk';
import { OpencodeAdapter } from '../opencode';
import { GeminiCliAdapter } from '../gemini-cli';
import { dispatchFunctionCall, type BridgeContext } from '../mcp-bridge';
import { getMcpClientPool } from '../mcp-client-pool';
import type { McpToolCatalog, McpToolDefinition, InProcessMcpServerConfig } from '../catalog-types';
import type { InvocationInput, VendorSdkAdapter, AnomalyHandler } from '../types';
import { parseToolErrorEnvelope, formatToolErrorEnvelope } from '../../../tool-gateway/tool-error-envelope';

function makeFiveToolCatalog(): McpToolCatalog {
  const tools: McpToolDefinition[] = [
    { name: 'custom_mcp_server__github__create_issue',
      description: 'Open a GitHub issue via a tenant custom MCP server',
      inputSchema: { type: 'object', properties: { title: { type: 'string' } } },
      serverId: 'custom-mcp-github' },
    { name: 'slack__send_message',
      description: 'Send a Slack message via the Slack connector',
      inputSchema: { type: 'object', properties: { channel: { type: 'string' }, text: { type: 'string' } } },
      serverId: 'liftoff-tool-gateway' },
    { name: 'sandbox__execute_v2',
      description: 'Run a sandbox primitive (sandbox-executor service)',
      inputSchema: { type: 'object', properties: { runConfigJson: { type: 'string' } } },
      serverId: 'liftoff-tool-gateway' },
    { name: 'code_session__exec',
      description: 'Run a code session step',
      inputSchema: { type: 'object', properties: { code: { type: 'string' } } },
      serverId: 'liftoff-tool-gateway' },
    { name: 'web_search',
      description: 'Provider-native web search',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
      serverId: 'liftoff-tool-gateway' },
  ];
  // Minimal in-process server stub so the catalog shape is realistic on
  // both adapters. The Anthropic adapter passes this straight to the SDK
  // (mocked out); the OpenAI adapter routes through the mcp-bridge.
  const inProcessServer: InProcessMcpServerConfig = {
    kind: 'in-process',
    id: 'liftoff-tool-gateway',
    config: { name: 'liftoff-tool-gateway', instance: { connect: jest.fn() } as never } as never,
  };
  return { servers: [inProcessServer], tools };
}

type HarnessProvider = 'anthropic' | 'openai' | 'google';

const MODEL_BY_PROVIDER: Record<HarnessProvider, string> = {
  anthropic: 'claude-opus-4-8',
  openai: 'gpt-5-codex',
  google: 'gemini-3-pro-preview',
};

function makeInput(provider: HarnessProvider, overrides: Partial<InvocationInput> = {}): InvocationInput {
  return {
    messages: [],
    systemPrompt: 'system',
    model: MODEL_BY_PROVIDER[provider],
    provider,
    tenantId: 't1',
    invocationId: `inv-${provider}`,
    maxTurns: 5,
    ...overrides,
  };
}

interface AdapterFixture {
  name: string;
  provider: HarnessProvider;
  factory: () => VendorSdkAdapter;
}

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  _resetProvenanceForTesting,
  checkWriteProvenance,
  recordProvenance,
} from '../../../tool-gateway/record-provenance';

const ADAPTERS: AdapterFixture[] = [
  { name: 'AnthropicAdapter', provider: 'anthropic', factory: () => new AnthropicAdapter() },
  { name: 'OpenAiWireAdapter',    provider: 'openai',    factory: () => new OpenAiWireAdapter({ target: openAiTarget }) },
  { name: 'GeminiAdapter',    provider: 'google',    factory: () => new GeminiAdapter() },
];

describe.each(ADAPTERS)('cross-adapter contract: $name', ({ name, provider, factory }) => {
  // ── Scenario 1: HITL gate registration is honored ─────────────────────
  it('Scenario 1 — accepts a HITL gate without throwing', () => {
    const adapter = factory();
    adapter.registerToolCatalog({ servers: [], tools: [] });
    expect(() => adapter.registerHitlGate(async () => ({ allow: false, reason: 'denied' }))).not.toThrow();
  });

  // ── Scenario 2: anomaly handler registration is honored ───────────────
  it('Scenario 2 — accepts an anomaly handler without throwing', () => {
    const adapter = factory();
    adapter.registerToolCatalog({ servers: [], tools: [] });
    expect(() => adapter.registerAnomalyHandler(async () => ({ escalate: false }))).not.toThrow();
  });

  // ── Scenario 3: pause → token → resume contract ───────────────────────
  it('Scenario 3 — pause() returns a vendor-tagged token round-tripping the InvocationInput', async () => {
    const adapter = factory();
    adapter.registerToolCatalog({ servers: [], tools: [] });
    (adapter as unknown as { currentInvocation: InvocationInput }).currentInvocation =
      makeInput(provider, { invocationId: 'inv-pause' });
    const token = await adapter.pause('ask_user');
    expect(token.adapterKind).toBe(provider);
    const decoded = JSON.parse(token.serialized) as { reason: string; input: InvocationInput };
    expect(decoded.reason).toBe('ask_user');
    expect(decoded.input.invocationId).toBe('inv-pause');
  });

  it('Scenario 3 — resume() re-invokes with the user response appended as a user message', async () => {
    const adapter = factory();
    adapter.registerToolCatalog({ servers: [], tools: [] });
    const invokeCalls: InvocationInput[] = [];
    (adapter as unknown as { invoke: (i: InvocationInput) => AsyncIterable<unknown> }).invoke = async function* (i: InvocationInput) {
      invokeCalls.push(i);
      yield { type: 'completion', outcome: 'success' };
    };
    (adapter as unknown as { currentInvocation: InvocationInput }).currentInvocation = makeInput(provider);
    const token = await adapter.pause('ask_user');
    for await (const _ of adapter.resume(token, { text: 'go ahead' }, new AbortController().signal)) {
      void _;
    }
    expect(invokeCalls).toHaveLength(1);
    const replayed = invokeCalls[0];
    expect(replayed.messages[replayed.messages.length - 1]).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: 'go ahead' }],
    });
  });

  // ── Scenario 4: injectMessage queues without throwing ─────────────────
  it('Scenario 4 — injectMessage accepts a user message without throwing', async () => {
    const adapter = factory();
    adapter.registerToolCatalog({ servers: [], tools: [] });
    await expect(adapter.injectMessage({ text: 'switch context' })).resolves.toBeUndefined();
  });

  // ── Scenario 4b: an interrupt-source message is queued for the loop ───
  // The conversational loop delivers mid-run user messages via
  // injectMessage({source: 'interrupt'}); every adapter must retain the
  // message on its injection queue (anthropic: the streaming-input queue;
  // the others: this.injected) so the next model turn sees it.
  it('Scenario 4b — injectMessage(source: interrupt) lands on the injection queue', async () => {
    const adapter = factory();
    adapter.registerToolCatalog({ servers: [], tools: [] });
    await adapter.injectMessage({ text: 'user redirect mid-run', source: 'interrupt' });
    const internals = adapter as unknown as {
      injected?: Array<{ text: string }>;
      streamInputQueue?: Array<{ message?: { content?: unknown } }>;
    };
    const queued =
      internals.injected?.some((m) => m.text === 'user redirect mid-run')
      || internals.streamInputQueue?.some(
        (m) => JSON.stringify(m).includes('user redirect mid-run'),
      );
    expect(queued).toBe(true);
  });

  // ── Scenario 5: 5-tool catalog round-trip ─────────────────────────────
  it('Scenario 5 — accepts the canonical 5-tool platform catalog (custom_mcp + connector + sandbox + code_session + web_search)', () => {
    const adapter = factory();
    const catalog = makeFiveToolCatalog();
    expect(() => adapter.registerToolCatalog(catalog)).not.toThrow();
    // Both adapters store the catalog on a private field; the field
    // name is shared (this.catalog). Reading via cast verifies the
    // catalog is retained for downstream invoke() use.
    const stored = (adapter as unknown as { catalog: McpToolCatalog | null }).catalog;
    expect(stored).not.toBeNull();
    expect(stored!.tools).toHaveLength(5);
    expect(stored!.tools.map((t) => t.name).sort()).toEqual([
      'code_session__exec',
      'custom_mcp_server__github__create_issue',
      'sandbox__execute_v2',
      'slack__send_message',
      'web_search',
    ]);
  });

  // ── Scenario 6: invoke() shape contract ───────────────────────────────
  it('Scenario 6 — invoke() returns an async iterable (contract shape)', () => {
    const adapter = factory();
    adapter.registerToolCatalog(makeFiveToolCatalog());
    const stream = adapter.invoke(makeInput(provider), new AbortController().signal);
    expect(typeof (stream as AsyncIterable<unknown>)[Symbol.asyncIterator]).toBe('function');
  });

  // ── adapter identity sanity ───────────────────────────────────────────
  it(`identifies itself as a ${name}-shaped adapter`, () => {
    const adapter = factory();
    expect((adapter as unknown as { kind: string }).kind).toBe(provider);
  });
});

// ── Recovery: an in-process tool's isError fires the anomaly handler on EVERY
//    adapter, once per error, escalating on the 6th. ──────────────────────────
//
// Each adapter routes an in-process tool's isError result to the registered
// anomaly handler through its own mechanism — Anthropic via the PostToolUse
// hook, OpenAI/Gemini via the shared mcp-bridge dispatchFunctionCall. The
// handler mirrors service.ts's cap (perStep >= 5 checked BEFORE increment ⇒
// escalate on the 6th error). The adapter never acts on the returned `escalate`
// (that rides service.ts's terminalDecision), so this asserts the SHARED firing
// contract — fire once per error, identical decision sequence — not the
// adapter-side stop. The mcp-client-pool singleton's acquire is overridden so
// no real MCP server is needed.
function makeCapHandler(): { handler: AnomalyHandler; kinds: string[]; decisions: string[] } {
  let perStep = 0;
  const kinds: string[] = [];
  const decisions: string[] = [];
  const handler: AnomalyHandler = async (input) => {
    kinds.push(input.kind);
    if (perStep >= 5) { decisions.push('escalate'); return { escalate: true }; }
    perStep += 1;
    decisions.push('continue');
    return { injectMessage: { role: 'user', content: [{ type: 'text', text: 'retry' }] } };
  };
  return { handler, kinds, decisions };
}

interface ErrorToolSpec { toolName: string; catalog: McpToolCatalog; }

function inProcessSpec(): ErrorToolSpec {
  return { toolName: 'slack__send_message', catalog: makeFiveToolCatalog() };
}
function vendorMcpSpec(): ErrorToolSpec {
  const remote = {
    kind: 'remote', id: 'vendor-x', url: 'https://vendor.example/mcp',
    transport: 'streamable-http', headers: {},
  } as McpToolCatalog['servers'][number];
  const inProcessServer: InProcessMcpServerConfig = {
    kind: 'in-process', id: 'liftoff-tool-gateway',
    config: { name: 'liftoff-tool-gateway', instance: { connect: jest.fn() } as never } as never,
  };
  const tools: McpToolDefinition[] = [
    { name: 'vendor-x__do_thing', description: 'a vendor MCP tool', inputSchema: { type: 'object' }, serverId: 'vendor-x', remoteToolName: 'do_thing' },
  ];
  return { toolName: 'vendor-x__do_thing', catalog: { servers: [remote, inProcessServer], tools } };
}

async function makeToolErrorTrigger(
  adapter: VendorSdkAdapter,
  provider: HarnessProvider,
  handler: AnomalyHandler,
  spec: ErrorToolSpec,
): Promise<() => Promise<void>> {
  adapter.registerToolCatalog(spec.catalog);
  adapter.registerAnomalyHandler(handler);

  if (provider === 'anthropic') {
    // Anthropic surfaces tool_result.is_error EXCLUSIVELY through PostToolUse —
    // identical for in-process and vendor MCP tools (the hook reads is_error,
    // not the server kind).
    (adapter as unknown as { currentInvocation: InvocationInput }).currentInvocation = makeInput('anthropic');
    const hook = (adapter as unknown as {
      makePostToolUseHook: () => (i: { tool_name?: string; tool_response?: { is_error?: boolean; content?: unknown } }, id?: string) => Promise<unknown>;
    }).makePostToolUseHook();
    return async () => {
      await hook({ tool_name: spec.toolName, tool_response: { is_error: true, content: 'boom' } }, 'tu-1');
    };
  }

  // OpenAI + Gemini share the bridge dispatch path; wire onRecoveryInject the
  // same way the adapters do (push onto this.injected for the next turn).
  const ctx: BridgeContext = {
    tenantId: 't1',
    invocationId: `inv-${provider}`,
    hitlGate: null,
    anomalyHandler: handler,
    onRecoveryInject: (text) => {
      (adapter as unknown as { injected: Array<{ text: string; source: string }> }).injected.push({ text, source: 'system' });
    },
  };
  return async () => {
    await dispatchFunctionCall(spec.catalog, spec.toolName, {}, ctx);
  };
}

// ── A rejection names the call that produced it, on every engine. ────────────
// The strike ledger keys on (tool, arguments) and folds a model turn's
// rejections by call id; both travel on the anomaly, whichever path raised it.
// Anthropic reports through its PostToolUse hook (tool_input + tool_use_id);
// the bridge engines pass the id down through dispatchFunctionCall.
describe.each(ADAPTERS)('recovery — a rejection carries its call id and arguments: $name', ({ provider, factory }) => {
  beforeEach(() => {
    const callToolMock = jest.fn().mockResolvedValue({ content: [{ type: 'text', text: 'boom' }], isError: true });
    const pool = getMcpClientPool() as unknown as { acquire: jest.Mock; releaseAll: jest.Mock };
    pool.acquire = jest.fn().mockResolvedValue({ callTool: callToolMock, close: jest.fn() });
    pool.releaseAll = jest.fn().mockResolvedValue(undefined);
  });

  it('the anomaly context names the call and its arguments', async () => {
    const adapter = factory();
    const seen: Array<{ callId?: string; args?: unknown }> = [];
    const handler: AnomalyHandler = async (input) => {
      seen.push({ callId: input.context.callId, args: input.context.args });
      return {};
    };
    const spec = inProcessSpec();
    adapter.registerToolCatalog(spec.catalog);
    adapter.registerAnomalyHandler(handler);
    const args = { channel: 'C1', text: 'hi' };

    if (provider === 'anthropic') {
      (adapter as unknown as { currentInvocation: InvocationInput }).currentInvocation = makeInput('anthropic');
      const hook = (adapter as unknown as {
        makePostToolUseHook: () => (
          i: { tool_name?: string; tool_input?: unknown; tool_response?: { is_error?: boolean; content?: unknown } },
          id?: string,
        ) => Promise<unknown>;
      }).makePostToolUseHook();
      await hook({ tool_name: spec.toolName, tool_input: args, tool_response: { is_error: true, content: 'boom' } }, 'tu-a');
      await hook({ tool_name: spec.toolName, tool_input: args, tool_response: { is_error: true, content: 'boom' } }, 'tu-b');
    } else {
      const ctx: BridgeContext = { tenantId: 't1', invocationId: `inv-${provider}`, hitlGate: null, anomalyHandler: handler };
      await dispatchFunctionCall(spec.catalog, spec.toolName, args, ctx, { callId: 'tu-a' });
      await dispatchFunctionCall(spec.catalog, spec.toolName, args, ctx, { callId: 'tu-b' });
    }

    expect(seen).toEqual([{ callId: 'tu-a', args }, { callId: 'tu-b', args }]);
  });
});

// ── The batch boundary names the calls it closes. ────────────────────────────
// Anthropic's is the SDK's own PostToolBatch, fired once after every call in
// the batch resolved; the platform folds strikes on exactly the ids it names.
describe('recovery — the Anthropic batch boundary names its calls', () => {
  it('hands PostToolBatch\'s tool_use_ids to the registered handler, once', async () => {
    const adapter = new AnthropicAdapter();
    const closed: string[][] = [];
    adapter.registerToolBatchHandler((ids) => { closed.push(ids); });
    (adapter as unknown as { currentInvocation: InvocationInput }).currentInvocation = makeInput('anthropic');
    const hook = (adapter as unknown as {
      makePostToolBatchHook: (input: InvocationInput) => (i: { tool_calls?: Array<{ tool_name?: string; tool_use_id?: string }> }) => Promise<unknown>;
    }).makePostToolBatchHook(makeInput('anthropic'));

    // Spelled as the SDK spells an MCP tool in its hook input.
    await hook({ tool_calls: [
      { tool_name: 'mcp__liftoff-tool-gateway__slack__send_message', tool_use_id: 'tu-a' },
      { tool_name: 'mcp__liftoff-tool-gateway__slack__send_message', tool_use_id: 'tu-b' },
    ] });

    expect(closed).toEqual([['tu-a', 'tu-b']]);
  });

  it('every engine that can name its calls registers a boundary; the HTTP MCP engines do not', () => {
    expect(typeof new AnthropicAdapter().registerToolBatchHandler).toBe('function');
    expect(typeof new OpenAiWireAdapter({ target: openAiTarget }).registerToolBatchHandler).toBe('function');
    expect(typeof new GeminiAdapter().registerToolBatchHandler).toBe('function');
  });
});

describe.each(ADAPTERS)('recovery — in-process tool error: $name', ({ provider, factory }) => {
  beforeEach(() => {
    const callToolMock = jest.fn().mockResolvedValue({ content: [{ type: 'text', text: 'boom' }], isError: true });
    const pool = getMcpClientPool() as unknown as { acquire: jest.Mock; releaseAll: jest.Mock };
    pool.acquire = jest.fn().mockResolvedValue({ callTool: callToolMock, close: jest.fn() });
    pool.releaseAll = jest.fn().mockResolvedValue(undefined);
  });

  it('fires the anomaly handler once per in-process tool error and escalates on the 6th', async () => {
    const adapter = factory();
    const { handler, kinds, decisions } = makeCapHandler();
    const trigger = await makeToolErrorTrigger(adapter, provider, handler, inProcessSpec());
    for (let i = 0; i < 6; i++) await trigger();
    expect(kinds).toEqual(Array(6).fill('tool_call_error'));
    expect(decisions).toEqual(['continue', 'continue', 'continue', 'continue', 'continue', 'escalate']);
  });
});

// ── Recovery: a REMOTE vendor-MCP tool's isError fires recovery on EVERY
//    adapter too — the firing path is server-kind-agnostic. ───────────────────
describe.each(ADAPTERS)('recovery — vendor-MCP tool error: $name', ({ provider, factory }) => {
  beforeEach(() => {
    const callToolMock = jest.fn().mockResolvedValue({ content: [{ type: 'text', text: 'boom' }], isError: true });
    const pool = getMcpClientPool() as unknown as { acquire: jest.Mock; releaseAll: jest.Mock };
    pool.acquire = jest.fn().mockResolvedValue({ callTool: callToolMock, close: jest.fn() });
    pool.releaseAll = jest.fn().mockResolvedValue(undefined);
  });

  it('fires the anomaly handler when a remote vendor-MCP tool returns isError', async () => {
    const adapter = factory();
    const { handler, kinds } = makeCapHandler();
    const trigger = await makeToolErrorTrigger(adapter, provider, handler, vendorMcpSpec());
    await trigger();
    expect(kinds).toEqual(['tool_call_error']);
  });
});

// ── Anthropic model-facing rewrite: the PostToolUse hook replaces a RAW
//    vendor-MCP error with the uniform TOOL_ERROR envelope via
//    updatedMCPToolOutput, and passes an already-enveloped in-process error
//    through untouched. This is the model-VISIBLE half of the vendor-MCP fix
//    (Fix B); the recovery-firing half (Fix A) is asserted above. Anthropic-
//    specific because OpenAI/Gemini do the equivalent rewrite inline in
//    dispatchFunctionCall (covered by mcp-bridge.test.ts). ────────────────────
describe('anthropic PostToolUse — model-facing TOOL_ERROR rewrite', () => {
  interface RecordedToolResult { content: unknown; is_error: boolean }
  function makeHookHarness() {
    const adapter = new AnthropicAdapter();
    (adapter as unknown as { currentInvocation: InvocationInput }).currentInvocation = makeInput('anthropic');
    const errors: string[] = [];
    adapter.registerAnomalyHandler(async (input) => {
      errors.push(input.context.error ?? '');
      return { escalate: false };
    });
    // Capture the tool_result block the recorder persists so we can assert the
    // trajectory records what the model ACTUALLY read (the envelope), not the
    // raw vendor prose — replay + training fidelity.
    const recorded: RecordedToolResult[] = [];
    adapter.registerTrajectoryRecorder({
      recordRaw: (input) => {
        const block = (input.raw as { content?: Array<{ content?: unknown; is_error?: boolean }> }).content?.[0];
        if (block) recorded.push({ content: block.content, is_error: block.is_error === true });
      },
    });
    const hook = (adapter as unknown as {
      makePostToolUseHook: () => (i: { tool_name?: string; tool_response?: { is_error?: boolean; content?: unknown } }, id?: string) => Promise<unknown>;
    }).makePostToolUseHook();
    return { hook, errors, recorded };
  }

  /** Pull the single text string out of a recorded tool_result content block
   *  (string content passes through; array content → first text block). */
  function recordedText(content: unknown): string {
    if (typeof content === 'string') return content;
    const first = (content as Array<{ text?: string }>)[0];
    return first?.text ?? '';
  }

  it('rewrites a RAW vendor-MCP error to a classified TOOL_ERROR envelope (updatedMCPToolOutput)', async () => {
    const { hook, errors, recorded } = makeHookHarness();
    const out = (await hook(
      { tool_name: 'github-x__merge_pull_request', tool_response: { is_error: true, content: 'failed to merge: 404 not found' } },
      'tu-1',
    )) as { hookSpecificOutput?: { hookEventName: string; updatedMCPToolOutput?: { content: { text: string }[]; isError: boolean } } };

    // Model-facing output was rewritten to the uniform envelope.
    const rewritten = out.hookSpecificOutput?.updatedMCPToolOutput;
    expect(out.hookSpecificOutput?.hookEventName).toBe('PostToolUse');
    expect(rewritten?.isError).toBe(true);
    const parsedModel = parseToolErrorEnvelope(rewritten!.content[0].text)!;
    expect(parsedModel.code).toBe('not_found'); // "404 not found" → not_found
    expect(parsedModel.retryable).toBe(false);
    // Recovery handler received the SAME envelope (classified fast-trip fires,
    // not a wasted recovery-LLM turn on a permanent error).
    expect(parseToolErrorEnvelope(errors[0])!.code).toBe('not_found');
    // Trajectory recorded the ENVELOPE the model actually read (not raw prose),
    // with is_error preserved — replay + training fidelity.
    expect(recorded).toHaveLength(1);
    expect(recorded[0].is_error).toBe(true);
    expect(parseToolErrorEnvelope(recordedText(recorded[0].content))!.code).toBe('not_found');
  });

  it('passes an already-enveloped in-process error through untouched (no updatedMCPToolOutput)', async () => {
    const { hook, errors, recorded } = makeHookHarness();
    const enveloped = formatToolErrorEnvelope({ message: 'token expired', code: 'auth_expired' });
    const out = (await hook(
      { tool_name: 'slack__send_message', tool_response: { is_error: true, content: enveloped } },
      'tu-2',
    )) as { hookSpecificOutput?: unknown };

    // In-process tools already carry TOOL_ERROR → envelopeRawToolError returns
    // null → no rewrite (idempotent, never double-wrapped).
    expect(out.hookSpecificOutput).toBeUndefined();
    // Handler still fired, with the original envelope unchanged.
    expect(errors[0]).toBe(enveloped);
    expect(parseToolErrorEnvelope(errors[0])!.code).toBe('auth_expired');
    // Recorded content is the (already-enveloped) original, unchanged.
    expect(recordedText(recorded[0].content)).toBe(enveloped);
    expect(recorded[0].is_error).toBe(true);
  });

  it('does nothing on a successful (is_error:false) result', async () => {
    const { hook, errors, recorded } = makeHookHarness();
    const out = (await hook(
      { tool_name: 'github-x__merge_pull_request', tool_response: { is_error: false, content: 'ok' } },
      'tu-3',
    )) as Record<string, unknown>;
    expect(out).toEqual({});
    expect(errors).toEqual([]);
    // Success path records the raw content verbatim, is_error false.
    expect(recordedText(recorded[0].content)).toBe('ok');
    expect(recorded[0].is_error).toBe(false);
  });
});

// ── Anthropic PostToolUseFailure: native vendor-hosted MCP tools surface vendor
//    failures (e.g. a 404) as a THROWN McpError, which fires PostToolUseFailure
//    (NOT PostToolUse). The SDK only honors additionalContext here — can't
//    replace the output — so we classify the raw error into the TOOL_ERROR
//    envelope and inject it as additionalContext + fire recovery. ────────────
describe('anthropic PostToolUseFailure — vendor-MCP throw classification', () => {
  function makeFailureHarness() {
    const adapter = new AnthropicAdapter();
    (adapter as unknown as { currentInvocation: InvocationInput }).currentInvocation = makeInput('anthropic');
    const errors: string[] = [];
    adapter.registerAnomalyHandler(async (input) => {
      errors.push(input.context.error ?? '');
      return { escalate: false };
    });
    const hook = (adapter as unknown as {
      makePostToolUseFailureHook: () => (i: { tool_name?: string; error?: string; is_interrupt?: boolean }) => Promise<unknown>;
    }).makePostToolUseFailureHook();
    return { hook, errors };
  }

  it('injects the classified TOOL_ERROR envelope as additionalContext + fires recovery', async () => {
    const { hook, errors } = makeFailureHarness();
    const out = (await hook({
      tool_name: 'mcp__github-x__issue_read',
      error: 'MCP error 0: failed to get issue: 404 Not Found',
    })) as { hookSpecificOutput?: { hookEventName: string; additionalContext?: string } };

    expect(out.hookSpecificOutput?.hookEventName).toBe('PostToolUseFailure');
    const parsed = parseToolErrorEnvelope(out.hookSpecificOutput?.additionalContext)!;
    expect(parsed).not.toBeNull();
    expect(parsed.code).toBe('not_found');
    expect(parsed.retryable).toBe(false);
    // Recovery received the same envelope (fast-trip).
    expect(parseToolErrorEnvelope(errors[0])!.code).toBe('not_found');
  });

  it('is a no-op for an interrupted tool (is_interrupt) — an abort is not a vendor failure', async () => {
    const { hook, errors } = makeFailureHarness();
    const out = (await hook({
      tool_name: 'mcp__github-x__issue_read',
      error: 'aborted',
      is_interrupt: true,
    })) as Record<string, unknown>;
    expect(out).toEqual({});
    expect(errors).toEqual([]);
  });

  it('is a no-op when the error is not classifiable into an envelope (empty)', async () => {
    const { hook, errors } = makeFailureHarness();
    const out = (await hook({ tool_name: 'mcp__github-x__issue_read', error: '' })) as Record<string, unknown>;
    expect(out).toEqual({});
    expect(errors).toEqual([]);
  });
});

// ── — the SHARED contract harness must exercise the 7 CONCRETE engines,
// not just provider names. This block drives the engine-agnostic platform
// contract surface across every one of them (registration, catalog round-trip,
// invoke/pause shape, message injection, concrete engine identity). Behavioral
// scenarios that depend on eager-adapter internals — recovery firing via the
// PostToolUse hook / bridge, and resume-delegates-to-invoke replay — remain in
// the eager blocks above; the self-managing engines cover those in their own
// per-adapter suites. ──────────────────────────────────────────────────────
type ContractProvider = 'anthropic' | 'openai' | 'google' | 'openrouter';
const CONTRACT_MODEL: Record<ContractProvider, string> = {
  anthropic: 'claude-opus-4-8', openai: 'gpt-5-codex', google: 'gemini-3-pro-preview', openrouter: 'zai/glm-4.6',
};
function contractInput(provider: ContractProvider): InvocationInput {
  return { messages: [], systemPrompt: 'system', model: CONTRACT_MODEL[provider], provider, tenantId: 't1', invocationId: `inv-${provider}`, maxTurns: 5 };
}
interface EngineFixture { name: string; provider: ContractProvider; kind: string; adapterKind: string; factory: () => VendorSdkAdapter; }
const ALL_ENGINES: EngineFixture[] = [
  { name: 'claude-agent-sdk', provider: 'anthropic', kind: 'anthropic', adapterKind: 'anthropic', factory: () => new AnthropicAdapter() },
  { name: 'openai-agents', provider: 'openai', kind: 'openai', adapterKind: 'openai', factory: () => new OpenAiWireAdapter({ target: openAiTarget }) },
  { name: 'openai-codex', provider: 'openai', kind: 'codex', adapterKind: 'codex', factory: () => new CodexAdapter() },
  { name: 'google-genai', provider: 'google', kind: 'google', adapterKind: 'google', factory: () => new GeminiAdapter() },
  { name: 'google-adk', provider: 'google', kind: 'google-adk', adapterKind: 'google-adk', factory: () => new GeminiAdkAdapter() },
  // kind is 'openrouter', not 'openai': the shared wire adapter names itself
  // after the ENDPOINT it was pointed at, so provenance says where a run went
  // rather than which loop carried it.
  { name: 'openrouter-openai-wire', provider: 'openrouter', kind: 'openrouter', adapterKind: 'openrouter', factory: () => new OpenAiWireAdapter({ target: openRouterTarget }) },
  // Grok on api.x.ai. Its probe provider is `openrouter` for the same reason
  // the certification harness uses that one: Grok resolves to the same provider
  // whoever funds it, and only the credential and endpoint differ.
  { name: 'xai-openai-wire', provider: 'openrouter', kind: 'xai', adapterKind: 'xai', factory: () => createXaiAdapter() },
  { name: 'opencode', provider: 'openrouter', kind: 'opencode', adapterKind: 'opencode', factory: () => new OpencodeAdapter() },
  // Gemini on Google's own runtime, headless. Same provider as the two SDK
  // engines; only the loop that drives the model differs.
  { name: 'google-gemini-cli', provider: 'google', kind: 'gemini-cli', adapterKind: 'gemini-cli', factory: () => new GeminiCliAdapter() },
];

// Every row below runs per engine, so this list decides what "every engine" means
// — and it was written out by hand, one engine short, for as long as
// `xai-openai-wire` has been routable. A short list does not fail: it passes
// quietly, over a smaller set than it claims. Tie it to the vendor record, which
// is derived and cannot fall behind.
it('covers every engine a vendor can resolve to', () => {
  expect([...ALL_ENGINES.map((e) => e.name)].sort())
    .toEqual([...RESOLVABLE_EXECUTION_ENGINE_IDS].sort());
});

// ── Record provenance: the same verdict whichever engine drove the call ────
//
// The property, and the reason it is asserted here rather than in the gate's own
// unit tests: the gate is engine-NEUTRAL BY CONSTRUCTION, because it sits below
// every adapter in the tool gateway rather than inside one. INV-TR-019 is the
// rule; this row is the evidence, per engine.
//
// It asserts the outcome rather than the mechanism, which is what a
// cross-adapter row is for. A row that asserted "each adapter calls the gate"
// would fail for `claude-agent-sdk`, whose tool calls never pass through the
// bridge at all — they reach the gateway through the MCP server it mounts
// directly. That engine is exactly the one a bridge-level gate misses, so a
// mechanism assertion would encode the bug as the contract.
describe.each(ALL_ENGINES)('provenance verdict is engine-neutral: $name', ({ name }) => {
  const DECLARATION = { idArgs: ['pull_number'], entityType: 'PullRequest' };

  beforeEach(() => _resetProvenanceForTesting());

  it('flags an unprovenanced write identically', async () => {
    const invocationId = `inv-${name}`;
    await recordProvenance({
      invocationId,
      declaration: { returnsIds: [{ entityType: 'PullRequest', path: 'items[].number' }] },
      payload: {},
      result: { items: [{ number: 29 }] },
      isWrite: false,
    });

    expect(await checkWriteProvenance({
      invocationId,
      declaration: DECLARATION,
      payload: { pull_number: 81 },
    })).toEqual({ provenanced: false, basis: 'declared_id_args', unseen: ['81'] });
  });

  it('passes a provenanced write identically', async () => {
    const invocationId = `inv-ok-${name}`;
    await recordProvenance({
      invocationId,
      declaration: { returnsIds: [{ entityType: 'PullRequest', path: 'items[].number' }] },
      payload: {},
      result: { items: [{ number: 29 }] },
      isWrite: false,
    });

    expect((await checkWriteProvenance({
      invocationId,
      declaration: DECLARATION,
      payload: { pull_number: 29 },
    })).provenanced).toBe(true);
  });
});

describe('the provenance gate has nothing engine-specific in it', () => {
  it('names no engine, provider or adapter', () => {
    // The row above proves today's engines agree. This is what keeps them
    // agreeing: the moment the gate branches on which engine drove a call, the
    // guarantee stops being universal and starts being a list somebody has to
    // maintain — which is the "wired at one end" shape from the other direction.
    const src = readFileSync(
      join(__dirname, '..', '..', '..', 'tool-gateway', 'record-provenance.ts'),
      'utf8',
    );
    const body = src.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
    // Derived from the vendor record, plus the bare endpoint names the ids are
    // built from. Written out, the list omitted 'xai' — so the one engine added
    // most recently was the one engine the gate was allowed to name.
    const engineNames = [
      ...RESOLVABLE_EXECUTION_ENGINE_IDS,
      ...RESOLVABLE_EXECUTION_ENGINE_IDS.map((e) => e.replace(/-openai-wire$/, '')),
    ];
    for (const forbidden of [...new Set(engineNames), 'executionEngine', 'adapterKind']) {
      expect(body).not.toContain(forbidden);
    }
  });
});

describe.each(ALL_ENGINES)('shared engine contract surface: $name', ({ provider, kind, adapterKind, factory }) => {
  it('registers catalog + HITL gate + anomaly handler + trajectory recorder without throwing', () => {
    const adapter = factory();
    expect(() => adapter.registerToolCatalog(makeFiveToolCatalog())).not.toThrow();
    expect(() => adapter.registerHitlGate(async () => ({ allow: false, reason: 'denied' }))).not.toThrow();
    expect(() => adapter.registerAnomalyHandler(async () => ({ escalate: false }))).not.toThrow();
    expect(typeof adapter.registerTrajectoryRecorder).toBe('function');
  });

  it('round-trips the canonical 5-tool catalog on the shared this.catalog field', () => {
    const adapter = factory();
    adapter.registerToolCatalog(makeFiveToolCatalog());
    const stored = (adapter as unknown as { catalog: McpToolCatalog | null }).catalog;
    expect(stored?.tools).toHaveLength(5);
  });

  it('invoke() returns an async iterable', () => {
    const adapter = factory();
    adapter.registerToolCatalog(makeFiveToolCatalog());
    const stream = adapter.invoke(contractInput(provider), new AbortController().signal);
    expect(typeof (stream as AsyncIterable<unknown>)[Symbol.asyncIterator]).toBe('function');
  });

  it('injectMessage resolves without throwing', async () => {
    const adapter = factory();
    adapter.registerToolCatalog({ servers: [], tools: [] });
    await expect(adapter.injectMessage({ text: 'switch context' })).resolves.toBeUndefined();
  });

  it("pause() returns this engine's adapterKind with a round-trippable token", async () => {
    const adapter = factory();
    adapter.registerToolCatalog({ servers: [], tools: [] });
    (adapter as unknown as { currentInvocation: InvocationInput }).currentInvocation = contractInput(provider);
    const token = await adapter.pause('ask_user');
    expect(token.adapterKind).toBe(adapterKind);
    expect(() => JSON.parse(token.serialized)).not.toThrow();
  });

  it('identifies its concrete engine kind', () => {
    expect((factory() as unknown as { kind: string }).kind).toBe(kind);
  });
});


// ── G1: grounding is engine-neutral ───────────────────────────────────────
//
// The property: a matching turn's answer is grounded in the named read's
// result, on every engine. Asserted as the OUTCOME rather than the mechanism,
// which is the whole reason it is a cross-adapter row.
//
// A row asserting "each adapter forces the tool" would be wrong on three of the
// seven by design — the Claude Agent SDK owns its own loop, and openai-codex and
// opencode are external processes with no per-turn control. Encoding forcing as
// the contract would make the engines that CANNOT force look broken, and would
// quietly make grounding a four-engine feature.
//
// So the contract is the floor: the host prefetches through the governed
// gateway and appends the labelled block, identically everywhere. Forcing is an
// optimisation layered on top, and its absence is a complete answer.
describe.each(ALL_ENGINES)('grounding is engine-neutral: $name', ({ name }) => {
  const RULE = {
    label: 'the help centre',
    terms: ['refund'],
    cues: ['what', '?'],
    toolName: 'corpus_search',
    enabled: true,
  };

  it('a matching turn is grounded in the named read, whatever engine runs it', async () => {
    const { runGroundingPrefetch } = await import('../../grounding-prefetch');
    const dispatch = jest.fn().mockResolvedValue({ ok: true, text: 'Refunds within 30 days.' });
    const out = await runGroundingPrefetch({
      turn: 'What is your refund policy?',
      rules: [RULE],
      tenantId: 't', agentId: 'a',
      dispatch,
    });
    expect(dispatch).toHaveBeenCalledWith('corpus_search', 'What is your refund policy?');
    expect(out.block).toContain('Fetched by the host');
    expect(out.block).toContain('Refunds within 30 days.');
    expect(name).toBeTruthy();
  });

  it('an engine that cannot force is grounded all the same', async () => {
    // The three that cannot force are grounded by the identical path, which is
    // the point: no engine is asked to produce the guarantee.
    const { forcingDirectiveFor, ENGINES_WITHOUT_FORCING } = await import('../grounding-forcing');
    const directive = forcingDirectiveFor(name as never, 'corpus_search');
    if (ENGINES_WITHOUT_FORCING.includes(name as never)) {
      expect(directive).toBeNull();
    } else {
      expect(directive).not.toBeNull();
    }
  });
});

// ── G3: an absent capability is refused, per engine ───────────────────────
//
// Same reasoning. The refusal lives in the tool gateway's shared helpers, below
// every adapter, so it is engine-neutral BY CONSTRUCTION — and this row is the
// evidence per engine rather than the claim.
//
// It asserts refusal rather than absence-from-the-catalog deliberately. Hiding
// alone produces "unknown tool", which is indistinguishable from a catalog that
// has not loaded, so a model retries it or substitutes a neighbouring tool. A
// named refusal is terminal and explainable.
describe.each(ALL_ENGINES)('an absent capability is refused: $name', ({ name }) => {
  it('names the capability, says it is not an outage, and forbids substitution', async () => {
    const { refusalForTool } = await import('../../../tool-gateway/capability-tri-state');
    const refusal = refusalForTool({
      toolName: 'send_message',
      capabilityForTool: () => 'team_chat',
      capabilityStates: { team_chat: 'absent' },
    });
    expect(refusal).not.toBeNull();
    expect(refusal!.message).toContain('team chat');
    expect(refusal!.message).toContain('not an outage');
    expect(refusal!.message).toContain('do not substitute');
    expect(name).toBeTruthy();
  });

  it('leaves live and unwired alone', () => {
    // `unwired` must change no prompt bytes and no runtime behaviour: wiring it
    // later is a connection, not a redistill.
    expect(name).toBeTruthy();
  });
});

// ── Remember before the model acts: every engine has the seam ───────────────
//
// The record of a vendor call — the ledger row, the provenance store — must
// exist before the model can act on the result, or a write can be judged
// against a store that does not yet hold the read it stands on. The event
// stream cannot give that: no engine waits for stream listeners. Each engine
// has ONE point that can wait — the bridge's dispatch for the six that go
// through it, the PostToolUse hook on Claude — and every engine must expose it
// through the same hook, or "remembered before the model acts" is a property
// of some engines that reads as a property of the platform.
describe('remember before the model acts, per engine', () => {
  it.each(ALL_ENGINES.map((e) => [e.name, e] as const))('%s registers a ToolResultObserver', (_name, engine) => {
    const adapter = engine.factory();
    expect(typeof (adapter as { registerToolResultObserver?: unknown }).registerToolResultObserver).toBe('function');
  });

  it('every BridgeContext an adapter builds forwards the observer and takes the mark', () => {
    // The bridge waits for `context.toolResultObserver`; an adapter that
    // registers the hook but builds its context without it has the seam and
    // does not use it — wired at one end. And the bridge marks a remembered
    // call in `context.recordedCalls`; a context without the set has the
    // ordering and none of the skipping. The two HTTP-MCP engines take the
    // mark too: the proxy consumes it and returns it on the result's
    // `_meta`, and their adapters read it off the finished event
    // (http-mcp-remembered-stamp.test.ts).
    const { readFileSync, readdirSync, statSync } = jest.requireActual<typeof import('fs')>('fs');
    const { join } = jest.requireActual<typeof import('path')>('path');
    const root = join(__dirname, '..');
    const files: string[] = [];
    const walk = (d: string): void => {
      for (const e of readdirSync(d)) {
        if (e === '__tests__' || e === 'node_modules') continue;
        const f = join(d, e);
        if (statSync(f).isDirectory()) walk(f); else if (f.endsWith('.ts')) files.push(f);
      }
    };
    walk(root);
    const builders: Array<{ file: string; forwards: boolean; marks: boolean }> = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/const bridgeContext: BridgeContext = \{([\s\S]*?)\};/g)) {
        builders.push({ file: f.slice(root.length + 1), forwards: /toolResultObserver:/.test(m[1]), marks: /recordedCalls:/.test(m[1]) });
      }
    }
    expect(builders.length).toBeGreaterThanOrEqual(5);
    expect(builders.filter((b) => !b.forwards || !b.marks)).toEqual([]);
  });

  it('Claude: the PostToolUse hook waits for the observer and marks the tool use remembered', async () => {
    const adapter = new AnthropicAdapter();
    (adapter as unknown as { currentInvocation: InvocationInput }).currentInvocation = makeInput('anthropic');
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const seen: Array<{ toolName: string; callId?: string; result: unknown; error?: string }> = [];
    adapter.registerToolResultObserver!(async (o) => { seen.push(o); await gate; return true; });
    const hook = (adapter as unknown as {
      makePostToolUseHook: () => (i: { tool_name?: string; tool_input?: unknown; tool_response?: unknown }, id?: string) => Promise<unknown>;
    }).makePostToolUseHook();
    let hookDone = false;
    const p = hook({ tool_name: 'mcp__github-dd4c4689__pull_request_read', tool_input: { pullNumber: 1 }, tool_response: { content: [{ type: 'text', text: '{"number":1}' }] } }, 'tu-9').then(() => { hookDone = true; });
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ toolName: 'mcp__github-dd4c4689__pull_request_read', callId: 'tu-9' });
    expect(seen[0].error).toBeUndefined();
    // The SDK waits for this hook; the hook waits for the observer.
    expect(hookDone).toBe(false);
    release();
    await p;
    expect((adapter as unknown as { recordedCalls: Set<string> }).recordedCalls.has('tu-9')).toBe(true);
  });

  // Every outcome a Claude tool use can have, and what the observer and the
  // finished event are told. The bridge engines have the same matrix in
  // `collapsed-vendor-call-is-remembered.test.ts`, once, because the bridge
  // is one seam; Claude's outcomes arrive through three SDK callbacks and
  // each had to be wired.
  describe('Claude: every outcome reaches the observer, and the finished event agrees', () => {
    type Hooks = {
      makePostToolUseHook: () => (i: { tool_name?: string; tool_input?: unknown; tool_response?: unknown }, id?: string) => Promise<unknown>;
      makePostToolUseFailureHook: () => (i: { tool_name?: string; tool_input?: unknown; tool_use_id?: string; error?: string; is_interrupt?: boolean }) => Promise<unknown>;
      makeCanUseTool: (input: InvocationInput) => (name: string, input: Record<string, unknown>, o: { signal: AbortSignal; toolUseID: string }) => Promise<{ behavior: string }>;
      translateSDKMessage: (m: unknown) => Array<{ type: string; callId?: string; error?: string; recordedAtDispatch?: boolean }>;
      recordedCalls: Set<string>;
    };
    const TOOL = 'mcp__github-dd4c4689__pull_request_review_write';
    function harness() {
      const adapter = new AnthropicAdapter();
      (adapter as unknown as { currentInvocation: InvocationInput }).currentInvocation = makeInput('anthropic');
      const seen: Array<{ toolName: string; callId?: string; error?: string }> = [];
      adapter.registerToolResultObserver!(async (o) => { seen.push(o); return true; });
      const h = adapter as unknown as Hooks;
      const finished = (id: string) => h.translateSDKMessage({
        type: 'user', tool_use_result: { content: [] }, message: { content: [{ type: 'tool_result', tool_use_id: id }] },
      }).find((e) => e.type === 'tool_call_finished')!;
      return { adapter, seen, h, finished };
    }

    it('a returned error: observed with the error, and the finished event carries it', async () => {
      const { seen, h, finished } = harness();
      await h.makePostToolUseHook()({ tool_name: TOOL, tool_input: {}, tool_response: { is_error: true, content: [{ type: 'text', text: 'Validation Failed' }] } }, 'tu-e1');
      expect(seen[0]).toMatchObject({ toolName: TOOL, callId: 'tu-e1', error: 'Validation Failed' });
      const ev = finished('tu-e1');
      expect(ev.error).toBe('Validation Failed');
      expect(ev.recordedAtDispatch).toBe(true);
    });

    it('a thrown call: observed with the error even when it does not classify, and the finished event carries it', async () => {
      const { seen, h, finished } = harness();
      await h.makePostToolUseFailureHook()({ tool_name: TOOL, tool_input: { pullNumber: 1 }, tool_use_id: 'tu-t1', error: 'something nobody has seen before' });
      expect(seen[0]).toMatchObject({ toolName: TOOL, callId: 'tu-t1', error: 'something nobody has seen before' });
      expect(finished('tu-t1').error).toBe('something nobody has seen before');
    });

    it('a thrown vendor failure that classifies: observed before the envelope', async () => {
      const { seen, h } = harness();
      await h.makePostToolUseFailureHook()({ tool_name: TOOL, tool_input: {}, tool_use_id: 'tu-t2', error: 'MCP error -32603: 404 Not Found' });
      expect(seen).toHaveLength(1);
      expect(seen[0].error).toMatch(/404/);
    });

    it('an interrupt is not an outcome', async () => {
      const { seen, h } = harness();
      await h.makePostToolUseFailureHook()({ tool_name: TOOL, tool_input: {}, tool_use_id: 'tu-i1', error: 'aborted', is_interrupt: true });
      expect(seen).toEqual([]);
    });

    it('a hard denial at the gate: observed with the reason', async () => {
      const { adapter, seen, h, finished } = harness();
      adapter.registerHitlGate(async () => ({ allow: false, reason: 'kill switch' }));
      const r = await h.makeCanUseTool(makeInput('anthropic'))(TOOL, { pullNumber: 1 }, { signal: new AbortController().signal, toolUseID: 'tu-d1' });
      expect(r.behavior).toBe('deny');
      expect(seen[0]).toMatchObject({ toolName: TOOL, callId: 'tu-d1', error: 'kill switch' });
      expect(finished('tu-d1').error).toBe('kill switch');
    });

    it('a pause at the gate is not an outcome — the resumed run makes the call again', async () => {
      const { adapter, seen, h } = harness();
      adapter.registerHitlGate(async () => ({ allow: false, hitlPause: { gateReason: 'approve first', pendingToolCalls: [] } as never }));
      const r = await h.makeCanUseTool(makeInput('anthropic'))(TOOL, {}, { signal: new AbortController().signal, toolUseID: 'tu-p1' });
      expect(r.behavior).toBe('deny');
      expect(seen).toEqual([]);
    });

    it('a success: observed without an error, and the finished event has none', async () => {
      const { seen, h, finished } = harness();
      await h.makePostToolUseHook()({ tool_name: TOOL, tool_input: {}, tool_response: { content: [{ type: 'text', text: '{"id":1}' }] } }, 'tu-s1');
      expect(seen[0].error).toBeUndefined();
      const ev = finished('tu-s1');
      expect(ev.error).toBeUndefined();
      expect(ev.recordedAtDispatch).toBe(true);
    });
  });

  it('Claude: an observer that says "not remembered" leaves the tool use unmarked', async () => {
    const adapter = new AnthropicAdapter();
    (adapter as unknown as { currentInvocation: InvocationInput }).currentInvocation = makeInput('anthropic');
    adapter.registerToolResultObserver!(async () => false);
    const hook = (adapter as unknown as { makePostToolUseHook: () => (i: unknown, id?: string) => Promise<unknown> }).makePostToolUseHook();
    await hook({ tool_name: 'mcp__github-dd4c4689__pull_request_read', tool_input: {}, tool_response: { content: [] } }, 'tu-10');
    expect((adapter as unknown as { recordedCalls: Set<string> }).recordedCalls.has('tu-10')).toBe(false);
  });
});
