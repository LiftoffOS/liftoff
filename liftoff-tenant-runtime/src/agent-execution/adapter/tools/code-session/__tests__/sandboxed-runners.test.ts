// What the sandboxed runners report back, and how they classify how a session
// ended.
//
// The same two things the in-process runners are tested for, and for the same
// reason: a runner that reports no usage makes the invocation's cost silently
// understated, and a runner that calls a failed session a success hands the
// calling agent an empty diff and lets it carry on as though the work were
// done. What is new here is a third failure mode the SDK transport cannot have
// — a CLI that dies without printing a terminal message at all.

jest.mock('../../../../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// The in-process family links vendor SDKs, which are ESM and would not load
// here. `runnerFor` only has to hand back the right OBJECT, so a stub is enough.
jest.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: jest.fn() }));
jest.mock('../../../esm-import', () => ({ esmImport: jest.fn() }));

import { runnerFor } from '../index';
import { SANDBOXED_RUNNERS } from '../runners/sandboxed';
import { SandboxedAnthropicCodeSessionRunner } from '../runners/sandboxed/claude';
import { SandboxedOpenAICodeSessionRunner, SandboxedOpenRouterCodeSessionRunner } from '../runners/sandboxed/codex';
import { SandboxedGeminiCodeSessionRunner } from '../runners/sandboxed/gemini';
import { classifyCliExit } from '../runners/sandboxed/shared';
import type { RunnerInvocation } from '../types';
import type { CodeSessionExecResult, CodeSessionWorkspace } from '../workspace';

/** A workspace that returns a canned command result and records the argv. */
function stubWorkspace(over: Partial<CodeSessionExecResult> = {}) {
  const calls: Array<{ argv: string[]; opts: unknown }> = [];
  const workspace: CodeSessionWorkspace = {
    root: '/workspace/repo',
    kind: 'sandbox',
    async exec(argv, opts) {
      calls.push({ argv, opts });
      return { stdout: '', stderr: '', exitCode: 0, timedOut: false, ...over };
    },
    async readFile() { return null; },
    async destroy() { /* nothing to release in a stub */ },
  };
  return { workspace, calls };
}

function invocation(over: Partial<RunnerInvocation> = {}): RunnerInvocation {
  return {
    task: 'do the thing',
    workspaceRoot: '/workspace/repo',
    allowedTools: [],
    timeoutMs: 60_000,
    signal: new AbortController().signal,
    context: { tenantId: 't1', agentId: 'a1', invocationId: 'inv1', outerProvider: 'anthropic' },
    ...over,
  };
}

const CLAUDE_RESULT = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  total_cost_usd: 0.031,
  usage: { input_tokens: 1000, output_tokens: 250 },
  modelUsage: {
    'claude-opus-4-8': {
      inputTokens: 1000, outputTokens: 250, cacheReadInputTokens: 800, costUSD: 0.031,
    },
  },
};

function ndjson(...messages: unknown[]): string {
  return messages.map((m) => JSON.stringify(m)).join('\n') + '\n';
}

describe('every sandboxed runner refuses to run without a workspace', () => {
  // The refusal is the point. Falling back to spawning in-process is the exact
  // behaviour these runners exist to replace, and doing it quietly would put
  // the coding agent back in the runtime's container under the runtime's
  // service account while the logs still said `sandbox`.
  it.each(Object.entries(SANDBOXED_RUNNERS))('%s', async (_provider, runner) => {
    await expect(runner.run(invocation({ workspace: undefined })))
      .rejects.toThrow(/requires a workspace/);
  });
});

