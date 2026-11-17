// OpenAI (GPT) Provider
// Per implementation plan Phase 3.2: GPT via direct API

import OpenAI from 'openai';
import { get_encoding, type Tiktoken } from 'tiktoken';
import { getSecret, getOpenAIApiKeyForGroup, type OpenAIPurposeGroup } from '../../infrastructure/secrets';
import { logger } from '../../infrastructure/logging';
import type {
  LLMProviderClient,
  LLMCompletionRequest,
  LLMCompletionResponse,
  LLMModelTier,
  LLMStopReason,
  LLMTokenCountRequest,
  LLMTokenCountResult,
} from '../types';
import { LLMStructuredOutputError } from '../types';
import { getManagedSecret } from '../../infrastructure/secret-store';

/**
 * Map an OpenAI `finish_reason` to the unified LLMStopReason. OpenAI signals a
 * safety refusal two ways: `finish_reason: 'content_filter'`, OR a populated
 * `message.refusal` string (structured-output / policy refusal, where
 * finish_reason may still be 'stop'). The `hasRefusal` flag (truthiness of
 * `message.refusal`) takes precedence and normalises to 'refusal' — never a
 * successful completion. 'function_call' and anything unrecognised collapse
 * into 'other'. Exported as a pure function so the mapping is unit-testable
 * without mocking the OpenAI SDK.
 */
export function mapOpenAIStopReason(
  finishReason: string | null | undefined,
  hasRefusal: boolean,
): LLMStopReason {
  if (hasRefusal) return 'refusal';
  switch (finishReason) {
    case 'stop':
      return 'end_turn';
    case 'tool_calls':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    default:
      return 'other';
  }
}

// Mapping from OpenAI model name → tiktoken encoder. Date-suffix variants
// (e.g. `gpt-4o-2024-08-06`) are handled in pickEncoder by stripping the
// trailing `-YYYY-MM-DD`. Anything still unknown falls through to a warn-log
// + o200k_base default.
const MODEL_TO_ENCODER: Record<string, 'cl100k_base' | 'o200k_base'> = {
  // o200k family
  'gpt-4o': 'o200k_base', 'gpt-4o-mini': 'o200k_base', 'chatgpt-4o-latest': 'o200k_base',
  'gpt-4.1': 'o200k_base', 'gpt-4.1-mini': 'o200k_base', 'gpt-4.1-nano': 'o200k_base',
  'gpt-5': 'o200k_base', 'gpt-5.4': 'o200k_base', 'gpt-5.4-mini': 'o200k_base', 'gpt-5.4-nano': 'o200k_base',
  'gpt-5.5': 'o200k_base',
  'o1': 'o200k_base', 'o1-mini': 'o200k_base', 'o1-preview': 'o200k_base',
  'o3': 'o200k_base', 'o3-mini': 'o200k_base', 'o4-mini': 'o200k_base',
  // cl100k family
  'gpt-4': 'cl100k_base', 'gpt-4-turbo': 'cl100k_base', 'gpt-4-turbo-preview': 'cl100k_base',
  'gpt-3.5-turbo': 'cl100k_base', 'gpt-3.5-turbo-1106': 'cl100k_base', 'gpt-3.5-turbo-0125': 'cl100k_base',
};

function pickEncoder(model: string): Tiktoken {
  const exact = MODEL_TO_ENCODER[model];
  if (exact) return get_encoding(exact);
  const dateStripped = model.replace(/-\d{4}-\d{2}-\d{2}$/, '');
  const stripped = MODEL_TO_ENCODER[dateStripped];
  if (stripped) return get_encoding(stripped);
  logger.warn({ message: 'unknown openai model for tokenizer; defaulting to o200k_base', model });
  return get_encoding('o200k_base');
}

// The GPT-6 line, mirroring platform-backend's providers/openai.ts (migration
// 527). This table is still read at runtime: it answers when the workspace
// routing policy gives no model for this provider (a per-agent provider
// override, a policy with no OpenAI entry) and when a caller passes only a
// tier. Every id here must have a rate in pricing.ts, or those runs record
// their tokens at zero cost.
//
// The ladder follows the vendor's PRICE list, not the family name: `gpt-6.1-sol`
// is MEDIUM here, where `gpt-5.6-sol` was the top tier.
const DEFAULT_MODEL = 'gpt-6-astra';
const DEFAULT_MAX_TOKENS = 128_000;

export const TIER_MODELS: Record<LLMModelTier, string> = {
  large:    'gpt-6-astra',
  medium:   'gpt-6.1-sol',
  small:    'gpt-6-luna',
};

