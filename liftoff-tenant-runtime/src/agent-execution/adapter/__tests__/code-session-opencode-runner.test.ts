// The opencode coding runner — what it invokes, what it configures, and what
// it reads back.
//
// Every assertion here is about a property that fails SILENTLY when it is
// wrong: an unregistered model is refused by opencode's bundled catalog, a
// zero context limit switches auto-compaction off, an offered `question` tool
// stops a headless turn without failing it, and a run that produced no terminal
// event is not a session that decided nothing needed changing.

import type { CodeSessionContext, RunnerInvocation } from '../tools/code-session/types';
import type { CodeSessionExecResult, CodeSessionWorkspace } from '../tools/code-session/workspace';

jest.mock('../../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const getOpenRouterApiKey = jest.fn(async () => 'or-key' as string | null);
const getXaiApiKey = jest.fn(async () => 'xai-key' as string | null);
jest.mock('../../../infrastructure/secrets', () => ({
  getOpenRouterApiKey: () => getOpenRouterApiKey(),
  getXaiApiKey: () => getXaiApiKey(),
}));

import { OpencodeCodeSessionRunner } from '../tools/code-session/runners/opencode';
import { setModelContextWindows } from '../../../llm/context-window';

/** A workspace that records the command and hands back a canned stream. */
function fakeWorkspace(stdout: string, over: Partial<CodeSessionExecResult> = {}) {
  const calls: Array<{ argv: string[]; env?: Record<string, string | undefined> }> = [];
  const workspace = {
    kind: 'sandbox' as const,
    root: '/w',
    exec: jest.fn(async (argv: string[], opts: { env?: Record<string, string | undefined> } = {}) => {
      calls.push({ argv, env: opts.env });
      return { stdout, stderr: '', exitCode: 0, timedOut: false, ...over };
    }),
    readFile: jest.fn(async () => null),
    destroy: jest.fn(async () => undefined),
  } as unknown as CodeSessionWorkspace;
  return { workspace, calls };
}

function inv(over: Partial<RunnerInvocation> = {}): RunnerInvocation {
  const context: CodeSessionContext = {
    tenantId: 't1', agentId: 'a1', invocationId: 'inv1',
    outerProvider: 'glm', outerModelId: 'z-ai/glm-5.3',
  };
  return {
    task: 'fix the failing test',
    workspaceRoot: '/w/repo',
    allowedTools: [],
    timeoutMs: 60_000,
    signal: new AbortController().signal,
    context,
    ...over,
  };
}

const ndjson = (...events: unknown[]) => events.map((e) => JSON.stringify(e)).join('\n');
/** `run --format json` emits NO terminal event — it breaks its loop on idle and
 *  signals completion by exiting 0. So the "finished cleanly" fixture is an
 *  empty stream with exitCode 0, not a sentinel line. */
const FINISHED = '';

beforeEach(() => {
  jest.clearAllMocks();
  getOpenRouterApiKey.mockResolvedValue('or-key');
  getXaiApiKey.mockResolvedValue('xai-key');
  // Keyed by FAMILY, which is how the registry files it — not by the
  // transport opencode reaches it through.
  setModelContextWindows(new Map([['glm:z-ai/glm-5.3', 1_048_576]]));
});
afterEach(() => setModelContextWindows(null));

describe('what the runner invokes', () => {
  it('runs opencode non-interactively, in the workspace checkout', async () => {
    const { workspace, calls } = fakeWorkspace(FINISHED);
    await new OpencodeCodeSessionRunner().run(inv({ workspace }));

    const argv = calls[0].argv;
    expect(argv.slice(0, 2)).toEqual(['opencode', 'run']);
    // --dir, not cwd alone: in the sandboxed family the checkout is a path in
    // another container.
    expect(argv).toEqual(expect.arrayContaining(['--dir', '/w/repo']));
    expect(argv).toEqual(expect.arrayContaining(['--model', 'openrouter/z-ai/glm-5.3']));
    expect(argv).toEqual(expect.arrayContaining(['--format', 'json']));
    expect(argv).toContain('--auto');
    // The task is the message, and it goes last so a task beginning with a dash
    // is not read as a flag.
    expect(argv[argv.length - 1]).toBe('fix the failing test');
  });

  it('passes config inline, never as a file in the checkout', async () => {
    const { workspace, calls } = fakeWorkspace(FINISHED);
    await new OpencodeCodeSessionRunner().run(inv({ workspace }));
    // An opencode.json written into the project root would come back in the
    // diff as the agent's own work.
    expect(calls[0].env?.OPENCODE_CONFIG_CONTENT).toBeTruthy();
    expect(calls[0].argv).not.toContain('--config');
  });
});

describe('the config it hands opencode', () => {
  const configOf = (calls: Array<{ env?: Record<string, string | undefined> }>) =>
    JSON.parse(calls[0].env!.OPENCODE_CONFIG_CONTENT!);

  it('registers the model, so the bundled catalog cannot reject it', async () => {
    const { workspace, calls } = fakeWorkspace(FINISHED);
    await new OpencodeCodeSessionRunner().run(inv({ workspace }));
    const cfg = configOf(calls);
    expect(cfg.provider.openrouter.models['z-ai/glm-5.3']).toBeDefined();
    expect(cfg.provider.openrouter.options.apiKey).toBe('or-key');
  });

  it('looks the window up by FAMILY, not by the transport it is reached through', async () => {
    // The registry keys a model under its family ('glm'); opencode's provider
    // id is the transport ('openrouter'). They were the same string until a
    // family became its own provider, and looking up by transport then missed
    // silently — leaving every session with no compaction limit, which is the
    // one failure this limit exists to prevent.
    setModelContextWindows(new Map([['glm:z-ai/glm-5.3', 1_048_576]]));
    const { workspace, calls } = fakeWorkspace(FINISHED);
    await new OpencodeCodeSessionRunner().run(inv({
      workspace,
      context: { ...inv().context, outerProvider: 'glm', outerModelId: 'z-ai/glm-5.3' },
    }));
    const cfg = JSON.parse(calls[0].env!.OPENCODE_CONFIG_CONTENT!);
    expect(cfg.provider.openrouter.models['z-ai/glm-5.3'].limit.context).toBe(1_048_576);
  });

  it('sends a real context limit, because 0 disables compaction outright', async () => {
    const { workspace, calls } = fakeWorkspace(FINISHED);
    await new OpencodeCodeSessionRunner().run(inv({ workspace }));
    const entry = configOf(calls).provider.openrouter.models['z-ai/glm-5.3'];
    expect(entry.limit.context).toBe(1_048_576);
    // Headroom, or compaction fires only once the window is already full.
    expect(entry.limit.output).toBeGreaterThan(0);
    expect(entry.reasoning).toBe(true);
  });

  it('omits the limit rather than guessing when no window is recorded', async () => {
    setModelContextWindows(new Map());
    const { workspace, calls } = fakeWorkspace(FINISHED);
    await new OpencodeCodeSessionRunner().run(inv({ workspace }));
    // A provider floor would compact a 1M model at 200k; opencode's own
    // snapshot value is the better fallback.
    expect(configOf(calls).provider.openrouter.models['z-ai/glm-5.3'].limit).toBeUndefined();
  });

  it('switches off `question` and nothing else', async () => {
    const { workspace, calls } = fakeWorkspace(FINISHED);
    await new OpencodeCodeSessionRunner().run(inv({ workspace }));
    const cfg = configOf(calls);
    // A tool that waits for a person stops a headless turn without failing it.
    expect(cfg.tools).toEqual({ question: false });
    expect(cfg.permission.question).toBe('deny');
    // The coding tools are the capability being delegated — denying them, as
    // the ENGINE adapter does, leaves an agent that can only discuss the repo.
    for (const t of ['bash', 'edit', 'write', 'read', 'grep', 'glob']) {
      expect(cfg.tools[t]).toBeUndefined();
    }
  });

  it('sends a Grok session to xAI on the xAI key', async () => {
    const { workspace, calls } = fakeWorkspace(FINISHED);
    await new OpencodeCodeSessionRunner().run(inv({
      workspace,
      context: { ...inv().context, outerProvider: 'xai', outerModelId: 'grok-4.6' },
    }));
    expect(calls[0].argv).toEqual(expect.arrayContaining(['--model', 'xai/grok-4.6']));
    const cfg = configOf(calls);
    expect(cfg.provider.xai.options.apiKey).toBe('xai-key');
    expect(cfg.provider.xai.options.baseURL).toBe('https://api.x.ai/v1');
    expect(getOpenRouterApiKey).not.toHaveBeenCalled();
    // The key also goes into the session's environment under the catalog's
    // name: that is what makes opencode take xAI over the Responses API rather
    // than the bundled SDK's chat completions model.
    expect(calls[0].env?.XAI_API_KEY).toBe('xai-key');
  });

  it('keeps an OpenRouter session on the config-only path', async () => {
    const { workspace, calls } = fakeWorkspace(FINISHED);
    await new OpencodeCodeSessionRunner().run(inv({ workspace }));
    expect(calls[0].env).toEqual({ OPENCODE_CONFIG_CONTENT: expect.any(String) });
  });

  it('refuses rather than running when no credential is configured', async () => {
    getOpenRouterApiKey.mockResolvedValue(null);
    const { workspace } = fakeWorkspace(FINISHED);
    const out = await new OpencodeCodeSessionRunner().run(inv({ workspace }));
    expect(out.exit_reason).toBe('error');
    expect(workspace.exec).not.toHaveBeenCalled();
  });
});

describe('what it reads back', () => {
  it('captures the summary, settled tool calls, and summed usage', async () => {
    // The real emission: {type, timestamp, sessionID, part} — flattened, not
    // nested under `properties`.
    const stdout = ndjson(
      { type: 'text', sessionID: 's1', part: { type: 'text', text: 'first pass' } },
      { type: 'tool_use', sessionID: 's1', part: { type: 'tool', tool: 'edit', callID: 'c1', state: { status: 'completed', input: { path: 'a.ts' }, output: 'ok' } } },
      { type: 'step_finish', sessionID: 's1', part: { type: 'step-finish', tokens: { input: 1000, output: 300, reasoning: 0, cache: { read: 100, write: 0 } } } },
      { type: 'text', sessionID: 's1', part: { type: 'text', text: 'fixed the test' } },
      // A SECOND step: tokens are per-step, so the session total is the sum.
      { type: 'step_finish', sessionID: 's1', part: { type: 'step-finish', tokens: { input: 200, output: 40, reasoning: 0, cache: { read: 0, write: 0 } } } },
    );
    const { workspace } = fakeWorkspace(stdout);
    const out = await new OpencodeCodeSessionRunner().run(inv({ workspace }));

    expect(out.exit_reason).toBe('success');
    expect(out.summary).toBe('fixed the test');
    expect(out.tool_calls_made).toEqual([{ tool: 'edit', args: { path: 'a.ts' }, result: 'ok' }]);
    expect(out.modelUsage).toEqual([
      { model: 'z-ai/glm-5.3', inputTokens: 1200, outputTokens: 340, cachedTokens: 100 },
    ]);
  });

  it('treats a clean exit as the terminal signal, with no event to wait for', async () => {
    // `run` consumes `session.status` idle itself and emits nothing for it. A
    // runner requiring a terminal EVENT calls every finished session unfinished
    // — the defect this suite missed by asserting the wrong shape.
    const { workspace } = fakeWorkspace(FINISHED);
    const out = await new OpencodeCodeSessionRunner().run(inv({ workspace }));
    expect(out.exit_reason).toBe('success');
  });

  it('never reports a cost of its own', async () => {
    const stdout = ndjson(
      { type: 'step_finish', sessionID: 's1', part: { type: 'step-finish', cost: 12.5, tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } } } },
    );
    const { workspace } = fakeWorkspace(stdout);
    const out = await new OpencodeCodeSessionRunner().run(inv({ workspace }));
    // opencode derives cost from the rate in the model record THIS runner
    // supplied, which carries none. The platform rate table prices the tokens.
    expect(out.modelUsage?.[0].costUsd).toBeUndefined();
    expect(out.modelUsage?.[0].inputTokens).toBe(10);
  });

  it('calls a non-zero exit an error even when the stream looked fine', async () => {
    const { workspace } = fakeWorkspace(
      ndjson({ type: 'text', sessionID: 's1', part: { type: 'text', text: 'working on it' } }),
      { exitCode: 1 },
    );
    const out = await new OpencodeCodeSessionRunner().run(inv({ workspace }));
    expect(out.exit_reason).toBe('error');
  });

  it('reports an error event, and a timeout as a timeout', async () => {
    const { workspace: w1 } = fakeWorkspace(
      ndjson({ type: 'error', sessionID: 's1', error: { name: 'ProviderAuthError', data: { message: 'bad key' } } }),
    );
    expect((await new OpencodeCodeSessionRunner().run(inv({ workspace: w1 }))).exit_reason).toBe('error');

    const { workspace: w2 } = fakeWorkspace(FINISHED, { timedOut: true });
    expect((await new OpencodeCodeSessionRunner().run(inv({ workspace: w2 }))).exit_reason).toBe('timeout');
  });
});
