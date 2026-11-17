// What each nested coding runner reports back about what it spent, and how it
// classifies how the session ended.
//
// These two things are the whole substance of metering a code_session. A runner
// that reports no usage makes the invocation's cost silently understated, and a
// runner that calls a failed session a success hands the calling agent an empty
// diff and lets it carry on as though the work were done.

const mockQuery = jest.fn();
jest.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: (...a: unknown[]) => mockQuery(...a) }));

const mockRunStreamed = jest.fn();
jest.mock('../esm-import', () => {
  class Codex {
    constructor(public _opts: unknown) {}
    startThread() { return { id: 't1', runStreamed: (...a: unknown[]) => mockRunStreamed(...a) }; }
  }
  return { esmImport: async () => ({ Codex }) };
});

const mockExecFile = jest.fn();
jest.mock('child_process', () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}));

jest.mock('../../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { AnthropicCodeSessionRunner } from '../tools/code-session/runners/anthropic';
import { OpenAICodeSessionRunner } from '../tools/code-session/runners/openai';
import { GeminiCodeSessionRunner } from '../tools/code-session/runners/gemini';
import type { RunnerInvocation } from '../tools/code-session/types';

function invocation(over: Partial<RunnerInvocation> = {}): RunnerInvocation {
  return {
    task: 'do the thing',
    workspaceRoot: '/tmp/ws',
    allowedTools: [],
    timeoutMs: 60_000,
    signal: new AbortController().signal,
    context: {
      tenantId: 't1',
      agentId: 'a1',
      invocationId: 'inv1',
      outerProvider: 'anthropic',
    },
    ...over,
  };
}

/** An async iterable of SDK messages, with the interrupt() the runner may call. */
function sdkStream(messages: unknown[]): AsyncIterable<unknown> & { interrupt: () => Promise<void> } {
  return {
    interrupt: jest.fn().mockResolvedValue(undefined),
    async *[Symbol.asyncIterator]() { for (const m of messages) yield m; },
  } as AsyncIterable<unknown> & { interrupt: () => Promise<void> };
}

const RESULT_USAGE = {
  modelUsage: {
    'claude-opus-4-8': {
      inputTokens: 1000,
      outputTokens: 250,
      cacheReadInputTokens: 800,
      costUSD: 0.031,
    },
  },
  total_cost_usd: 0.031,
  usage: { input_tokens: 1000, output_tokens: 250 },
};

describe('Claude Code runner — usage capture', () => {
  beforeEach(() => jest.clearAllMocks());

  it('reports the SDK\'s own per-model cost, which is the only figure that can price the CLI default', () => {
    // The session runs on whatever model the CLI defaulted to. Our rate table
    // cannot be assumed to have an entry for it, so the SDK's costUSD is the
    // authority — and it used to be dropped on the floor at the `break`.
    mockQuery.mockReturnValue(sdkStream([{ type: 'result', subtype: 'success', ...RESULT_USAGE }]));
    return new AnthropicCodeSessionRunner().run(invocation()).then((r) => {
      expect(r.exit_reason).toBe('success');
      expect(r.modelUsage).toEqual([{
        model: 'claude-opus-4-8',
        inputTokens: 1000,
        outputTokens: 250,
        cachedTokens: 800,
        costUsd: 0.031,
      }]);
      expect(r.usage).toMatchObject({ total_cost_usd: 0.031 });
    });
  });

  it.each([
    'error_during_execution',
    'error_max_turns',
    'error_max_budget_usd',
    'error_max_structured_output_retries',
  ])('treats subtype %s as a failure, not a clean empty diff', async (subtype) => {
    // The old check named error_max_turns and a literal 'error' the SDK union
    // does not contain, so a session that died during execution or hit a budget
    // cap was handed back to the calling agent as a success.
    mockQuery.mockReturnValue(sdkStream([{ type: 'result', subtype, ...RESULT_USAGE }]));
    const result = await new AnthropicCodeSessionRunner().run(invocation());
    expect(result.exit_reason).toBe('error');
    // And it is STILL metered — a failed session spent what it spent.
    expect(result.modelUsage?.[0].costUsd).toBe(0.031);
  });

  it('treats is_error under a success subtype as a failure', async () => {
    // The half the subtype check cannot see. SDKResultSuccess declares
    // `is_error` and `api_error_status` alongside `subtype:'success'`
    // (sdk.d.ts:4305), because the two answer different questions: the subtype
    // says how the SESSION ended, `is_error` says how the TURN went. A session
    // that asked for a model the account cannot reach ends tidily, having done
    // nothing.
    //
    // Verified against the real CLI at 2.1.88 rather than inferred from the
    // type: `claude -p --output-format stream-json` for an unavailable model
    // emits {"type":"result","subtype":"success","is_error":true,...,
    // "modelUsage":{}} — reproduced twice, on two different model aliases.
    //
    // Reading the subtype alone returns exit_reason 'success' with an empty
    // diff, which the calling agent reads as "nothing needed changing".
    mockQuery.mockReturnValue(sdkStream([{
      type: 'result',
      subtype: 'success',
      is_error: true,
      api_error_status: 404,
      modelUsage: {},
      total_cost_usd: 0,
    }]));
    const result = await new AnthropicCodeSessionRunner().run(invocation());
    expect(result.exit_reason).toBe('error');
  });

  it('does not call a clean session an error just because is_error is present', async () => {
    // `is_error` is a required boolean on the success type, so it is on EVERY
    // terminal message. Treating its presence rather than its value as the
    // signal would fail every session.
    mockQuery.mockReturnValue(sdkStream([{
      type: 'result', subtype: 'success', is_error: false, ...RESULT_USAGE,
    }]));
    const result = await new AnthropicCodeSessionRunner().run(invocation());
    expect(result.exit_reason).toBe('success');
  });

  it('keeps what it captured when the stream throws mid-session', async () => {
    // A runner that throws loses tokens the vendor already charged for: the
    // dispatch site cannot meter a result it never receives.
    mockQuery.mockReturnValue({
      interrupt: jest.fn(),
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'assistant',
          message: { model: 'claude-opus-4-8', content: [{ type: 'text', text: 'partial work' }] },
        };
        throw new Error('upstream connection reset');
      },
    });
    const result = await new AnthropicCodeSessionRunner().run(invocation());
    expect(result.exit_reason).toBe('error');
    expect(result.summary).toBe('partial work');
  });

  it('passes a pinned model through and omits it otherwise', async () => {
    mockQuery.mockReturnValue(sdkStream([{ type: 'result', subtype: 'success' }]));
    await new AnthropicCodeSessionRunner().run(invocation());
    expect(mockQuery.mock.calls[0][0].options).not.toHaveProperty('model');

    mockQuery.mockReturnValue(sdkStream([{ type: 'result', subtype: 'success' }]));
    await new AnthropicCodeSessionRunner().run(invocation({ model: 'claude-opus-5' }));
    expect(mockQuery.mock.calls[1][0].options.model).toBe('claude-opus-5');
  });
});

