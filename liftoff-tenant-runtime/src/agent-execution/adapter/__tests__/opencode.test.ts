// OpencodeAdapter unit tests. @opencode-ai/sdk is mocked so no server spawns; the
// event stream yields synthetic opencode Events and we assert mapping, session
// filtering, completion (session.idle), and HITL pause via the shared BridgeContext.

const mockStream = jest.fn();
// The adapter drives the BLOCKING prompt endpoint: it returns when the turn
// is over, which is what terminates a turn now.
const mockPrompt = jest.fn().mockResolvedValue({ data: { info: {}, parts: [] } });
const mockAbort = jest.fn().mockResolvedValue({});
const mockPermission = jest.fn().mockResolvedValue({});
// The REST backstop the adapter falls back to when the event stream dies.
const mockSessionStatus = jest.fn().mockResolvedValue({ data: {} });
const mockSessionMessages = jest.fn().mockResolvedValue({ data: [] });
const mockToolIds = jest.fn().mockResolvedValue({ data: [] });
const mockServerClose = jest.fn();
let capturedBridgeCtx: { pendingHitlGate: unknown; pendingDelegationPause: unknown } | null = null;

// The adapter starts the server through its own launcher (opencode/server.ts);
// mock that so startOpencode is our stub.
jest.mock('../opencode/server', () => ({
  startOpencode: (...a: unknown[]) => mockCreateOpencode(...a),
}));
const mockCreateOpencode = jest.fn(async (..._a: unknown[]) => ({
    client: {
      session: {
        create: jest.fn(async () => ({ data: { id: 's1' } })),
        prompt: mockPrompt,
        abort: mockAbort,
        status: mockSessionStatus,
        messages: mockSessionMessages,
      },
      event: { subscribe: jest.fn(async () => ({ stream: mockStream() })) },
      tool: { ids: mockToolIds },
      postSessionIdPermissionsPermissionId: mockPermission,
    },
    server: { url: 'http://127.0.0.1:1', close: mockServerClose },
  }));
jest.mock('../tool-gateway-http-mcp', () => ({
  exposeCatalogOverHttp: jest.fn(async (_cat: unknown, ctx: never) => {
    capturedBridgeCtx = ctx;
    return { url: 'http://127.0.0.1:2/mcp', bearerToken: 'tok', close: jest.fn().mockResolvedValue(undefined) };
  }),
}));
jest.mock('../mcp-client-pool', () => ({ getMcpClientPool: () => ({ releaseAll: jest.fn().mockResolvedValue(undefined) }) }));
const mockGetOpenRouterApiKey = jest.fn(async (): Promise<string | null> => 'test-openrouter-key');
const mockGetXaiApiKey = jest.fn(async (): Promise<string | null> => 'test-xai-key');
jest.mock('../../../infrastructure/secrets', () => ({
  getOpenRouterApiKey: () => mockGetOpenRouterApiKey(),
  getXaiApiKey: () => mockGetXaiApiKey(),
}));

import { OpencodeAdapter, liftoffMcpServerTimeoutMs } from '../opencode';
import { dispatchTimeoutMs } from '../mcp-bridge';
import { LIFTOFF_MCP_SERVER_NAME } from '../mcp-tool-names';
import { CODE_SESSION_DEFAULT_TIMEOUT_SECONDS } from '../tools/code-session/types';
import { logger } from '../../../infrastructure/logging';
import { setModelContextWindows } from '../../../llm/context-window';
import type { McpToolCatalog } from '../catalog-types';
import type { InvocationInput, InvocationEvent } from '../types';
import { makeRecorder, releaseBuffer } from '../../../trajectories/recorder';

function makeCatalog(): McpToolCatalog {
  return {
    servers: [{ kind: 'in-process', id: 'srv', config: {} } as McpToolCatalog['servers'][number]],
    tools: [{ name: 'my_tool', description: 'd', inputSchema: { type: 'object' }, serverId: 'srv' }],
  };
}
function makeInput(over: Partial<InvocationInput> = {}): InvocationInput {
  return {
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    systemPrompt: 'sys', model: 'z-ai/glm-5.2', provider: 'glm', tenantId: 't1', invocationId: 'inv1',
    ...over,
  };
}
/** The config opencode was started with, and the prompt body it was sent. */
type OpencodeConfig = {
  provider?: Record<string, { options: { apiKey: string; baseURL?: string }; models: Record<string, { reasoning: boolean; limit?: { context: number } }> }>;
  tools: Record<string, boolean>;
  permission: Record<string, string>;
};
function configOf(): OpencodeConfig {
  return (mockCreateOpencode.mock.calls[0][0] as unknown as { config: OpencodeConfig }).config;
}
/** The environment the server was started with, beyond the allow-list. */
function serverEnvOf(): Record<string, string> {
  return (mockCreateOpencode.mock.calls[0][0] as unknown as { env: Record<string, string> }).env;
}
function promptedModel(): { providerID: string; modelID: string } {
  return (mockPrompt.mock.calls[0][0] as { body: { model: { providerID: string; modelID: string } } }).body.model;
}
async function drain(it: AsyncIterable<InvocationEvent>): Promise<InvocationEvent[]> {
  const out: InvocationEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}
function stream(...evs: unknown[]) { return (async function* () { for (const e of evs) yield e; })(); }

const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => logger);

beforeEach(() => {
  warnSpy.mockClear();
  mockCreateOpencode.mockClear();
  mockGetOpenRouterApiKey.mockClear().mockResolvedValue('test-openrouter-key');
  mockGetXaiApiKey.mockClear().mockResolvedValue('test-xai-key');
  setModelContextWindows(null);
  mockStream.mockReset(); capturedBridgeCtx = null; mockAbort.mockClear();
  mockSessionStatus.mockReset().mockResolvedValue({ data: {} });
  mockSessionMessages.mockReset().mockResolvedValue({ data: [] });
  mockPrompt.mockReset().mockResolvedValue({ data: { info: {}, parts: [] } });
  mockToolIds.mockReset().mockResolvedValue({ data: [] });
});

