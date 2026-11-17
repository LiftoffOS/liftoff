// Where a Grok coding session goes, and what it is billed as.
//
// Grok has no coding CLI of its own, so it shares the 'openrouter' runner — the
// same Codex binary. It does NOT share the host: it codes on xAI's own API, the
// one its turns already run on. Three things follow that host and each fails
// differently if it is left behind — the id namespace (a 404), the rate key (a
// silent zero), and the credential (an OpenRouter key cannot buy xAI tokens).
//
// The routing half is a regression guard. `resolveProvider` carried a second
// switch over the outer-provider union and 'xai' was added to only one of them,
// so a Grok agent resolved to `undefined` and no runner was ever found. With
// `strictNullChecks` off, nothing in the build said so.

import type { CodeSessionContext, CodeSessionInput, RunnerInvocation } from '../tools/code-session/types';

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

const persistUsageEvent = jest.fn(async () => undefined);
jest.mock('../../../llm/usage-tracker', () => ({ persistUsageEvent: (e: unknown) => persistUsageEvent(e as never) }));

const mkdtemp = jest.fn(async () => '/tmp/code-session-under-test');
jest.mock('node:fs/promises', () => ({
  mkdtemp: (...a: unknown[]) => mkdtemp(...(a as [])),
  readFile: jest.fn(async () => { throw new Error('no preset in this repo'); }),
  rm: jest.fn(async () => undefined),
}));

jest.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => {
    const cb = args.find((a) => typeof a === 'function') as ((_e: unknown, _v: unknown) => void) | undefined;
    cb?.(null, { stdout: '', stderr: '' });
  },
}));

import { codeSessionHandler, runnerFor } from '../tools/code-session';
import { OpencodeCodeSessionRunner } from '../tools/code-session/runners/opencode';
import { SandboxedOpenRouterCodeSessionRunner } from '../tools/code-session/runners/sandboxed';
import {
  OpenRouterCodeSessionRunner,
  codeModelForSession,
  isGrokCodeSession,
  usesXaiHost,
  xaiCodeSessionBaseUrl,
} from '../tools/code-session/runners/openrouter';
import { LocalCodeSessionWorkspace } from '../tools/code-session/workspace';
import { providerForModel, providerForStoredName } from '../../provider-resolution';

const EMPTY_RUN = { summary: '', tool_calls_made: [], exit_reason: 'success' as const };
const INPUT: CodeSessionInput = { task: 'do a thing', repo: 'owner/repo', branch: 'main' };

function ctx(over: Partial<CodeSessionContext> = {}): CodeSessionContext {
  return { tenantId: 't1', agentId: 'a1', invocationId: 'inv1', outerProvider: 'anthropic', ...over };
}

/** Exposes the protected hook, as the sibling suite does. */
class ProbeOpenRouter extends OpenRouterCodeSessionRunner {
  public probe(inv: RunnerInvocation): string | undefined { return this.threadModel(inv); }
}
const inv = (over: Partial<RunnerInvocation>): RunnerInvocation => ({
  task: 't',
  workspaceRoot: '/tmp/x',
  allowedTools: [],
  timeoutMs: 1000,
  signal: new AbortController().signal,
  context: ctx(),
  ...over,
});

