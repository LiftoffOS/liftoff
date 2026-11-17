// Which model a nested coding session runs on.
//
// The default must stay the VENDOR's own: Claude Code's CLI default, the model
// Codex fetches from its own manifest. Those are chosen for coding, and the
// outer agent's reasoning model has no business overriding them. What was
// broken is narrower — a model an operator DELIBERATELY pinned was accepted by
// the OpenRouter runner and silently discarded by the other two, so the same
// tool answered the same configuration three different ways.
//
// The cross-vendor guard is the part with teeth: `prefer_provider` can send a
// session to a different vendor than the outer agent runs on, and a model id
// only means something to the vendor that publishes it. Handing Codex a Claude
// id is the failure that once sent `claude-sonnet-4-6` to OpenRouter.

import type { CodeSessionContext, CodeSessionInput, RunnerInvocation } from '../tools/code-session/types';

// ESM-only; the classic Jest resolver cannot load sdk.mjs. Same treatment the
// other adapter suites give it — the runner's `run` is spied on anyway, so the
// real SDK is never exercised here.
jest.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: jest.fn() }));

jest.mock('../../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const getTaskModelOverride = jest.fn();
jest.mock('../../../entitlements-client/service', () => ({
  getEntitlementsClient: () => ({ getTaskModelOverride }),
}));

jest.mock('../../../tenant-runtime-config/service', () => ({
  getTenantRuntimeConfig: jest.fn(async () => ({ trajectoryCaptureNestedCodeSessions: false })),
}));

jest.mock('node:fs/promises', () => ({
  mkdtemp: jest.fn(async () => '/tmp/code-session-under-test'),
  readFile: jest.fn(async () => { throw new Error('no preset in this repo'); }),
  rm: jest.fn(async () => undefined),
}));

// promisify(execFile) with no custom symbol resolves to whatever the callback's
// second argument is, so hand back the {stdout,stderr} shape the handler reads.
jest.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => {
    const cb = args.find((a) => typeof a === 'function') as ((_e: unknown, _v: unknown) => void) | undefined;
    cb?.(null, { stdout: '', stderr: '' });
  },
}));

import { codeSessionHandler } from '../tools/code-session';
import { AnthropicCodeSessionRunner } from '../tools/code-session/runners/anthropic';
import { OpenAICodeSessionRunner } from '../tools/code-session/runners/openai';
import { OpenRouterCodeSessionRunner } from '../tools/code-session/runners/openrouter';

const EMPTY_RUN = {
  summary: '',
  tool_calls_made: [],
  exit_reason: 'success' as const,
};

function baseContext(overrides: Partial<CodeSessionContext> = {}): CodeSessionContext {
  return {
    tenantId: 't1',
    agentId: 'a1',
    invocationId: 'inv1',
    outerProvider: 'anthropic',
    ...overrides,
  };
}

const INPUT: CodeSessionInput = { task: 'do a thing', repo: 'owner/repo', branch: 'main' };

/** Run the handler and hand back the RunnerInvocation each runner received. */
async function invocationSeenBy(
  runnerProto: { prototype: { run: (_inv: RunnerInvocation) => Promise<unknown> } },
  input: CodeSessionInput,
  context: CodeSessionContext,
): Promise<RunnerInvocation> {
  const spy = jest.spyOn(runnerProto.prototype, 'run').mockResolvedValue(EMPTY_RUN);
  await codeSessionHandler(input, context);
  expect(spy).toHaveBeenCalledTimes(1);
  return spy.mock.calls[0][0];
}

