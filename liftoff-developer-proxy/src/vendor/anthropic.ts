// AnthropicAdapter — implements VendorAdapter for api.anthropic.com.
// The single Anthropic adapter path.

import type {
  VendorAdapter,
  VendorConfig,
  ParsedSseEvent,
  TokenUsage,
  LifecycleSignal,
  RequestCorrelation,
} from './adapter.js';

const ALLOWED_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  'content-type',
  'anthropic-version',
  'anthropic-beta',
]);

const SAFE_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
  'content-type',
  'request-id',
  'x-request-id',
  'retry-after',
  'anthropic-ratelimit-requests-limit',
  'anthropic-ratelimit-requests-remaining',
  'anthropic-ratelimit-requests-reset',
  'anthropic-ratelimit-tokens-limit',
  'anthropic-ratelimit-tokens-remaining',
  'anthropic-ratelimit-tokens-reset',
]);

const MICROS_PER_MILLION = 1_000_000n;

// Strip trailing date suffix: "claude-sonnet-4-6-20251022" → "claude-sonnet-4-6"
function modelKey(model: string): string {
  return model.replace(/-\d{8}$/, '');
}

// Liftoff route path -> operation. Both the bare /v1 namespace and the
// /claude-code prefix map to the same operations (operation mapping).
const OPERATION_MAP: Record<string, string> = {
  '/v1/messages': 'messages.create',
  '/v1/messages/count_tokens': 'messages.count_tokens',
  '/claude-code/v1/messages': 'messages.create',
  '/claude-code/v1/messages/count_tokens': 'messages.count_tokens',
};

export class AnthropicAdapter implements VendorAdapter {
  readonly vendor = 'anthropic';

  classifyOperation(method: string, path: string): string | null {
    if (method !== 'POST') return null;
    const clean = path.split('?')[0];
    return OPERATION_MAP[clean] ?? null;
  }

  buildUpstreamUrl(path: string, config: VendorConfig): URL {
    // Adapter-owned path translation: strip the /claude-code Liftoff namespace
    // prefix; never append the inbound URL verbatim.
    const clean = path.split('?')[0];
    const upstreamPath = clean.startsWith('/claude-code/')
      ? clean.slice('/claude-code'.length)
      : clean;
    return new URL(upstreamPath, config.baseUrl);
  }

  buildAuthHeaders(apiKey: string): Record<string, string> {
    return { 'x-api-key': apiKey };
  }

  getAllowedRequestHeaders(): ReadonlySet<string> {
    return ALLOWED_REQUEST_HEADERS;
  }

  getSafeResponseHeaders(): ReadonlySet<string> {
    return SAFE_RESPONSE_HEADERS;
  }

  extractCorrelation(
    headers: Record<string, string | string[] | undefined>,
  ): RequestCorrelation {
    const h = (k: string): string | undefined => {
      const v = headers[k];
      return typeof v === 'string' ? v : undefined;
    };
    return { sessionId: h('x-claude-code-session-id') };
  }

  normalizeRequestBody(_parsedBody: Record<string, unknown>, rawBody: Buffer): Buffer {
    // Verbatim passthrough: Claude Code bodies are forwarded byte-for-byte.
    return rawBody;
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

    if (event.type === 'message_start') {
      const msg = obj.message as Record<string, unknown> | undefined;
      const usage = msg?.usage as Record<string, number> | undefined;
      const cacheWrite = current.cacheCreationInputTokens + (usage?.cache_creation_input_tokens ?? 0);
      return {
        ...current,
        requestId: (msg?.id as string | undefined) ?? current.requestId,
        model:     (msg?.model as string | undefined) ?? current.model,
        inputTokens:              current.inputTokens + (usage?.input_tokens ?? 0),
        cachedInputTokens:        current.cachedInputTokens + (usage?.cache_read_input_tokens ?? 0),
        cacheCreationInputTokens: cacheWrite,
        cacheWriteTokens:         cacheWrite,
      };
    }

    if (event.type === 'message_delta') {
      const usage = obj.usage as Record<string, number> | undefined;
      return {
        ...current,
        outputTokens: current.outputTokens + (usage?.output_tokens ?? 0),
      };
    }

    return current;
  }

  extractLifecycle(event: ParsedSseEvent): LifecycleSignal | null {
    if (event.type === 'message_stop') return { status: 'completed' };
    if (event.type === 'error') {
      const obj = event.data as Record<string, unknown>;
      const err = obj.error as Record<string, unknown> | undefined;
      return { status: 'failed', errorCategory: (err?.type as string) ?? 'provider_error' };
    }
    return null;
  }

  parseNonStreamingUsage(
    parsedBody: Record<string, unknown>,
    fallbackModel: string,
  ): TokenUsage | null {
    if (!parsedBody.id || !parsedBody.usage) return null;
    const usageObj = parsedBody.usage as Record<string, number>;
    const cacheWrite = usageObj.cache_creation_input_tokens ?? 0;
    return {
      requestId:                parsedBody.id as string,
      model:                    (parsedBody.model as string) ?? fallbackModel,
      inputTokens:              usageObj.input_tokens ?? 0,
      outputTokens:             usageObj.output_tokens ?? 0,
      cachedInputTokens:        usageObj.cache_read_input_tokens ?? 0,
      cacheCreationInputTokens: cacheWrite,
      cacheWriteTokens:         cacheWrite,
    };
  }

  canonicalizeModel(model: string): string {
    return modelKey(model);
  }

  computeCost(usage: TokenUsage, config: VendorConfig): bigint | null {
    const key = modelKey(usage.model);
    const pricing = config.pricing[key];

    // Unknown model: fail closed — no cross-model fallback.
    if (!pricing) return null;

    const inPrice   = BigInt(pricing.inMicros);
    const outPrice  = BigInt(pricing.outMicros);
    const crPrice   = BigInt(pricing.cacheReadMicros  ?? 0);
    const cwPrice   = BigInt(pricing.cacheWriteMicros ?? 0);

    return (
      (BigInt(usage.inputTokens)               * inPrice  ) / MICROS_PER_MILLION +
      (BigInt(usage.outputTokens)              * outPrice ) / MICROS_PER_MILLION +
      (BigInt(usage.cachedInputTokens)         * crPrice  ) / MICROS_PER_MILLION +
      (BigInt(usage.cacheCreationInputTokens)  * cwPrice  ) / MICROS_PER_MILLION
    );
  }
}

export const anthropicAdapter = new AnthropicAdapter();