describe('OpencodeAdapter', () => {
  // `question` asks the person something and waits for the answer. Nobody
  // answers on a headless runtime, so leaving it enabled does not fail a turn —
  // it stops one, with the server up, answering, and calling the session busy
  // until every deadline above it expires.
  it('refuses opencode\'s question tool, in both places', async () => {
    mockStream.mockReturnValueOnce(stream({ type: 'session.idle', properties: { sessionID: 's1' } }));
    const a = new OpencodeAdapter();
    a.registerToolCatalog(makeCatalog());
    await drain(a.invoke(makeInput(), new AbortController().signal));
    const cfg = mockCreateOpencode.mock.calls[0][0] as {
      config: { tools: Record<string, boolean>; permission: Record<string, string> };
    };
    expect(cfg.config.tools.question).toBe(false);
    expect(cfg.config.permission.question).toBe('deny');
  });

  it('gives the liftoff MCP server a call timeout that outlasts code_session, not the SDK\'s 60s', async () => {
    // opencode calls every tool on a server with that server's `timeout`; with
    // none, the MCP SDK's 60s default cut code_session (and anything past a
    // minute) off as -32001 while the bridge was still serving it.
    mockStream.mockReturnValueOnce(stream({ type: 'session.idle', properties: { sessionID: 's1' } }));
    const a = new OpencodeAdapter();
    a.registerToolCatalog(makeCatalog());
    await drain(a.invoke(makeInput(), new AbortController().signal));
    const cfg = mockCreateOpencode.mock.calls[0][0] as {
      config: { mcp: Record<string, { type: string; url: string; timeout?: number }> };
    };
    const server = cfg.config.mcp[LIFTOFF_MCP_SERVER_NAME];
    expect(server).toMatchObject({ type: 'remote', url: 'http://127.0.0.1:2/mcp' });
    expect(server.timeout).toBe(liftoffMcpServerTimeoutMs());
    // code_session's default budget, plus the bridge's margin, is what the
    // bridge itself waits; the engine must wait strictly longer so the bridge's
    // ceiling (a tool error the model can act on) fires first.
    expect(server.timeout).toBeGreaterThan(dispatchTimeoutMs({ timeout_seconds: CODE_SESSION_DEFAULT_TIMEOUT_SECONDS }));
    expect(server.timeout).toBeGreaterThan(dispatchTimeoutMs({}));
    expect(server.timeout).toBe(690_000);
  });

  it('forwards the run\'s turn budget as the default primary agent\'s step cap', async () => {
    // `agent.build.maxSteps` (its newer spelling `steps`, set beside it): "the
    // maximum number of agentic iterations before forcing a text-only
    // response". A prompt that names no agent runs under `build`.
    mockStream.mockReturnValueOnce(stream({ type: 'session.idle', properties: { sessionID: 's1' } }));
    const a = new OpencodeAdapter();
    a.registerToolCatalog(makeCatalog());
    await drain(a.invoke({ ...makeInput(), maxTurns: 100 }, new AbortController().signal));
    const cfg = mockCreateOpencode.mock.calls[0][0] as { config: { agent?: Record<string, { maxSteps?: number; steps?: number }> } };
    expect(cfg.config.agent).toEqual({ build: { maxSteps: 100, steps: 100 } });

    mockCreateOpencode.mockClear();
    mockStream.mockReturnValueOnce(stream({ type: 'session.idle', properties: { sessionID: 's1' } }));
    const b = new OpencodeAdapter();
    b.registerToolCatalog(makeCatalog());
    await drain(b.invoke(makeInput(), new AbortController().signal));
    const without = mockCreateOpencode.mock.calls[0][0] as { config: { agent?: unknown } };
    expect('agent' in without.config).toBe(false);
  });

  it('names a built-in the server serves that nothing has denied', async () => {
    mockToolIds.mockResolvedValue({ data: ['bash', 'question', 'brand_new_tool', 'liftoff_send_message'] });
    mockStream.mockReturnValueOnce(stream({ type: 'session.idle', properties: { sessionID: 's1' } }));
    const a = new OpencodeAdapter();
    a.registerToolCatalog(makeCatalog());
    await drain(a.invoke(makeInput(), new AbortController().signal));
    // bash and question are denied; the liftoff one is not this list's business.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ undenied: ['brand_new_tool'] }),
      expect.stringContaining('has not denied'),
    );
  });

  // The PRIMARY terminal signal, owed to nothing on the wire. Every other exit
  // here waits for an event, and the stall this replaced was a turn whose events
  // stopped while the server kept answering REST and calling the session busy.
  it('completes when the blocking prompt returns, with no terminal event at all', async () => {
    const first = { type: 'message.part.updated', properties: { part: { sessionID: 's1', type: 'text', text: 'hi' } } };
    let sent = false;
    mockStream.mockReturnValueOnce({
      [Symbol.asyncIterator]: () => ({
        next: () => {
          if (sent) return new Promise(() => {}) as Promise<IteratorResult<unknown>>;
          sent = true;
          return Promise.resolve({ value: first, done: false });
        },
        return: () => Promise.resolve({ value: undefined, done: true }),
      }),
    });
    // No session.idle, and the server would say busy if asked.
    mockSessionStatus.mockResolvedValue({ data: { s1: { type: 'busy' } } });
    const a = new OpencodeAdapter();
    a.registerToolCatalog(makeCatalog());
    const out = await drain(a.invoke(makeInput(), new AbortController().signal));
    const last = out[out.length - 1] as { type: string; outcome?: string };
    expect(last.type).toBe('completion');
    expect(last.outcome).toBe('success');
  }, 20_000);

  // The other terminal spelling. The SDK declares `session.status` carrying a
  // SessionStatus union whose members are idle / busy / retry, and a live turn
  // ended on this one: 161 events, then 174 seconds of silence against a 180
  // second budget, because only `session.idle` was recognised.
  // The event stream dying is the real failure mode, not a missing terminal
  // event: two live turns went silent for ~170 of their 180 second budget, one
  // after 161 events and one after a heartbeat. Nothing arrives, so nothing can
  // be recognised — the server has to be asked.
  it('completes when the event stream dies but the server reports the session idle', async () => {
    // A stream that yields once and then never produces again, WITHOUT ending.
    // Written as an explicit iterator rather than an async generator parked on a
    // never-resolving await: `return()` on such a generator never settles, so
    // the adapter's own cleanup would hang and the test would measure that
    // instead of the backstop.
    const first = { type: 'message.part.updated', properties: { part: { sessionID: 's1', type: 'text', text: 'hi' } } };
    let sent = false;
    mockStream.mockReturnValueOnce({
      [Symbol.asyncIterator]: () => ({
        next: () => {
          if (sent) return new Promise(() => {}) as Promise<IteratorResult<unknown>>;
          sent = true;
          return Promise.resolve({ value: first, done: false });
        },
        return: () => Promise.resolve({ value: undefined, done: true }),
      }),
    });
    mockPrompt.mockReturnValue(new Promise(() => {}));
    mockSessionStatus.mockResolvedValue({ data: { s1: { type: 'idle' } } });
    const a = new OpencodeAdapter();
    a.registerToolCatalog(makeCatalog());
    const out = await drain(a.invoke(makeInput(), new AbortController().signal));
    expect(out[out.length - 1].type).toBe('completion');
    expect((out[out.length - 1] as { outcome: string }).outcome).toBe('success');
    // The quiet-poll interval is 5s, so this test waits one of them.
  }, 20_000);

  // A server that has stopped answering is not a slow model. Told apart from
  // busy because the two need opposite responses: busy earns the rest of the
  // deadline, gone earns none of it.
  it('fails with a named reason when the server stops answering', async () => {
    const first = { type: 'message.part.updated', properties: { part: { sessionID: 's1', type: 'text', text: 'hi' } } };
    let sent = false;
    mockStream.mockReturnValueOnce({
      [Symbol.asyncIterator]: () => ({
        next: () => {
          if (sent) return new Promise(() => {}) as Promise<IteratorResult<unknown>>;
          sent = true;
          return Promise.resolve({ value: first, done: false });
        },
        return: () => Promise.resolve({ value: undefined, done: true }),
      }),
    });
    // A hung turn: the blocking prompt never returns either, which is the only
    // situation in which the backstops matter.
    mockPrompt.mockReturnValue(new Promise(() => {}));
    mockSessionStatus.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:1'));
    const a = new OpencodeAdapter();
    a.registerToolCatalog(makeCatalog());
    const out = await drain(a.invoke(makeInput(), new AbortController().signal));
    const last = out[out.length - 1] as { type: string; outcome?: string; reason?: string };
    expect(last.type).toBe('completion');
    expect(last.outcome).toBe('error');
    expect(last.reason).toContain('stopped responding');
    expect(last.reason).toContain('ECONNREFUSED');
  }, 30_000);

  it('keeps waiting when the server still reports the session busy', async () => {
    mockStream.mockReturnValueOnce((async function* () {
      yield { type: 'message.part.updated', properties: { part: { sessionID: 's1', type: 'text', text: 'hi' } } };
      yield { type: 'session.idle', properties: { sessionID: 's1' } };
    })());
    mockSessionStatus.mockResolvedValue({ data: { s1: { type: 'busy' } } });
    const a = new OpencodeAdapter();
    a.registerToolCatalog(makeCatalog());
    const out = await drain(a.invoke(makeInput(), new AbortController().signal));
    // session.idle still terminates it; busy only stops the backstop firing.
    expect(out.filter((e) => e.type === 'completion')).toHaveLength(1);
  });

  it('completes on session.status idle', async () => {
    mockStream.mockReturnValueOnce(stream(
      { type: 'message.part.updated', properties: { part: { sessionID: 's1', type: 'text', text: 'hello' } } },
      { type: 'session.status', properties: { sessionID: 's1', status: { type: 'idle' } } },
    ));
    const a = new OpencodeAdapter();
    a.registerToolCatalog(makeCatalog());
    const out = await drain(a.invoke(makeInput(), new AbortController().signal));
    expect(out[out.length - 1].type).toBe('completion');
    expect((out[out.length - 1] as { outcome: string }).outcome).toBe('success');
  });

  it('does not complete on session.status busy or retry', async () => {
    mockStream.mockReturnValueOnce(stream(
      { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } },
      { type: 'session.status', properties: { sessionID: 's1', status: { type: 'retry', attempt: 1, message: 'x', next: 1 } } },
      { type: 'session.idle', properties: { sessionID: 's1' } },
    ));
    const a = new OpencodeAdapter();
    a.registerToolCatalog(makeCatalog());
    const out = await drain(a.invoke(makeInput(), new AbortController().signal));
    // One terminal, and it is the one session.idle produced — busy and retry
    // are progress, not completion.
    expect(out.filter((e) => e.type === 'completion')).toHaveLength(1);
  });

  it('maps message.part text and completes on session.idle', async () => {
    mockStream.mockReturnValueOnce(stream(
      { type: 'message.part.updated', properties: { part: { sessionID: 's1', type: 'text', text: 'hello' } } },
      { type: 'message.part.updated', properties: { part: { sessionID: 'OTHER', type: 'text', text: 'ignore me' } } },
      { type: 'session.idle', properties: { sessionID: 's1' } },
    ));
    const a = new OpencodeAdapter();
    a.registerToolCatalog(makeCatalog());
    const out = await drain(a.invoke(makeInput(), new AbortController().signal));
    const deltas = out.filter((e) => e.type === 'assistant_delta') as Array<{ text: string }>;
    expect(deltas.map((d) => d.text)).toEqual(['hello']); // OTHER session filtered out
    expect(out[0].type).toBe('session_started');
    expect(out[out.length - 1].type).toBe('completion');
    expect((out[out.length - 1] as { outcome: string }).outcome).toBe('success');
  });

  it('sink enabled: recording opencode_part events never turns the turn into an error', async () => {
    mockStream.mockReturnValueOnce(stream(
      { type: 'message.part.updated', properties: { part: { sessionID: 's1', type: 'text', text: 'hello' } } },
      { type: 'session.idle', properties: { sessionID: 's1' } },
    ));
    const a = new OpencodeAdapter();
    a.registerToolCatalog(makeCatalog());
    const input = makeInput();
    a.registerTrajectoryRecorder(makeRecorder(input.invocationId));
    const out = await drain(a.invoke(input, new AbortController().signal));
    const last = out[out.length - 1];
    expect(last.type).toBe('completion');
    expect((last as { outcome: string }).outcome).toBe('success');
    releaseBuffer(input.invocationId);
  });

  it('emits tool_call events for tool parts', async () => {
    mockStream.mockReturnValueOnce(stream(
      { type: 'message.part.updated', properties: { part: { sessionID: 's1', type: 'tool', tool: 'my_tool', callID: 'c1', state: { status: 'running', input: { x: 1 } } } } },
      { type: 'message.part.updated', properties: { part: { sessionID: 's1', type: 'tool', tool: 'my_tool', callID: 'c1', state: { status: 'completed', output: 'ok' } } } },
      { type: 'session.idle', properties: { sessionID: 's1' } },
    ));
    const a = new OpencodeAdapter();
    a.registerToolCatalog(makeCatalog());
    const out = await drain(a.invoke(makeInput(), new AbortController().signal));
    expect(out.find((e) => e.type === 'tool_call_started')).toBeTruthy();
    expect(out.find((e) => e.type === 'tool_call_finished')).toBeTruthy();
  });

  // opencode's part events are snapshots: the text so far on every update, and
  // one event per tool state under the same call id. Each thing is said once.
  it('streams the increment of a text part, and closes it as a message when the part ends', async () => {
    mockStream.mockReturnValueOnce(stream(
      { type: 'message.part.updated', properties: { part: { id: 'p1', sessionID: 's1', type: 'text', text: 'Hel' } } },
      { type: 'message.part.updated', properties: { part: { id: 'p1', sessionID: 's1', type: 'text', text: 'Hello' } } },
      { type: 'message.part.updated', properties: { part: { id: 'p1', sessionID: 's1', type: 'text', text: 'Hello there', time: { start: 1, end: 2 } } } },
      { type: 'session.idle', properties: { sessionID: 's1' } },
    ));
    const a = new OpencodeAdapter();
    a.registerToolCatalog(makeCatalog());
    const out = await drain(a.invoke(makeInput(), new AbortController().signal));
    expect(out.filter((e) => e.type === 'assistant_delta').map((e) => (e as { text: string }).text))
      .toEqual(['Hel', 'lo', ' there']);
    const messages = out.filter((e) => e.type === 'assistant_message') as Array<{ content: Array<{ text: string }> }>;
    expect(messages.map((m) => m.content[0].text)).toEqual(['Hello there']);
  });

  it('prefers the server\'s own delta, and closes a part the turn ended on', async () => {
    mockStream.mockReturnValueOnce(stream(
      { type: 'message.part.updated', properties: { part: { id: 'p1', sessionID: 's1', type: 'text', text: 'ab' }, delta: 'ab' } },
      { type: 'message.part.updated', properties: { part: { id: 'p1', sessionID: 's1', type: 'text', text: 'abc' }, delta: 'c' } },
      { type: 'session.idle', properties: { sessionID: 's1' } },
    ));
    const a = new OpencodeAdapter();
    a.registerToolCatalog(makeCatalog());
    const out = await drain(a.invoke(makeInput(), new AbortController().signal));
    expect(out.filter((e) => e.type === 'assistant_delta').map((e) => (e as { text: string }).text)).toEqual(['ab', 'c']);
    // No time.end arrived; idle is the boundary.
    const messages = out.filter((e) => e.type === 'assistant_message') as Array<{ content: Array<{ text: string }> }>;
    expect(messages.map((m) => m.content[0].text)).toEqual(['abc']);
    // The message closes BEFORE the completion.
    expect(out.findIndex((e) => e.type === 'assistant_message')).toBeLessThan(out.findIndex((e) => e.type === 'completion'));
  });

  it('does not speak the prompt back: a user message\'s text parts are not the model\'s', async () => {
    mockStream.mockReturnValueOnce(stream(
      { type: 'message.updated', properties: { info: { id: 'm-user', sessionID: 's1', role: 'user' } } },
      { type: 'message.part.updated', properties: { part: { id: 'p-user', messageID: 'm-user', sessionID: 's1', type: 'text', text: 'pr.opened fired for PR 123' } } },
      { type: 'message.updated', properties: { info: { id: 'm-asst', sessionID: 's1', role: 'assistant' } } },
      { type: 'message.part.updated', properties: { part: { id: 'p-asst', messageID: 'm-asst', sessionID: 's1', type: 'text', text: 'On it.' } } },
      { type: 'session.idle', properties: { sessionID: 's1' } },
    ));
    const a = new OpencodeAdapter();
    a.registerToolCatalog(makeCatalog());
    const out = await drain(a.invoke(makeInput(), new AbortController().signal));
    expect(out.filter((e) => e.type === 'assistant_delta').map((e) => (e as { text: string }).text)).toEqual(['On it.']);
    const messages = out.filter((e) => e.type === 'assistant_message') as Array<{ content: Array<{ text: string }> }>;
    expect(messages.map((m) => m.content[0].text)).toEqual(['On it.']);
  });

  it('does not record the prompt as the model\'s words: a user message\'s parts never reach the recorder', async () => {
    mockStream.mockReturnValueOnce(stream(
      { type: 'message.updated', properties: { info: { id: 'm-user', sessionID: 's1', role: 'user' } } },
      { type: 'message.part.updated', properties: { part: { id: 'p-user', messageID: 'm-user', sessionID: 's1', type: 'text', text: 'Find the competitors.' } } },
      { type: 'message.updated', properties: { info: { id: 'm-asst', sessionID: 's1', role: 'assistant' } } },
      { type: 'message.part.updated', properties: { part: { id: 'p-asst', messageID: 'm-asst', sessionID: 's1', type: 'text', text: 'On it.' } } },
      { type: 'message.part.updated', properties: { part: { id: 'p-tool', messageID: 'm-asst', sessionID: 's1', type: 'tool', tool: 'liftoff_web_search', callID: 'c1', state: { status: 'running', input: { query: 'competitors' } } } } },
      { type: 'session.idle', properties: { sessionID: 's1' } },
    ));
    const a = new OpencodeAdapter();
    a.registerToolCatalog(makeCatalog());
    const recordRaw = jest.fn();
    a.registerTrajectoryRecorder({ recordRaw } as unknown as Parameters<OpencodeAdapter['registerTrajectoryRecorder']>[0]);
    await drain(a.invoke(makeInput(), new AbortController().signal));
    const recorded = recordRaw.mock.calls.map((c) => (c[0] as { raw: { type: string; properties?: { part?: { id?: string } } } }).raw);
    expect(recorded.map((r) => r.properties?.part?.id ?? r.type)).toEqual(['message.updated', 'message.updated', 'p-asst', 'p-tool', 'session.idle']);
    expect(recorded.some((r) => JSON.stringify(r).includes('Find the competitors.'))).toBe(false);
  });

  it('announces a tool call once, with its arguments, across pending → running → completed', async () => {
    mockStream.mockReturnValueOnce(stream(
      { type: 'message.part.updated', properties: { part: { sessionID: 's1', type: 'tool', tool: 'my_tool', callID: 'c1', state: { status: 'pending' } } } },
      { type: 'message.part.updated', properties: { part: { sessionID: 's1', type: 'tool', tool: 'my_tool', callID: 'c1', state: { status: 'running', input: { x: 1 } } } } },
      { type: 'message.part.updated', properties: { part: { sessionID: 's1', type: 'tool', tool: 'my_tool', callID: 'c1', state: { status: 'completed', input: { x: 1 }, output: 'ok' } } } },
      { type: 'session.idle', properties: { sessionID: 's1' } },
    ));
    const a = new OpencodeAdapter();
    a.registerToolCatalog(makeCatalog());
    const out = await drain(a.invoke(makeInput(), new AbortController().signal));
    const started = out.filter((e) => e.type === 'tool_call_started') as Array<{ callId: string; args: unknown }>;
    expect(started).toHaveLength(1);
    expect(started[0].args).toEqual({ x: 1 });
    expect(out.filter((e) => e.type === 'tool_call_finished')).toHaveLength(1);
  });

  it('announces a call that only ever arrived completed, before finishing it', async () => {
    mockStream.mockReturnValueOnce(stream(
      { type: 'message.part.updated', properties: { part: { sessionID: 's1', type: 'tool', tool: 'my_tool', callID: 'c1', state: { status: 'completed', input: { x: 2 }, output: 'ok' } } } },
      { type: 'session.idle', properties: { sessionID: 's1' } },
    ));
    const a = new OpencodeAdapter();
    a.registerToolCatalog(makeCatalog());
    const out = await drain(a.invoke(makeInput(), new AbortController().signal));
    const types = out.filter((e) => e.type === 'tool_call_started' || e.type === 'tool_call_finished').map((e) => e.type);
    expect(types).toEqual(['tool_call_started', 'tool_call_finished']);
    expect((out.find((e) => e.type === 'tool_call_started') as { args: unknown }).args).toEqual({ x: 2 });
  });

  it('reports input INCLUSIVE of the cache read, the convention every non-Anthropic row is priced under', async () => {
    // opencode's `tokens.input` excludes `cache.read`. Both planes price a
    // non-Anthropic row as fresh = input − cached, so an exclusive input on a
    // cached turn (61 fresh, 24,832 read) priced to zero fresh tokens.
    mockStream.mockReturnValueOnce(stream(
      { type: 'message.part.updated', properties: { part: { sessionID: 's1', type: 'step-finish', tokens: { input: 61, output: 42, cache: { read: 24832, write: 0 } } } } },
      { type: 'session.idle', properties: { sessionID: 's1' } },
    ));
    const a = new OpencodeAdapter();
    a.registerToolCatalog(makeCatalog());
    const out = await drain(a.invoke(makeInput(), new AbortController().signal));
    const usage = out.find((e) => e.type === 'usage') as { usage: { inputTokens: number; outputTokens: number; cachedTokens: number; contextTokens: number } };
    // And the CONTEXT is that same inclusive figure: once the input carries the
    // cached part, the prompt and the input are one number. Stated rather than
    // left to the guard's fallback — a silent agreement is not a contract.
    // `cacheWriteTokens: 0` rides along: this vendor DOES charge for a write,
    // so the absence of one is a measurement rather than an unknown.
    expect(usage.usage).toEqual({ inputTokens: 24893, outputTokens: 42, cachedTokens: 24832, contextTokens: 24893, cacheWriteTokens: 0 });
  });

  it('counts reasoning tokens as completion tokens, because that is what the vendor bills', async () => {
    // opencode reports reasoning in its OWN field while every vendor bills it at
    // the completion rate inside its own completion count. Reading `output`
    // alone charges for the visible answer and nothing for the thinking that
    // produced it — which on a reasoning model is nearly the whole call.
    //
    // These are the real numbers from a dev turn: a one-word reply on
    // qwen3.7-plus. OpenRouter charged $0.01822318; the 3 output tokens alone
    // priced it at $0.01052768, or 58% of the charge.
    mockStream.mockReturnValueOnce(stream(
      { type: 'message.part.updated', properties: { part: { sessionID: 's1', type: 'step-finish', cost: 0, tokens: { input: 32887, output: 3, reasoning: 6012, cache: { read: 0, write: 0 } } } } },
      { type: 'session.idle', properties: { sessionID: 's1' } },
    ));
    const a = new OpencodeAdapter();
    a.registerToolCatalog(makeCatalog());
    const out = await drain(a.invoke(makeInput(), new AbortController().signal));
    const usage = out.find((e) => e.type === 'usage') as { usage: Record<string, unknown> };
    expect(usage.usage.outputTokens).toBe(6015);
    expect(usage.usage.inputTokens).toBe(32887);
  });

  it('carries the gateway charge on vendorCostUsd, and a zero cost stays undefined', async () => {
    // `cost` is a required field on opencode's step-finish part. For a
    // gateway-served model it is the only figure that can be right, so it must
    // reach the pricing path. A ZERO is not a charge: undefined means "price it
    // from the rate table", and booking zero would un-bill the call.
    mockStream.mockReturnValueOnce(stream(
      { type: 'message.part.updated', properties: { part: { sessionID: 's1', type: 'step-finish', cost: 0.01822318, tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } } } } },
      { type: 'message.part.updated', properties: { part: { sessionID: 's1', type: 'step-finish', cost: 0, tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } } } } },
      { type: 'session.idle', properties: { sessionID: 's1' } },
    ));
    const a = new OpencodeAdapter();
    a.registerToolCatalog(makeCatalog());
    const out = await drain(a.invoke(makeInput(), new AbortController().signal));
    const usages = out.filter((e) => e.type === 'usage') as Array<{ usage: Record<string, unknown> }>;
    expect(usages).toHaveLength(2);
    expect(usages[0].usage.vendorCostUsd).toBe(0.01822318);
    expect(usages[1].usage.vendorCostUsd).toBeUndefined();
  });

  it('carries the cache WRITE count, which is billed at a different rate from the read', async () => {
    mockStream.mockReturnValueOnce(stream(
      { type: 'message.part.updated', properties: { part: { sessionID: 's1', type: 'step-finish', cost: 0, tokens: { input: 61, output: 42, reasoning: 0, cache: { read: 24832, write: 4096 } } } } },
      { type: 'session.idle', properties: { sessionID: 's1' } },
    ));
    const a = new OpencodeAdapter();
    a.registerToolCatalog(makeCatalog());
    const out = await drain(a.invoke(makeInput(), new AbortController().signal));
    const usage = out.find((e) => e.type === 'usage') as { usage: Record<string, unknown> };
    expect(usage.usage.cacheWriteTokens).toBe(4096);
    expect(usage.usage.cachedTokens).toBe(24832);
    // And the write is NOT folded into the inclusive input, which already carries
    // the read: doing so would price it at the read's rate.
    expect(usage.usage.inputTokens).toBe(24893);
  });

  it('still reports the charge when the step carries a cost and no token counts', async () => {
    // The guard used to be `if (tokens)`, so a step that priced itself without
    // reporting counts was dropped whole — charge included.
    mockStream.mockReturnValueOnce(stream(
      { type: 'message.part.updated', properties: { part: { sessionID: 's1', type: 'step-finish', cost: 0.004 } } },
      { type: 'session.idle', properties: { sessionID: 's1' } },
    ));
    const a = new OpencodeAdapter();
    a.registerToolCatalog(makeCatalog());
    const out = await drain(a.invoke(makeInput(), new AbortController().signal));
    const usage = out.find((e) => e.type === 'usage') as { usage: Record<string, unknown> };
    expect(usage.usage.vendorCostUsd).toBe(0.004);
    expect(usage.usage.outputTokens).toBe(0);
  });

  it('surfaces a session.error as completion error, never empty success (usage/billing)', async () => {
    mockStream.mockReturnValueOnce(stream(
      { type: 'message.part.updated', properties: { part: { sessionID: 's1', type: 'text', text: 'x' } } },
      { type: 'session.error', properties: { sessionID: 's1', error: 'boom' } },
    ));
    const a = new OpencodeAdapter();
    a.registerToolCatalog(makeCatalog());
    const out = await drain(a.invoke(makeInput(), new AbortController().signal));
    const last = out[out.length - 1] as { type: string; outcome: string };
    expect(last.type).toBe('completion');
    expect(last.outcome).toBe('error');
  });

  // A bridge abort — recovery declined another attempt at a call — ends the
  // turn at once, with the bridge's reason. Before this the loop read only the
  // outer signal: the session ran on with its tool parts stranded until the
  // 180 s deadline, and the completion said "opencode stopped after N events".
  it('ends the turn on a bridge abort, with the recovery reason, without waiting for the deadline', async () => {
    mockPrompt.mockReturnValueOnce(new Promise(() => { /* the turn never returns on its own */ }));
    mockStream.mockReturnValueOnce((async function* () {
      yield { type: 'message.part.updated', properties: { part: { sessionID: 's1', type: 'text', text: 'x' } } };
      if (capturedBridgeCtx) {
        const ctx = capturedBridgeCtx as unknown as { recoveryAbortReason?: string | null; abort?: () => void };
        ctx.recoveryAbortReason = 'run stopped after "my_tool" failed and recovery declined another attempt: nope';
        ctx.abort?.();
      }
      // A quiet stream from here on: only heartbeats, which must not be
      // needed for the abort to be seen.
      yield { type: 'server.heartbeat', properties: {} };
    })());
    const a = new OpencodeAdapter();
    a.registerToolCatalog(makeCatalog());
    const started = Date.now();
    const out = await drain(a.invoke(makeInput(), new AbortController().signal));
    const last = out[out.length - 1] as { type: string; outcome?: string; reason?: string };
    expect(last.type).toBe('completion');
    expect(last.outcome).toBe('error');
    expect(last.reason).toMatch(/recovery declined another attempt/);
    expect(mockAbort).toHaveBeenCalled();
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('pauses on HITL when the proxy sets pendingHitlGate, and aborts the session', async () => {
    mockStream.mockReturnValueOnce((async function* () {
      yield { type: 'message.part.updated', properties: { part: { sessionID: 's1', type: 'text', text: 'x' } } };
      if (capturedBridgeCtx) capturedBridgeCtx.pendingHitlGate = { gateReason: 'approve', pendingToolCalls: [] };
      yield { type: 'message.part.updated', properties: { part: { sessionID: 's1', type: 'text', text: 'y' } } };
    })());
    const a = new OpencodeAdapter();
    a.registerToolCatalog(makeCatalog());
    const out = await drain(a.invoke(makeInput(), new AbortController().signal));
    const last = out[out.length - 1];
    expect(last.type).toBe('pause_requested');
    expect((last as { reason: string }).reason).toBe('hitl_gate');
    expect(mockAbort).toHaveBeenCalled();
  });

  // This expectation is INVERTED from what it was, and the inversion is the fix.
  //
  // It used to assert `response: 'once'` — auto-approval — matching a comment
  // that said "the Liftoff gate already ran in the httpMcp proxy". The gate had
  // not run. That proxy carries the Liftoff catalog, where dispatchFunctionCall
  // applies the HITL gate, oversight, framing, metering and the single-result
  // bound; opencode raises a permission prompt only for its OWN built-ins,
  // which never touch the proxy. The prompt existed *because* nothing had
  // gated the call.
  //
  // So approving it waved through an ungoverned shell running as root in the
  // runtime's container under the runtime's service account — and `read` alone
  // reached /proc and the application source without needing one. The test
  // passed the whole time, because it asserted the behaviour rather than the
  // property.
  it('REFUSES opencode native permission prompts', async () => {
    mockStream.mockReturnValueOnce(stream(
      { type: 'permission.updated', properties: { id: 'perm1', sessionID: 's1' } },
      { type: 'session.idle', properties: { sessionID: 's1' } },
    ));
    const a = new OpencodeAdapter();
    a.registerToolCatalog(makeCatalog());
    await drain(a.invoke(makeInput(), new AbortController().signal));
    expect(mockPermission).toHaveBeenCalledWith(expect.objectContaining({
      path: { id: 's1', permissionID: 'perm1' }, body: { response: 'reject' },
    }));
  });
});