describe('code_session model resolution', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    getTaskModelOverride.mockReset();
    getTaskModelOverride.mockResolvedValue(null);
  });

  it('passes NO model when nothing is pinned — the vendor default stands', async () => {
    const inv = await invocationSeenBy(AnthropicCodeSessionRunner, INPUT, baseContext());
    expect(inv.model).toBeUndefined();
  });

  it('does not treat the resolved outer model as a pin', async () => {
    // outerModelId is ALWAYS populated (it falls back to the workspace default
    // and then the tier table), so using it here would silently replace every
    // vendor default with the outer agent's reasoning model.
    const inv = await invocationSeenBy(
      AnthropicCodeSessionRunner,
      INPUT,
      baseContext({ outerModelId: 'claude-sonnet-4-6' }),
    );
    expect(inv.model).toBeUndefined();
  });

  it('honors a deliberate per-agent pin', async () => {
    const inv = await invocationSeenBy(
      AnthropicCodeSessionRunner,
      INPUT,
      baseContext({ explicitModelId: 'claude-opus-5' }),
    );
    expect(inv.model).toBe('claude-opus-5');
  });

  it('DROPS a pin when prefer_provider sends the session to another vendor', async () => {
    // The regression this guard exists for: a Claude id reaching Codex.
    const inv = await invocationSeenBy(
      OpenAICodeSessionRunner,
      { ...INPUT, prefer_provider: 'openai' },
      baseContext({ outerProvider: 'anthropic', explicitModelId: 'claude-opus-5' }),
    );
    expect(inv.model).toBeUndefined();
  });

  it('honors a workspace code_session override for the matching vendor', async () => {
    getTaskModelOverride.mockResolvedValue({ model: 'claude-opus-5', provider: 'anthropic' });
    const inv = await invocationSeenBy(AnthropicCodeSessionRunner, INPUT, baseContext());
    expect(inv.model).toBe('claude-opus-5');
    expect(getTaskModelOverride).toHaveBeenCalledWith('t1', 'code_session');
  });

  it('drops a workspace override belonging to another vendor', async () => {
    getTaskModelOverride.mockResolvedValue({ model: 'gpt-5.5', provider: 'openai' });
    const inv = await invocationSeenBy(AnthropicCodeSessionRunner, INPUT, baseContext());
    expect(inv.model).toBeUndefined();
  });

  it('prefers the per-agent pin over the workspace override', async () => {
    getTaskModelOverride.mockResolvedValue({ model: 'claude-haiku-4-5', provider: 'anthropic' });
    const inv = await invocationSeenBy(
      AnthropicCodeSessionRunner,
      INPUT,
      baseContext({ explicitModelId: 'claude-opus-5' }),
    );
    expect(inv.model).toBe('claude-opus-5');
  });

  it('survives a routing lookup failure with the vendor default', async () => {
    // A routing lookup that throws means we could not learn about a pin. No pin
    // is the normal case, so the session must still run.
    getTaskModelOverride.mockRejectedValue(new Error('control plane unreachable'));
    const inv = await invocationSeenBy(AnthropicCodeSessionRunner, INPUT, baseContext());
    expect(inv.model).toBeUndefined();
  });
});

/** Exposes the protected hook so the runner-side half of the wiring is testable
 *  without standing up the ESM-only Codex SDK. */
class ProbeCodex extends OpenAICodeSessionRunner {
  public probe(inv: RunnerInvocation): string | undefined { return this.threadModel(inv); }
}
class ProbeOpenRouter extends OpenRouterCodeSessionRunner {
  public probe(inv: RunnerInvocation): string | undefined { return this.threadModel(inv); }
}

describe('runner threadModel wiring', () => {
  const inv = (over: Partial<RunnerInvocation>): RunnerInvocation => ({
    task: 't',
    workspaceRoot: '/tmp/x',
    allowedTools: [],
    timeoutMs: 1000,
    signal: new AbortController().signal,
    context: baseContext(),
    ...over,
  });

  it('Codex runs its own default unless a model was resolved', () => {
    expect(new ProbeCodex().probe(inv({}))).toBeUndefined();
    expect(new ProbeCodex().probe(inv({ model: 'gpt-5.5' }))).toBe('gpt-5.5');
  });

  it('OpenRouter prefers a pin over its vendor-prefix default', () => {
    const context = baseContext({ outerProvider: 'openrouter', outerModelId: 'qwen/qwen3.7-plus' });
    // No pin → the vendor-matched large coding model, under the DATED slug
    // OpenRouter publishes it as (there is no bare `qwen/qwen3.8-max`).
    expect(new ProbeOpenRouter().probe(inv({ context }))).toBe('qwen/qwen3.8-max-0902');
    // A pin outranks the derived default.
    expect(new ProbeOpenRouter().probe(inv({ context, model: 'qwen/qwen3-coder-plus' })))
      .toBe('qwen/qwen3-coder-plus');
  });
});