export class OpenAIProvider implements LLMProviderClient {
  readonly provider = 'openai' as const;
  private client: OpenAI;

  private constructor(client: OpenAI) {
    this.client = client;
  }

  static async create(): Promise<OpenAIProvider | null> {
    // Try environment variable first, then Secret Manager
    let apiKey = getManagedSecret('OPENAI_API_KEY');

    if (!apiKey) {
      try {
        const env = process.env.ENVIRONMENT || 'dev';
        apiKey = await getSecret(`openai-api-key-${env}`);
      } catch (error) {
        logger.error({ message: 'Failed to load OpenAI API key from Secret Manager', error: (error as Error).message });
        return null;
      }
    }

    if (!apiKey) {
      logger.info({ message: 'OpenAI API key not found, provider unavailable' });
      return null;
    }

    const client = new OpenAI({ apiKey });
    logger.info({ message: 'OpenAI provider initialized' });
    return new OpenAIProvider(client);
  }

  /** Build a pool of four purpose-scoped OpenAI instances, one per key group.
   *  Falls back to the legacy single key for any group not yet configured.
   *  Returns null if no OpenAI key is available at all.
   *
   *  Mirrors AnthropicProvider.createPool() and platform-backend's
   *  OpenAIProvider.createPool(). OpenAI is lenient — missing per-group keys
   *  are skipped (not load-bearing for billing visibility), unlike Anthropic
   *  groups which are required. */
  /**
   * An instance that talks to the BYOK gateway instead of OpenAI directly.
   *
   * `baseUrl` carries the `/v1` suffix the SDK appends its own paths to, and
   * `token` is the short-lived per-run gateway credential rather than a
   * customer key. Per call for the same reason as the Anthropic twin: the pool
   * below is keyed by purpose group, not by tenant.
   */
  static createForGateway(baseUrl: string, token: string): OpenAIProvider {
    return new OpenAIProvider(new OpenAI({ apiKey: token, baseURL: baseUrl }));
  }

  static async createPool(): Promise<Map<OpenAIPurposeGroup, OpenAIProvider> | null> {
    const GROUPS: OpenAIPurposeGroup[] = [
      'agent-execution',
      'reflective-services',
      'platform-analytics',
      'background-services',
    ];

    const keys = await Promise.all(GROUPS.map(g => getOpenAIApiKeyForGroup(g)));
    if (keys.every(k => !k)) return null;

    const pool = new Map<OpenAIPurposeGroup, OpenAIProvider>();
    for (let i = 0; i < GROUPS.length; i++) {
      const key = keys[i];
      if (!key) continue;
      pool.set(GROUPS[i], new OpenAIProvider(new OpenAI({ apiKey: key })));
    }
    logger.info({ message: 'OpenAI provider pool initialized', groups: [...pool.keys()] });
    return pool;
  }

