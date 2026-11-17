// OpenAI adapter unit tests:
//   - Responses SSE parsing: response.completed / failed / incomplete / error
//   - Duplicate cumulative usage events REPLACE, never double count
//   - Reasoning tokens do not double count output
//   - Cached tokens do not double count input
//   - GPT-5.6+ cache_write_tokens parsed; missing cache-write stays null
//   - Prefix stripping and upstream URL construction
//   - Header allowlisting in both directions
//   - Request-body normalization allowlist
//   - Operation classification

import { OpenAIAdapter } from '../vendor/openai.js';
import type { TokenUsage, VendorConfig } from '../vendor/adapter.js';

const adapter = new OpenAIAdapter();

const CONFIG: VendorConfig = {
  vendor: 'openai',
  baseUrl: 'https://api.openai.com',
  allowedModels: ['gpt-5.6-sol'],
  pricing: {},
};

function emptyUsage(): TokenUsage {
  return {
    requestId: '',
    model: 'gpt-5.6-sol',
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheWriteTokens: null,
    reasoningTokens: 0,
  };
}

function completedEvent(usage: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return adapter.parseSseDataLine(
    JSON.stringify({
      type: 'response.completed',
      response: { id: 'resp_123', model: 'gpt-5.6-sol', usage, ...extra },
    }),
  )!;
}

describe('OpenAIAdapter usage parsing', () => {
  it('parses final usage from response.completed with cache writes (GPT-5.6+)', () => {
    const event = completedEvent({
      input_tokens: 1000,
      input_tokens_details: { cached_tokens: 300, cache_write_tokens: 200 },
      output_tokens: 400,
      output_tokens_details: { reasoning_tokens: 150 },
      total_tokens: 1400,
    });
    const usage = adapter.accumulateUsage(emptyUsage(), event);
    expect(usage.requestId).toBe('resp_123');
    expect(usage.inputTokens).toBe(1000);
    expect(usage.cachedInputTokens).toBe(300);
    expect(usage.cacheWriteTokens).toBe(200);
    expect(usage.outputTokens).toBe(400);
    expect(usage.reasoningTokens).toBe(150);
    expect(usage.totalTokens).toBe(1400);
  });

  it('preserves null cache-write when the response omits it (unknown is not zero)', () => {
    const event = completedEvent({
      input_tokens: 500,
      input_tokens_details: { cached_tokens: 100 },
      output_tokens: 50,
      total_tokens: 550,
    });
    const usage = adapter.accumulateUsage(emptyUsage(), event);
    expect(usage.cacheWriteTokens).toBeNull();
  });

  it('REPLACES cumulative usage on repeated events — no blind summing', () => {
    let usage = emptyUsage();
    const inProgress = adapter.parseSseDataLine(
      JSON.stringify({
        type: 'response.in_progress',
        response: { id: 'resp_123', usage: { input_tokens: 1000, output_tokens: 100 } },
      }),
    )!;
    usage = adapter.accumulateUsage(usage, inProgress);
    usage = adapter.accumulateUsage(usage, inProgress); // duplicate cumulative event
    const completed = completedEvent({ input_tokens: 1000, output_tokens: 400, total_tokens: 1400 });
    usage = adapter.accumulateUsage(usage, completed);
    expect(usage.inputTokens).toBe(1000); // NOT 3000
    expect(usage.outputTokens).toBe(400); // final total replaces, not 100+100+400
  });

  it('reasoning tokens are a subset of output tokens — never added to output', () => {
    const event = completedEvent({
      input_tokens: 10,
      output_tokens: 400,
      output_tokens_details: { reasoning_tokens: 350 },
      total_tokens: 410,
    });
    const usage = adapter.accumulateUsage(emptyUsage(), event);
    expect(usage.outputTokens).toBe(400);
    expect(usage.reasoningTokens).toBe(350);
  });

  it('parses non-streaming usage from a response object body', () => {
    const usage = adapter.parseNonStreamingUsage(
      {
        id: 'resp_ns',
        model: 'gpt-5.6-sol',
        usage: {
          input_tokens: 42,
          input_tokens_details: { cached_tokens: 10, cache_write_tokens: 5 },
          output_tokens: 7,
          total_tokens: 49,
        },
      },
      'fallback-model',
    );
    expect(usage).not.toBeNull();
    expect(usage!.requestId).toBe('resp_ns');
    expect(usage!.inputTokens).toBe(42);
    expect(usage!.cachedInputTokens).toBe(10);
    expect(usage!.cacheWriteTokens).toBe(5);
    expect(usage!.outputTokens).toBe(7);
  });

  it('returns null for a body without usage (still durably recorded upstream)', () => {
    expect(adapter.parseNonStreamingUsage({ id: 'resp_x' }, 'm')).toBeNull();
    expect(adapter.parseNonStreamingUsage({ usage: {} }, 'm')).toBeNull();
  });
});