describe('Codex runner — usage capture', () => {
  beforeEach(() => jest.clearAllMocks());

  const events = (evts: unknown[]) => ({
    events: (async function* () { for (const e of evts) yield e; })(),
  });

  it('records tokens from a completed turn', async () => {
    mockRunStreamed.mockResolvedValue(events([
      { type: 'turn.completed', usage: { input_tokens: 500, output_tokens: 120, cached_input_tokens: 60 } },
    ]));
    const result = await new OpenAICodeSessionRunner().run(invocation({ context: { ...invocation().context, outerProvider: 'openai' } }));
    expect(result.modelUsage).toEqual([{ inputTokens: 500, outputTokens: 120, cachedTokens: 60 }]);
    // No costUsd: Codex publishes no cost figure and, unpinned, names no model.
    expect(result.modelUsage?.[0]).not.toHaveProperty('costUsd');
  });

  it('carries the pinned model onto the usage row so it can be priced', async () => {
    mockRunStreamed.mockResolvedValue(events([
      { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5, cached_input_tokens: 0 } },
    ]));
    const result = await new OpenAICodeSessionRunner().run(invocation({ model: 'gpt-5.5' }));
    expect(result.modelUsage?.[0].model).toBe('gpt-5.5');
  });

  it('meters a failed turn if the vendor ever reports usage on one', async () => {
    // The SDK's TurnFailedEvent declares `error` alone today. Reading usage
    // defensively means this meters the day the vendor adds it, not the day
    // somebody notices it is missing.
    mockRunStreamed.mockResolvedValue(events([
      { type: 'turn.failed', error: { message: 'boom' }, usage: { input_tokens: 7, output_tokens: 3, cached_input_tokens: 0 } },
    ]));
    const result = await new OpenAICodeSessionRunner().run(invocation());
    expect(result.exit_reason).toBe('error');
    expect(result.modelUsage).toEqual([{ inputTokens: 7, outputTokens: 3, cachedTokens: 0 }]);
  });

  it('reports no usage rather than a zero-token one when the vendor says nothing', async () => {
    mockRunStreamed.mockResolvedValue(events([{ type: 'turn.failed', error: { message: 'boom' } }]));
    const result = await new OpenAICodeSessionRunner().run(invocation());
    expect(result.exit_reason).toBe('error');
    // undefined, not [{0,0,0}] — the dispatch site counts this as an unmetered
    // session, which is a different and worse thing than a free one.
    expect(result.modelUsage).toBeUndefined();
  });
});