  async complete(request: LLMCompletionRequest): Promise<LLMCompletionResponse> {
    const model =
      request.model
      ?? (request.tier ? TIER_MODELS[request.tier] : undefined)
      ?? DEFAULT_MODEL;
    const maxTokens = request.maxTokens || DEFAULT_MAX_TOKENS;
    // The caller's per-call bounds (see LLMCompletionRequest.timeoutMs); the
    // SDK takes them as request options and otherwise keeps its own defaults.
    const perCall = request.timeoutMs !== undefined || request.maxRetries !== undefined
      ? {
          ...(request.timeoutMs !== undefined ? { timeout: request.timeoutMs } : {}),
          ...(request.maxRetries !== undefined ? { maxRetries: request.maxRetries } : {}),
        }
      : undefined;

    const messages = request.messages.map(m => {
      if (m.role === 'tool') {
        return {
          role: 'tool' as const,
          content: m.content,
          tool_call_id: m.toolCallId || '',
        };
      }
      return {
        role: m.role as 'system' | 'user' | 'assistant',
        content: m.content,
        ...(m.toolCalls ? { tool_calls: m.toolCalls.map(tc => ({ id: tc.id, type: 'function' as const, function: { name: tc.name, arguments: JSON.stringify(tc.input) } })) } : {}),
      };
    });

    // Build OpenAI tools from request.tools
    const tools = request.tools?.map(t => {
      // OpenAI doesn't support input_examples natively — embed in description
      const description = t.input_examples
        ? `${t.description}\n\nExamples:\n${t.input_examples.map(ex => JSON.stringify(ex)).join('\n')}`
        : t.description;
      return {
        type: 'function' as const,
        function: {
          name: t.name,
          description,
          parameters: t.input_schema as Record<string, unknown>,
        },
      };
    });

    // If responseSchema is provided, use tool use to enforce structured output.
    // Mirrors the Anthropic providers exactly — schema becomes a single FORCED
    // tool, request.tools is ignored, and `content` carries the JSON — so a
    // caller like chat-feedback-extractor gets the same shape whichever
    // provider its model config resolves to. Before this, google/openai/
    // openrouter silently ignored the field and returned prose, so the caller's
    // JSON.parse threw and the whole extraction batch died.
    //
    // Forced tool call rather than response_format:{type:'json_schema'} because
    // OpenAI's strict json_schema subset requires every property to be required
    // with additionalProperties:false, which our shared JSONSchema values do
    // not guarantee.
    if (request.responseSchema) {
      const schemaName = request.responseSchema.name;
      const structured = await this.client.chat.completions.create({
        model,
        max_completion_tokens: maxTokens,
        temperature: request.temperature,
        messages,
        tools: [{
          type: 'function' as const,
          function: {
            name: schemaName,
            description: request.responseSchema.description
              || `Generate structured output for ${schemaName}`,
            parameters: request.responseSchema.schema as unknown as Record<string, unknown>,
          },
        }],
        tool_choice: { type: 'function' as const, function: { name: schemaName } },
      }, perCall);
      const call = structured.choices[0]?.message?.tool_calls?.[0];
      if (!call || !('function' in call)) {
        throw new LLMStructuredOutputError(this.provider, schemaName);
      }
      return {
        // Already a JSON string on the wire — do not re-stringify.
        content: call.function.arguments || '{}',
        model: structured.model,
        provider: this.provider,
        usage: structured.usage ? {
          inputTokens: structured.usage.prompt_tokens,
          outputTokens: structured.usage.completion_tokens,
          cachedTokens: structured.usage.prompt_tokens_details?.cached_tokens || 0,
        } : undefined,
      };
    }

    const response = await this.client.chat.completions.create({
      model,
      max_completion_tokens: maxTokens,
      temperature: request.temperature,
      messages,
      ...(tools && tools.length > 0 ? { tools } : {}),
    }, perCall);

    const message = response.choices[0]?.message;
    const content = message?.content || '';

    // Parse tool calls from OpenAI response
    const toolCalls = message?.tool_calls?.map(tc => ({
      id: tc.id,
      name: tc.function.name,
      input: JSON.parse(tc.function.arguments || '{}'),
    }));

    // Map OpenAI finish_reason to the unified LLMStopReason. See the exported
    // mapOpenAIStopReason for the two refusal signals it normalises.
    const stopReason = mapOpenAIStopReason(response.choices[0]?.finish_reason, !!message?.refusal);

    return {
      content,
      toolCalls,
      model: response.model,
      provider: this.provider,
      stopReason,
      usage: response.usage ? {
        inputTokens: response.usage.prompt_tokens,
        outputTokens: response.usage.completion_tokens,
        cachedTokens: response.usage.prompt_tokens_details?.cached_tokens || 0,
      } : undefined,
    };
  }

  /** Part 2 — local tiktoken estimate. OpenAI has no public count API for
   *  Chat Completions, so this computes the input length client-side using
   *  the documented per-message overheads. Lands within ±2% of actual
   *  prompt_tokens for typical agent payloads; the live ground-truth test
   *  (count-tokens.live.test.ts) catches drift. Tools and tool calls are
   *  included with the OpenAI-documented overhead constants. */
  async countTokens(request: LLMTokenCountRequest): Promise<LLMTokenCountResult> {
    const enc = pickEncoder(request.model);
    let total = 0;
    if (request.system) total += enc.encode(request.system).length + 4;  // role overhead per OpenAI's documented formula
    for (const msg of request.messages) {
      if (msg.role === 'tool') {
        // tool-role messages carry the result in `content`. The +8 wrapper
        // accounts for the whole entry (role + tool_call_id + content
        // delimiters); it replaces the standard +4 role overhead, not
        // adds to it.
        total += enc.encode(msg.content ?? '').length + 8;
        continue;
      }
      total += enc.encode(msg.content ?? '').length + 4;
      for (const tc of msg.toolCalls ?? []) {
        total += enc.encode(tc.name + JSON.stringify(tc.input)).length + 10;
      }
    }
    for (const tool of request.tools ?? []) {
      total += enc.encode(JSON.stringify(tool)).length + 50;  // ~50 token wrapper per tool
    }
    total += 3;  // every reply primed with `<|start|>assistant<|message|>`
    enc.free();
    return { inputTokens: total, estimated: true };
  }
}