describe('OpenAIAdapter lifecycle extraction', () => {
  it('maps response.completed to completed', () => {
    const event = completedEvent({ input_tokens: 1, output_tokens: 1 });
    expect(adapter.extractLifecycle(event)).toEqual({ status: 'completed' });
  });

  it('distinguishes a 200 stream containing response.failed from completed', () => {
    const event = adapter.parseSseDataLine(
      JSON.stringify({
        type: 'response.failed',
        response: { id: 'r', error: { code: 'server_error' } },
      }),
    )!;
    expect(adapter.extractLifecycle(event)).toEqual({
      status: 'failed',
      errorCategory: 'server_error',
    });
  });

  it('maps response.incomplete with reason', () => {
    const event = adapter.parseSseDataLine(
      JSON.stringify({
        type: 'response.incomplete',
        response: { id: 'r', incomplete_details: { reason: 'max_output_tokens' } },
      }),
    )!;
    expect(adapter.extractLifecycle(event)).toEqual({
      status: 'incomplete',
      errorCategory: 'max_output_tokens',
    });
  });

  it('maps a bare error event to failed', () => {
    const event = adapter.parseSseDataLine(
      JSON.stringify({ type: 'error', code: 'rate_limit_exceeded', message: 'slow down' }),
    )!;
    expect(adapter.extractLifecycle(event)).toEqual({
      status: 'failed',
      errorCategory: 'rate_limit_exceeded',
    });
  });

  it('returns null for non-terminal events', () => {
    const event = adapter.parseSseDataLine(
      JSON.stringify({ type: 'response.output_text.delta', delta: 'hi' }),
    )!;
    expect(adapter.extractLifecycle(event)).toBeNull();
  });
});

describe('OpenAIAdapter routing and operations', () => {
  it('classifies operations from the Liftoff /codex namespace', () => {
    expect(adapter.classifyOperation('POST', '/codex/v1/responses')).toBe('responses.create');
    expect(adapter.classifyOperation('POST', '/codex/v1/responses/compact')).toBe('responses.compact');
    expect(adapter.classifyOperation('GET', '/codex/v1/models?client_version=0.144.6')).toBe('models.list');
    expect(adapter.classifyOperation('POST', '/codex/v1/unknown')).toBeNull();
    expect(adapter.classifyOperation('POST', '/v1/messages')).toBeNull();
  });

  it('translates /codex paths to upstream /v1 paths — never verbatim append', () => {
    expect(adapter.buildUpstreamUrl('/codex/v1/responses', CONFIG).toString()).toBe(
      'https://api.openai.com/v1/responses',
    );
    expect(adapter.buildUpstreamUrl('/codex/v1/responses/compact', CONFIG).toString()).toBe(
      'https://api.openai.com/v1/responses/compact',
    );
    expect(() => adapter.buildUpstreamUrl('/codex/v1/other', CONFIG)).toThrow();
  });

  it('injects Bearer auth for the user OpenAI key', () => {
    expect(adapter.buildAuthHeaders('sk-user')).toEqual({ authorization: 'Bearer sk-user' });
  });
});

describe('OpenAIAdapter header + body allowlists', () => {
  it('request-header allowlist admits only accept/content-type at launch', () => {
    const allowed = adapter.getAllowedRequestHeaders();
    expect(allowed.has('accept')).toBe(true);
    expect(allowed.has('content-type')).toBe(true);
    expect(allowed.has('authorization')).toBe(false);
    expect(allowed.has('x-api-key')).toBe(false);
    expect(allowed.has('openai-organization')).toBe(false);
    expect(allowed.has('session_id')).toBe(false);
  });

  it('response-header allowlist admits rate-limit metadata, not cookies', () => {
    const safe = adapter.getSafeResponseHeaders();
    expect(safe.has('x-request-id')).toBe(true);
    expect(safe.has('retry-after')).toBe(true);
    expect(safe.has('x-ratelimit-remaining-requests')).toBe(true);
    expect(safe.has('set-cookie')).toBe(false);
    expect(safe.has('transfer-encoding')).toBe(false);
  });

  it('normalizes the request body through the field allowlist (drops client_metadata)', () => {
    const raw = Buffer.from('{}');
    const normalized = JSON.parse(
      adapter
        .normalizeRequestBody(
          {
            model: 'gpt-5.6-sol',
            input: 'hello',
            stream: true,
            prompt_cache_key: 'pk',
            client_metadata: { session_id: 'internal' },
            unknown_internal_field: true,
          },
          raw,
        )
        .toString('utf-8'),
    );
    expect(normalized.model).toBe('gpt-5.6-sol');
    expect(normalized.input).toBe('hello');
    expect(normalized.stream).toBe(true);
    expect(normalized.prompt_cache_key).toBe('pk');
    expect(normalized.client_metadata).toBeUndefined();
    expect(normalized.unknown_internal_field).toBeUndefined();
  });

  it('rejects a body without a model', () => {
    expect(() => adapter.normalizeRequestBody({ input: 'x' }, Buffer.from('{}'))).toThrow();
  });

  it('captures correlation from headers and client_metadata without forwarding', () => {
    const correlation = adapter.extractCorrelation(
      { session_id: 'sess-1', turn_id: 'turn-9' },
      { client_metadata: { thread_id: 'thr-2' } },
    );
    expect(correlation.sessionId).toBe('sess-1');
    expect(correlation.turnId).toBe('turn-9');
    expect(correlation.threadId).toBe('thr-2');
  });
});