describe('Gemini CLI runner — usage capture', () => {
  beforeEach(() => jest.clearAllMocks());

  /** The CLI's real `-o json` payload: JsonFormatter is handed the raw
   *  SessionMetrics, whose `models` map is keyed BY MODEL NAME with
   *  `tokens.{total,prompt,candidates,cached}`. Verified against the pinned
   *  @google/gemini-cli@0.52.0 bundle. */
  const STATS = {
    models: {
      'gemini-3.1-pro-preview': { tokens: { total: 1300, prompt: 1000, candidates: 300, cached: 200 } },
      'gemini-3.5-flash': { tokens: { total: 60, prompt: 50, candidates: 10, cached: 0 } },
    },
    tools: { totalCalls: 3 },
  };

  function cliReturns(payload: unknown): void {
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const cb = args.find((a) => typeof a === 'function') as ((_e: unknown, _v: unknown) => void) | undefined;
      cb?.(null, { stdout: JSON.stringify(payload), stderr: '' });
    });
  }

  it('reports usage per REAL model id, so the session can be priced normally', async () => {
    cliReturns({ session_id: 's1', response: 'done', stats: STATS });
    const result = await new GeminiCodeSessionRunner().run(invocation());
    expect(result.modelUsage).toEqual([
      { model: 'gemini-3.1-pro-preview', inputTokens: 1000, outputTokens: 300, cachedTokens: 200 },
      { model: 'gemini-3.5-flash', inputTokens: 50, outputTokens: 10, cachedTokens: 0 },
    ]);
  });

  it('meters a turn that errored mid-way', async () => {
    cliReturns({ session_id: 's1', response: 'partial', stats: STATS, error: { message: 'quota' } });
    const result = await new GeminiCodeSessionRunner().run(invocation());
    expect(result.exit_reason).toBe('error');
    expect(result.modelUsage).toHaveLength(2);
  });

  it('claims nothing when the CLI stats do not carry the expected shape', async () => {
    // stats is the CLI's contract, not ours. Reporting zeroes would look like a
    // metered session that happened to be free and would hide the gap forever.
    cliReturns({ session_id: 's1', response: 'done', stats: { somethingElse: true } });
    const result = await new GeminiCodeSessionRunner().run(invocation());
    expect(result.modelUsage).toBeUndefined();
  });

  it('passes a pinned model to the CLI and omits the flag otherwise', async () => {
    cliReturns({ session_id: 's1', response: 'done', stats: STATS });
    await new GeminiCodeSessionRunner().run(invocation());
    expect(mockExecFile.mock.calls[0][1]).not.toContain('-m');

    await new GeminiCodeSessionRunner().run(invocation({ model: 'gemini-3.1-pro-preview' }));
    const args = mockExecFile.mock.calls[1][1] as string[];
    expect(args[args.indexOf('-m') + 1]).toBe('gemini-3.1-pro-preview');
  });
});