describe('a Grok agent calling code_session', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    mkdtemp.mockClear();
    persistUsageEvent.mockClear();
    getTaskModelOverride.mockReset();
    getTaskModelOverride.mockResolvedValue(null);
  });

  it('resolves to provider "xai" in the first place', () => {
    // Both stored shapes reach it: a config that says xai, and a legacy one
    // still saying openrouter with a Grok model id. The legacy shape is
    // translated by name now, because 'openrouter' is not a provider the
    // runtime resolves — it was four families under one label.
    expect(providerForStoredName('openrouter', 'grok-4.6')).toBe('xai');
    expect(providerForModel('xai', 'grok-4.6')).toBe('xai');
  });

  it('reaches the openrouter runner rather than falling off the switch', async () => {
    const spy = jest.spyOn(OpenRouterCodeSessionRunner.prototype, 'run').mockResolvedValue(EMPTY_RUN);
    await codeSessionHandler(INPUT, ctx({ outerProvider: 'xai', outerModelId: 'grok-4.6' }));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('codes with Grok, not with the GLM fallback', () => {
    const context = ctx({ outerProvider: 'xai', outerModelId: 'grok-4.6' });
    expect(codeModelForSession(context)).toBe('grok-4.6');
    // Even with no model id at all — the provider alone settles it.
    expect(codeModelForSession(ctx({ outerProvider: 'xai' }))).toBe('grok-4.6');
    expect(isGrokCodeSession(context)).toBe(true);
  });

  it('names the model natively and talks to xAI, on Liftoff\'s own key', () => {
    const context = ctx({ outerProvider: 'xai', outerModelId: 'grok-4.6' });
    expect(usesXaiHost(inv({ context }))).toBe(true);
    expect(xaiCodeSessionBaseUrl()).toBe('https://api.x.ai/v1');
    // A pin written before the provider move still carries the publisher
    // segment; api.x.ai 404s that spelling.
    expect(new ProbeOpenRouter().probe(inv({ context, model: 'x-ai/grok-4.6' }))).toBe('grok-4.6');
    expect(new ProbeOpenRouter().probe(inv({ context }))).toBe('grok-4.6');
  });

  it('bills the session under xai, where Grok has a published rate', async () => {
    jest.spyOn(OpenRouterCodeSessionRunner.prototype, 'run').mockResolvedValue({
      ...EMPTY_RUN,
      modelUsage: [{ model: 'grok-4.6', inputTokens: 1000, outputTokens: 500, cachedTokens: 0 }],
    });
    const out = await codeSessionHandler(INPUT, ctx({ outerProvider: 'xai', outerModelId: 'grok-4.6' }));

    expect(persistUsageEvent).toHaveBeenCalledTimes(1);
    expect(persistUsageEvent.mock.calls[0][0]).toMatchObject({ provider: 'xai', model: 'grok-4.6' });
    // Rated as 'openrouter' the key would be `openrouter:grok-4.6`, which
    // matches nothing — and a miss records the tokens at no cost rather than
    // failing. A real number here is the whole point.
    expect(out.cost_usd).toBeGreaterThan(0);
  });

  it('does not divert a non-Grok session', () => {
    const context = ctx({ outerProvider: 'openrouter', outerModelId: 'z-ai/glm-5.2' });
    expect(isGrokCodeSession(context)).toBe(false);
    expect(usesXaiHost(inv({ context }))).toBe(false);
    expect(codeModelForSession(context)).toBe('z-ai/glm-5.3');
  });
});

