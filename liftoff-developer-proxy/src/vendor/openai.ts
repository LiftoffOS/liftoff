// OpenAIAdapter — implements VendorAdapter for api.openai.com (Responses API,
// consumed by Codex CLI through the /codex/v1 Liftoff namespace). Plan A3.
//
// Usage semantics: the Responses usage object reports
//   input_tokens, input_tokens_details.cached_tokens,
//   input_tokens_details.cache_write_tokens (GPT-5.6+ families),
//   output_tokens, output_tokens_details.reasoning_tokens, total_tokens.
// cache_write_tokens is preserved as null — never coerced to zero — when the
// response omits it ("unknown is not zero", the invariant). The exact
// JSON path is frozen against captured fixtures in Phase 1.

import type {
  VendorAdapter,
  VendorConfig,
  ParsedSseEvent,
  TokenUsage,
  LifecycleSignal,
  RequestCorrelation,
} from './adapter.js';

const MICROS_PER_MILLION = 1_000_000n;

// Launch allowlist: the conditional headers (openai-organization,
// openai-project, x-client-request-id) are NOT admitted until contract testing
// confirms they are deliberately supported.
const ALLOWED_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  'accept',
  'content-type',
]);

const SAFE_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
  'content-type',
  'x-request-id',
  'retry-after',
  'x-ratelimit-limit-requests',
  'x-ratelimit-limit-tokens',
  'x-ratelimit-remaining-requests',
  'x-ratelimit-remaining-tokens',
  'x-ratelimit-reset-requests',
  'x-ratelimit-reset-tokens',
]);

// Request-body field allowlist (request normalization layer). Superset of the
// fields the Codex CLI (0.144.6) sends plus documented public Responses API
// inputs. Codex-internal fields (client_metadata) are captured as correlation
// attributes and NOT forwarded.
const ALLOWED_BODY_FIELDS: ReadonlySet<string> = new Set([
  'model',
  'input',
  'instructions',
  'tools',
  'tool_choice',
  'parallel_tool_calls',
  'reasoning',
  'store',
  'stream',
  'include',
  'prompt_cache_key',
  'text',
  'metadata',
  'max_output_tokens',
  'temperature',
  'top_p',
  'previous_response_id',
  'truncation',
  'service_tier',
]);

// Liftoff /codex namespace -> upstream path (path translation).
const UPSTREAM_PATHS: Record<string, string> = {
  '/codex/v1/responses': '/v1/responses',
  '/codex/v1/responses/compact': '/v1/responses/compact',
};

const OPERATIONS: Record<string, string> = {
  '/codex/v1/responses': 'responses.create',
  '/codex/v1/responses/compact': 'responses.compact',
};

interface OpenAiUsage {
  input_tokens?: number;
  input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  output_tokens?: number;
  output_tokens_details?: { reasoning_tokens?: number };
  total_tokens?: number;
}

function usageFromResponseObject(
  response: Record<string, unknown>,
  current: TokenUsage,
): TokenUsage {
  const usage = (response.usage ?? {}) as OpenAiUsage;
  const inputDetails = usage.input_tokens_details ?? {};
  const outputDetails = usage.output_tokens_details ?? {};

  // Final totals REPLACE earlier values: the Responses API
  // repeats cumulative usage on terminal events; nothing is summed.
  return {
    ...current,
    requestId: (response.id as string | undefined) ?? current.requestId,
    model: (response.model as string | undefined) ?? current.model,
    serviceTier: (response.service_tier as string | undefined) ?? current.serviceTier,
    inputTokens: usage.input_tokens ?? current.inputTokens,
    cachedInputTokens: inputDetails.cached_tokens ?? current.cachedInputTokens,
    // Preserve null when the response does not report cache writes.
    cacheWriteTokens:
      typeof inputDetails.cache_write_tokens === 'number'
        ? inputDetails.cache_write_tokens
        : current.cacheWriteTokens ?? null,
    cacheCreationInputTokens:
      typeof inputDetails.cache_write_tokens === 'number' ? inputDetails.cache_write_tokens : 0,
    outputTokens: usage.output_tokens ?? current.outputTokens,
    reasoningTokens: outputDetails.reasoning_tokens ?? current.reasoningTokens ?? 0,
    totalTokens: usage.total_tokens ?? current.totalTokens,
  };
}

export class OpenAIAdapter implements VendorAdapter {
  readonly vendor = 'openai';

  classifyOperation(method: string, path: string): string | null {
    const clean = path.split('?')[0];
    if (method === 'GET' && clean === '/codex/v1/models') return 'models.list';
    if (method === 'POST') return OPERATIONS[clean] ?? null;
    return null;
  }

  buildUpstreamUrl(path: string, config: VendorConfig): URL {
    const clean = path.split('?')[0];
    const upstreamPath = UPSTREAM_PATHS[clean];
    if (!upstreamPath) {
      throw Object.assign(new Error(`No upstream route for ${clean}`), { statusCode: 404 });
    }
    return new URL(upstreamPath, config.baseUrl);
  }

  buildAuthHeaders(apiKey: string): Record<string, string> {
    return { authorization: `Bearer ${apiKey}` };
  }

  getAllowedRequestHeaders(): ReadonlySet<string> {
    return ALLOWED_REQUEST_HEADERS;
  }

  getSafeResponseHeaders(): ReadonlySet<string> {
    return SAFE_RESPONSE_HEADERS;
  }