describe('SandboxedAnthropicCodeSessionRunner', () => {
  it('reports the vendor\'s own per-model cost off the terminal message', async () => {
    const { workspace } = stubWorkspace({ stdout: ndjson(CLAUDE_RESULT) });
    const result = await new SandboxedAnthropicCodeSessionRunner()
      .run(invocation({ workspace }));
    expect(result.exit_reason).toBe('success');
    expect(result.modelUsage).toEqual([{
      model: 'claude-opus-4-8',
      inputTokens: 1000,
      outputTokens: 250,
      cachedTokens: 800,
      costUsd: 0.031,
    }]);
  });

  it('collects the summary and the tool calls from the stream', async () => {
    const { workspace } = stubWorkspace({
      stdout: ndjson(
        {
          type: 'assistant',
          message: {
            model: 'claude-opus-4-8',
            content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }],
          },
        },
        { type: 'user', tool_use_result: 'ok' },
        {
          type: 'assistant',
          message: { model: 'claude-opus-4-8', content: [{ type: 'text', text: 'fixed the test' }] },
        },
        CLAUDE_RESULT,
      ),
    });
    const result = await new SandboxedAnthropicCodeSessionRunner()
      .run(invocation({ workspace }));
    expect(result.summary).toBe('fixed the test');
    expect(result.tool_calls_made).toEqual([
      { tool: 'Bash', args: { command: 'npm test' }, result: 'ok' },
    ]);
  });

  it('treats is_error under a success subtype as a failure, like the SDK path', async () => {
    // The classification lives in one reducer precisely so the two transports
    // cannot disagree about whether the same session succeeded.
    const { workspace } = stubWorkspace({
      stdout: ndjson({
        type: 'result', subtype: 'success', is_error: true, api_error_status: 429, modelUsage: {},
      }),
    });
    const result = await new SandboxedAnthropicCodeSessionRunner()
      .run(invocation({ workspace }));
    expect(result.exit_reason).toBe('error');
  });

  it('calls a session that printed no terminal message an error, whatever the exit code', async () => {
    // The failure mode the SDK transport cannot have. A CLI that is OOM-killed
    // or crashes prints no result message; an optimistic reducer still reads
    // `success`, and the handler then returns an empty diff as finished work.
    const { workspace } = stubWorkspace({ stdout: 'Killed\n', exitCode: 0 });
    const result = await new SandboxedAnthropicCodeSessionRunner()
      .run(invocation({ workspace }));
    expect(result.exit_reason).toBe('error');
  });

  it('reports a killed session as a timeout, and still keeps its usage', async () => {
    // Tokens spent before a deadline are spent. The workspace hands back what
    // the CLI printed before it died precisely so this can be metered.
    const { workspace } = stubWorkspace({ stdout: ndjson(CLAUDE_RESULT), timedOut: true });
    const result = await new SandboxedAnthropicCodeSessionRunner()
      .run(invocation({ workspace }));
    expect(result.exit_reason).toBe('timeout');
    expect(result.modelUsage?.[0].costUsd).toBe(0.031);
  });

  it('survives a truncated final line', async () => {
    // Expected whenever a session is killed mid-write. Everything before it
    // still counts, and the alternative — throwing — loses the whole stream.
    const { workspace } = stubWorkspace({
      stdout: ndjson(CLAUDE_RESULT) + '{"type":"assist',
    });
    const result = await new SandboxedAnthropicCodeSessionRunner()
      .run(invocation({ workspace }));
    expect(result.exit_reason).toBe('success');
  });

  it('asks the CLI for the stream, bypasses its prompts, and pins a model only when told', async () => {
    const { workspace, calls } = stubWorkspace({ stdout: ndjson(CLAUDE_RESULT) });
    await new SandboxedAnthropicCodeSessionRunner().run(invocation({ workspace }));
    expect(calls[0].argv).toEqual(expect.arrayContaining([
      'claude', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions',
    ]));
    expect(calls[0].argv).not.toContain('--model');

    const second = stubWorkspace({ stdout: ndjson(CLAUDE_RESULT) });
    await new SandboxedAnthropicCodeSessionRunner()
      .run(invocation({ workspace: second.workspace, model: 'claude-opus-5' }));
    expect(second.calls[0].argv).toEqual(expect.arrayContaining(['--model', 'claude-opus-5']));
  });
});