describe('a gateway agent handed another family\'s outer model id', () => {
  // The per-agent AI Provider Override case the chat turn used to produce: a
  // Qwen team on a GLM workspace arrived with outerModelId = the workspace's GLM
  // id. The session is billed under the OUTER provider, so the coding model
  // must be that provider's, whatever id arrived.
  beforeEach(() => {
    persistUsageEvent.mockClear();
    getTaskModelOverride.mockReset();
    getTaskModelOverride.mockResolvedValue(null);
  });

  it('codes on the outer provider\'s model, not the foreign id\'s', () => {
    const context = ctx({ outerProvider: 'qwen', outerModelId: 'z-ai/glm-5.2' });
    expect(codeModelForSession(context)).toBe('qwen/qwen3.8-max-0902');
    expect(new ProbeOpenRouter().probe(inv({ context }))).toBe('qwen/qwen3.8-max-0902');
    // No id at all used to fall to the GLM default too.
    expect(codeModelForSession(ctx({ outerProvider: 'qwen' }))).toBe('qwen/qwen3.8-max-0902');
    expect(codeModelForSession(ctx({ outerProvider: 'deepseek', outerModelId: 'qwen/qwen3.7-plus' }))).toBe('deepseek/deepseek-v4-pro');
  });

  it('leaves a matching id, GLM, and a non-gateway outer agent exactly as before', () => {
    expect(codeModelForSession(ctx({ outerProvider: 'qwen', outerModelId: 'qwen/qwen3.7-plus' }))).toBe('qwen/qwen3.8-max-0902');
    expect(codeModelForSession(ctx({ outerProvider: 'glm', outerModelId: 'z-ai/glm-5-turbo' }))).toBe('z-ai/glm-5.3');
    expect(codeModelForSession(ctx({ outerProvider: 'glm' }))).toBe('z-ai/glm-5.3');
    // prefer_provider forcing the gateway from an Anthropic agent: the id decides.
    expect(codeModelForSession(ctx({ outerProvider: 'anthropic', outerModelId: 'qwen/qwen3.7-plus' }))).toBe('qwen/qwen3.8-max-0902');
    expect(codeModelForSession(ctx({ outerProvider: 'anthropic' }))).toBe('z-ai/glm-5.3');
  });

  it('bills under the same vendor it codes on', async () => {
    const context = ctx({ outerProvider: 'qwen', outerModelId: 'z-ai/glm-5.2' });
    jest.spyOn(OpenRouterCodeSessionRunner.prototype, 'run').mockResolvedValue({
      ...EMPTY_RUN,
      modelUsage: [{ model: codeModelForSession(context), inputTokens: 1000, outputTokens: 500, cachedTokens: 0 }],
    });
    await codeSessionHandler(INPUT, context);
    expect(persistUsageEvent).toHaveBeenCalledTimes(1);
    expect(persistUsageEvent.mock.calls[0][0]).toMatchObject({ provider: 'qwen', model: 'qwen/qwen3.8-max-0902' });
  });
});

describe('a provider with no runner registered', () => {
  it('tears the workspace down instead of leaking it', async () => {
    const destroy = jest.spyOn(LocalCodeSessionWorkspace.prototype, 'destroy');
    // Selecting the runner used to sit between provisioning the workspace and
    // the try/finally that destroys it, so an unroutable provider leaked one —
    // a temp dir in-process, a live sandbox container in the sandboxed family.
    await expect(
      codeSessionHandler(
        { ...INPUT, prefer_provider: 'nonexistent' as never },
        ctx({ outerProvider: 'anthropic' }),
      ),
    ).resolves.toMatchObject({ exit_reason: 'error' });

    expect(mkdtemp).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});

describe('which CLI the open-weights vendors code with', () => {
  const saved = process.env.CODE_SESSION_OPEN_WEIGHTS_RUNNER;
  afterEach(() => {
    if (saved === undefined) delete process.env.CODE_SESSION_OPEN_WEIGHTS_RUNNER;
    else process.env.CODE_SESSION_OPEN_WEIGHTS_RUNNER = saved;
  });

  it('defaults to Codex, the established path', () => {
    delete process.env.CODE_SESSION_OPEN_WEIGHTS_RUNNER;
    expect(runnerFor('openrouter', 'in-process')).toBeInstanceOf(OpenRouterCodeSessionRunner);
    expect(runnerFor('openrouter', 'sandbox')).toBeInstanceOf(SandboxedOpenRouterCodeSessionRunner);
  });

  it('serves BOTH families from one runner when opencode is selected', () => {
    // It drives a CLI through the workspace handle rather than linking an SDK
    // into this process, so it honours a sandbox workspace and a local one
    // alike — the split the other vendors need does not apply.
    process.env.CODE_SESSION_OPEN_WEIGHTS_RUNNER = 'opencode';
    expect(runnerFor('openrouter', 'in-process')).toBeInstanceOf(OpencodeCodeSessionRunner);
    expect(runnerFor('openrouter', 'sandbox')).toBeInstanceOf(OpencodeCodeSessionRunner);
  });

  it('leaves the other vendors alone', () => {
    process.env.CODE_SESSION_OPEN_WEIGHTS_RUNNER = 'opencode';
    expect(runnerFor('anthropic', 'in-process')).not.toBeInstanceOf(OpencodeCodeSessionRunner);
    expect(runnerFor('openai', 'sandbox')).not.toBeInstanceOf(OpencodeCodeSessionRunner);
  });
});