// One engine, two hosts. Which one a run goes to is decided by the resolved
// provider, and everything opencode is told has to agree with that decision:
// the provider block it is configured with, the provider the prompt names the
// model under, the id the model is registered as, and the family its metadata
// is looked up by. These fail separately and silently — a model registered
// under the wrong transport is "Model not found", a window looked up under the
// transport instead of the family is a session with no compaction limit — so
// each is asserted on its own.
describe('the transport opencode is configured with', () => {
  const idle = () => mockStream.mockReturnValueOnce(stream({ type: 'session.idle', properties: { sessionID: 's1' } }));

  it('sends an open-weights family to OpenRouter on Liftoff\'s OpenRouter key', async () => {
    idle();
    const a = new OpencodeAdapter();
    a.registerToolCatalog(makeCatalog());
    await drain(a.invoke(makeInput({ provider: 'glm', model: 'z-ai/glm-5.2' }), new AbortController().signal));
    const cfg = configOf();
    expect(Object.keys(cfg.provider!)).toEqual(['openrouter']);
    expect(cfg.provider!.openrouter.options).toEqual({ apiKey: 'test-openrouter-key' });
    expect(cfg.provider!.openrouter.models['z-ai/glm-5.2']).toBeDefined();
    expect(promptedModel()).toEqual({ providerID: 'openrouter', modelID: 'z-ai/glm-5.2' });
    expect(mockGetXaiApiKey).not.toHaveBeenCalled();
    // OpenRouter stays on the config-only path; nothing of it goes into the
    // server's environment.
    expect(serverEnvOf()).toEqual({});
  });

  it('sends an open-weights family through the GATEWAY when the run opened a session', async () => {
    // Not about who pays: nobody but Liftoff ever pays for these, the invoice is
    // ours and the keys card offers no OpenRouter field. It is about what this
    // engine can SEE — its `step-finish` completion count excludes the reasoning
    // the vendor bills, and the vendor's own figure is on the HTTP response, which
    // only the gateway reads.
    idle();
    const a = new OpencodeAdapter();
    a.registerToolCatalog(makeCatalog());
    await drain(a.invoke(makeInput({
      provider: 'glm', model: 'z-ai/glm-5.3',
      byok: {
        mode: 'managed_gateway', vendor: 'openrouter',
        baseUrl: 'https://gateway.example/byok/openrouter/', token: 'per-run-token',
        rerouteToVendorApi: false,
      },
    }), new AbortController().signal));
    const cfg = configOf();
    // Still the OpenRouter transport and still OpenRouter's own model id — only
    // the host and the credential move. A model registered under another
    // transport is "Model not found".
    expect(Object.keys(cfg.provider!)).toEqual(['openrouter']);
    expect(cfg.provider!.openrouter.options).toEqual({
      apiKey: 'per-run-token',
      baseURL: 'https://gateway.example/byok/openrouter/v1',
    });
    expect(cfg.provider!.openrouter.models['z-ai/glm-5.3']).toBeDefined();
    expect(promptedModel()).toEqual({ providerID: 'openrouter', modelID: 'z-ai/glm-5.3' });
    // Liftoff's OpenRouter key stays in the control plane, which holds it and
    // attaches it on the far side. The token here is only good at the gateway.
    expect(mockGetOpenRouterApiKey).not.toHaveBeenCalled();
    expect(mockGetXaiApiKey).not.toHaveBeenCalled();
    // OpenRouter stays on the config-only path it has always run on.
    expect(serverEnvOf()).toEqual({});
  });

  it('sends a managed Grok run to xAI on Liftoff\'s xAI key, under xAI\'s own model id', async () => {
    idle();
    const a = new OpencodeAdapter();
    a.registerToolCatalog(makeCatalog());
    await drain(a.invoke(makeInput({ provider: 'xai', model: 'x-ai/grok-4.6' }), new AbortController().signal));
    const cfg = configOf();
    expect(Object.keys(cfg.provider!)).toEqual(['xai']);
    expect(cfg.provider!.xai.options).toEqual({ apiKey: 'test-xai-key', baseURL: 'https://api.x.ai/v1' });
    // OpenRouter's slug 404s at api.x.ai; the model is registered and prompted
    // under the id xAI serves.
    expect(cfg.provider!.xai.models['grok-4.6']).toBeDefined();
    expect(cfg.provider!.xai.models['x-ai/grok-4.6']).toBeUndefined();
    expect(promptedModel()).toEqual({ providerID: 'xai', modelID: 'grok-4.6' });
    expect(mockGetOpenRouterApiKey).not.toHaveBeenCalled();
    // The key also reaches the server's environment under the catalog's name,
    // which is what makes opencode take xAI over the Responses API rather than
    // the bundled SDK's chat completions model.
    expect(serverEnvOf()).toEqual({ XAI_API_KEY: 'test-xai-key' });
  });

  it('sends a customer-funded Grok run to the gateway on the per-run token', async () => {
    idle();
    const a = new OpencodeAdapter();
    a.registerToolCatalog(makeCatalog());
    await drain(a.invoke(makeInput({
      provider: 'xai', model: 'grok-4.3',
      byok: { mode: 'byok', vendor: 'xai', baseUrl: 'https://gateway.example/byok/xai/', token: 'per-run-token', rerouteToVendorApi: true },
    }), new AbortController().signal));
    const cfg = configOf();
    // The token is only good at the gateway, so the host moves with it — and
    // Liftoff's own xAI key is never read for a run the customer is paying for.
    expect(cfg.provider!.xai.options).toEqual({ apiKey: 'per-run-token', baseURL: 'https://gateway.example/byok/xai/v1' });
    expect(promptedModel()).toEqual({ providerID: 'xai', modelID: 'grok-4.3' });
    expect(mockGetXaiApiKey).not.toHaveBeenCalled();
    expect(mockGetOpenRouterApiKey).not.toHaveBeenCalled();
    // The environment copy is the same per-run token, never Liftoff's key.
    expect(serverEnvOf()).toEqual({ XAI_API_KEY: 'per-run-token' });
  });

  it('looks the window up by FAMILY, not by the transport it is reached through', async () => {
    // The registry keys a model under its family ('glm'); opencode's provider
    // id is the transport ('openrouter'). Looked up by transport, the window
    // silently misses and the session runs with no compaction limit.
    setModelContextWindows(new Map([['glm:z-ai/glm-5.2', 1_048_576]]));
    idle();
    const a = new OpencodeAdapter();
    a.registerToolCatalog(makeCatalog());
    await drain(a.invoke(makeInput({ provider: 'glm', model: 'z-ai/glm-5.2' }), new AbortController().signal));
    expect(configOf().provider!.openrouter.models['z-ai/glm-5.2'].limit?.context).toBe(1_048_576);
  });

  it('registers a Grok entry with its own recorded window', async () => {
    setModelContextWindows(new Map([['xai:grok-4.6', 2_000_000]]));
    idle();
    const a = new OpencodeAdapter();
    a.registerToolCatalog(makeCatalog());
    await drain(a.invoke(makeInput({ provider: 'xai', model: 'grok-4.6' }), new AbortController().signal));
    expect(configOf().provider!.xai.models['grok-4.6'].limit?.context).toBe(2_000_000);
  });

  it('does not mark the non-reasoning Grok tier as reasoning-capable', async () => {
    idle();
    const a = new OpencodeAdapter();
    a.registerToolCatalog(makeCatalog());
    await drain(a.invoke(makeInput({ provider: 'xai', model: 'grok-4.20-0309-non-reasoning' }), new AbortController().signal));
    const models = configOf().provider!.xai.models;
    expect(models['grok-4.20-0309-non-reasoning'].reasoning).toBe(false);
  });

  it('marks the reasoning Grok tiers as reasoning-capable', async () => {
    idle();
    const a = new OpencodeAdapter();
    a.registerToolCatalog(makeCatalog());
    await drain(a.invoke(makeInput({ provider: 'xai', model: 'grok-4.6' }), new AbortController().signal));
    expect(configOf().provider!.xai.models['grok-4.6'].reasoning).toBe(true);
  });
});