describe('SandboxedOpenAICodeSessionRunner', () => {
  it('records tokens from a completed turn', async () => {
    const { workspace } = stubWorkspace({
      stdout: ndjson(
        { type: 'item.completed', item: { type: 'agent_message', text: 'done' } },
        { type: 'turn.completed', usage: { input_tokens: 500, output_tokens: 100, cached_input_tokens: 20 } },
      ),
    });
    const result = await new SandboxedOpenAICodeSessionRunner().run(invocation({ workspace }));
    expect(result.exit_reason).toBe('success');
    expect(result.summary).toBe('done');
    expect(result.modelUsage).toEqual([
      { inputTokens: 500, outputTokens: 100, cachedTokens: 20 },
    ]);
  });

  it('carries a pinned model onto the usage row so it can be priced', async () => {
    const { workspace } = stubWorkspace({
      stdout: ndjson({ type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 1 } }),
    });
    const result = await new SandboxedOpenAICodeSessionRunner()
      .run(invocation({ workspace, model: 'gpt-5-codex' }));
    expect(result.modelUsage?.[0].model).toBe('gpt-5-codex');
  });

  it('meters a failed turn and calls it an error', async () => {
    const { workspace } = stubWorkspace({
      stdout: ndjson({
        type: 'turn.failed',
        error: { message: 'context length exceeded' },
        usage: { input_tokens: 900, output_tokens: 10 },
      }),
    });
    const result = await new SandboxedOpenAICodeSessionRunner().run(invocation({ workspace }));
    expect(result.exit_reason).toBe('error');
    expect(result.modelUsage?.[0].inputTokens).toBe(900);
  });

  it('maps a shell command to a tool call the platform recognises', async () => {
    const { workspace } = stubWorkspace({
      stdout: ndjson(
        {
          type: 'item.completed',
          item: { type: 'command_execution', command: 'npm test', aggregated_output: 'ok' },
        },
        { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
      ),
    });
    const result = await new SandboxedOpenAICodeSessionRunner().run(invocation({ workspace }));
    expect(result.tool_calls_made).toEqual([
      { tool: 'Bash', args: { command: 'npm test' }, result: 'ok' },
    ]);
  });

  it('runs with the vendor sandbox off, because the container IS the sandbox', async () => {
    const { workspace, calls } = stubWorkspace({
      stdout: ndjson({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }),
    });
    await new SandboxedOpenAICodeSessionRunner().run(invocation({ workspace }));
    expect(calls[0].argv).toEqual(expect.arrayContaining([
      'codex', 'exec', '--json', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check',
    ]));
  });
});

describe('SandboxedOpenRouterCodeSessionRunner', () => {
  it('always names a model, because OpenRouter has no default to fall back on', async () => {
    // Omitting the flag against api.openai.com means "let the vendor choose";
    // against OpenRouter it means an unroutable request.
    const { workspace, calls } = stubWorkspace({
      stdout: ndjson({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }),
    });
    await new SandboxedOpenRouterCodeSessionRunner().run(invocation({ workspace }));
    const modelIndex = calls[0].argv.indexOf('--model');
    expect(modelIndex).toBeGreaterThan(-1);
    expect(calls[0].argv[modelIndex + 1]).toBeTruthy();
  });

  it('sends a customer-funded Grok session to xAI, without OpenRouter\'s publisher prefix', async () => {
    // An xAI key cannot pay an OpenRouter invoice, so the account change is a
    // host change too — and xAI's own API calls the model `grok-4.6`, not
    // `x-ai/grok-4.6`.
    const { workspace, calls } = stubWorkspace({
      stdout: ndjson({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }),
    });
    await new SandboxedOpenRouterCodeSessionRunner().run(invocation({
      workspace,
      model: 'x-ai/grok-4.6',
      byok: {
        vendor: 'xai',
        baseUrl: 'https://api.example.com/byok/xai',
        token: 'run-token',
        rerouteToVendorApi: true,
      },
    }));
    expect(calls[0].argv).toEqual(expect.arrayContaining(['--model', 'grok-4.6']));
    expect((calls[0].opts as { env?: Record<string, string> }).env?.OPENAI_BASE_URL)
      .toBe('https://api.example.com/byok/xai/v1');
  });
});