  extractCorrelation(
    headers: Record<string, string | string[] | undefined>,
    parsedBody: Record<string, unknown> | null,
  ): RequestCorrelation {
    const h = (...keys: string[]): string | undefined => {
      for (const k of keys) {
        const v = headers[k];
        if (typeof v === 'string' && v.length > 0) return v;
      }
      return undefined;
    };
    // Codex correlation header candidates the CLI sends (session, thread,
    // window, turn, client-request identifiers). Captured as Liftoff
    // attributes only; none are in the upstream allowlist.
    const correlation: RequestCorrelation = {
      sessionId: h('session_id', 'x-codex-session-id', 'conversation_id'),
      threadId: h('thread_id', 'x-codex-thread-id'),
      turnId: h('turn_id', 'x-codex-turn-id'),
      clientRequestId: h('x-client-request-id', 'client_request_id', 'x-request-id'),
    };

    // Codex also carries identifiers in the internal client_metadata body
    // field (not forwarded upstream).
    const meta = parsedBody?.client_metadata as Record<string, unknown> | undefined;
    if (meta) {
      correlation.sessionId ??= typeof meta.session_id === 'string' ? meta.session_id : undefined;
      correlation.threadId ??= typeof meta.thread_id === 'string' ? meta.thread_id : undefined;
      correlation.turnId ??= typeof meta.turn_id === 'string' ? meta.turn_id : undefined;
    }
    return correlation;
  }

  normalizeRequestBody(parsedBody: Record<string, unknown>, _rawBody: Buffer): Buffer {
    if (typeof parsedBody.model !== 'string' || parsedBody.model.length === 0) {
      throw Object.assign(new Error('Request body must include a model'), { statusCode: 400 });
    }
    const normalized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parsedBody)) {
      if (ALLOWED_BODY_FIELDS.has(key)) normalized[key] = value;
    }
    return Buffer.from(JSON.stringify(normalized), 'utf-8');
  }

  parseSseDataLine(rawData: string): ParsedSseEvent | null {
    if (rawData === '[DONE]') return null;
    try {
      const obj = JSON.parse(rawData) as Record<string, unknown>;
      return { type: (obj.type as string) ?? 'unknown', data: obj };
    } catch {
      return null;
    }
  }

  accumulateUsage(current: TokenUsage, event: ParsedSseEvent): TokenUsage {
    const obj = event.data as Record<string, unknown>;
    // Lifecycle events carry the response object; response.completed usage is
    // authoritative, but earlier snapshots (response.created/in_progress) let
    // us capture id/model before any terminal event.
    if (
      event.type === 'response.created' ||
      event.type === 'response.in_progress' ||
      event.type === 'response.completed' ||
      event.type === 'response.failed' ||
      event.type === 'response.incomplete'
    ) {
      const response = obj.response as Record<string, unknown> | undefined;
      if (response) return usageFromResponseObject(response, current);
    }
    return current;
  }

  extractLifecycle(event: ParsedSseEvent): LifecycleSignal | null {
    const obj = event.data as Record<string, unknown>;
    const response = obj.response as Record<string, unknown> | undefined;

    switch (event.type) {
      case 'response.completed':
        return { status: 'completed' };
      case 'response.failed': {
        const error = response?.error as Record<string, unknown> | undefined;
        return { status: 'failed', errorCategory: (error?.code as string) ?? 'provider_failed' };
      }
      case 'response.incomplete': {
        const details = response?.incomplete_details as Record<string, unknown> | undefined;
        return { status: 'incomplete', errorCategory: (details?.reason as string) ?? 'incomplete' };
      }
      case 'error': {
        return { status: 'failed', errorCategory: (obj.code as string) ?? 'provider_error' };
      }
      default:
        return null;
    }
  }

  parseNonStreamingUsage(
    parsedBody: Record<string, unknown>,
    fallbackModel: string,
  ): TokenUsage | null {
    if (!parsedBody.id || !parsedBody.usage) return null;
    const empty: TokenUsage = {
      requestId: '',
      model: fallbackModel,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheWriteTokens: null,
      reasoningTokens: 0,
    };
    return usageFromResponseObject(parsedBody, empty);
  }

  canonicalizeModel(model: string): string {
    // Strip a trailing dated snapshot suffix: "gpt-5.6-sol-2026-07-01" ->
    // "gpt-5.6-sol".
    return model.replace(/-\d{4}-\d{2}-\d{2}$/, '');
  }

  computeCost(usage: TokenUsage, config: VendorConfig): bigint | null {
    const pricing = config.pricing[this.canonicalizeModel(usage.model)];
    // Unknown model: fail closed — no cross-model fallback.
    if (!pricing) return null;

    const inPrice = BigInt(pricing.inMicros);
    const outPrice = BigInt(pricing.outMicros);
    const crPrice = BigInt(pricing.cacheReadMicros ?? 0);
    const cwPrice = BigInt(pricing.cacheWriteMicros ?? 0);

    const cacheWrite = usage.cacheWriteTokens ?? 0;
    const cached = usage.cachedInputTokens;
    const uncached = Math.max(0, usage.inputTokens - cached - cacheWrite);

    // Reasoning tokens are a subset of output tokens — never added again.
    return (
      (BigInt(uncached) * inPrice) / MICROS_PER_MILLION +
      (BigInt(cached) * crPrice) / MICROS_PER_MILLION +
      (BigInt(cacheWrite) * cwPrice) / MICROS_PER_MILLION +
      (BigInt(usage.outputTokens) * outPrice) / MICROS_PER_MILLION
    );
  }
}

export const openaiAdapter = new OpenAIAdapter();