describe('SandboxedGeminiCodeSessionRunner', () => {
  it('reports usage per REAL model id, so the session can be priced normally', async () => {
    const { workspace } = stubWorkspace({
      stdout: JSON.stringify({
        response: 'refactored the parser',
        stats: { models: { 'gemini-3-pro': { tokens: { prompt: 800, candidates: 120, cached: 40 } } } },
      }),
    });
    const result = await new SandboxedGeminiCodeSessionRunner().run(invocation({ workspace }));
    expect(result.exit_reason).toBe('success');
    expect(result.summary).toBe('refactored the parser');
    expect(result.modelUsage).toEqual([
      { model: 'gemini-3-pro', inputTokens: 800, outputTokens: 120, cachedTokens: 40 },
    ]);
  });

  it('meters a turn that errored mid-way', async () => {
    const { workspace } = stubWorkspace({
      stdout: JSON.stringify({
        error: { type: 'ApiError', message: 'quota' },
        stats: { models: { 'gemini-3-pro': { tokens: { prompt: 10, candidates: 2, cached: 0 } } } },
      }),
    });
    const result = await new SandboxedGeminiCodeSessionRunner().run(invocation({ workspace }));
    expect(result.exit_reason).toBe('error');
    expect(result.modelUsage?.[0].inputTokens).toBe(10);
  });

  it('calls unreadable output an error rather than an empty success', async () => {
    const { workspace } = stubWorkspace({ stdout: 'Segmentation fault', exitCode: 139 });
    const result = await new SandboxedGeminiCodeSessionRunner().run(invocation({ workspace }));
    expect(result.exit_reason).toBe('error');
  });
});

describe('the runner family follows the workspace', () => {
  // FITNESS FUNCTION for the pairing, which has no other way of failing loudly.
  //
  // An in-process runner links a vendor SDK that spawns in THIS container. Pair
  // one with a sandbox workspace and the coding agent works in the runtime's
  // container while its checkout sits in another one: the agent finds an empty
  // directory, `git diff` over the real checkout reports nothing, and the tool
  // returns exit_reason 'success' with an empty diff. The calling agent reads
  // that as "nothing needed changing" and carries on.
  //
  // Nothing throws anywhere along that path, which is why it is pinned here.
  const PROVIDERS = ['anthropic', 'openai', 'google', 'openrouter'] as const;

  it.each(PROVIDERS)('%s in a sandbox gets the sandboxed runner', (provider) => {
    expect(runnerFor(provider, 'sandbox')).toBe(SANDBOXED_RUNNERS[provider]);
  });

  it.each(PROVIDERS)('%s in-process does NOT get the sandboxed runner', (provider) => {
    expect(runnerFor(provider, 'in-process')).not.toBe(SANDBOXED_RUNNERS[provider]);
  });

  it.each(PROVIDERS)('%s reports the provider it was asked for', (provider) => {
    // A mismatch here would send a session to the wrong vendor with the right
    // credentials, which fails as an auth error rather than as a routing bug.
    expect(runnerFor(provider, 'sandbox').provider).toBe(provider);
    expect(runnerFor(provider, 'in-process').provider).toBe(provider);
  });
});

describe('classifyCliExit', () => {
  const ok = { stdout: '', stderr: '', exitCode: 0, timedOut: false };

  it('requires a terminal message for success, not just a zero exit', () => {
    expect(classifyCliExit({
      result: ok, sawTerminal: false, streamExitReason: 'success', aborted: false,
    })).toBe('error');
  });

  it('prefers timeout over everything, because a killed session did not decide anything', () => {
    expect(classifyCliExit({
      result: { ...ok, timedOut: true }, sawTerminal: true, streamExitReason: 'success', aborted: false,
    })).toBe('timeout');
    expect(classifyCliExit({
      result: ok, sawTerminal: false, streamExitReason: 'error', aborted: true,
    })).toBe('timeout');
  });

  it('defers to the stream once it reached a terminal message', () => {
    expect(classifyCliExit({
      result: ok, sawTerminal: true, streamExitReason: 'error', aborted: false,
    })).toBe('error');
    expect(classifyCliExit({
      result: ok, sawTerminal: true, streamExitReason: 'success', aborted: false,
    })).toBe('success');
  });
});
