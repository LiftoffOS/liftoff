// Anthropic (Claude) Direct API Provider
// Uses Anthropic's own API directly (not via Vertex AI).
// Requires ANTHROPIC_API_KEY environment variable or 'anthropic-api-key' secret.

import Anthropic from '@anthropic-ai/sdk';
import {
  getAnthropicApiKey,
  getAnthropicApiKeyForGroup,
  type AnthropicPurposeGroup,
} from '../../infrastructure/secrets';
import { logger } from '../../infrastructure/logging';
import {
  modelRejectsTemperature,
  markTemperatureUnsupported,
  isTemperatureUnsupportedError,
} from './temperature-support';
import type {
  LLMProviderClient,
  LLMCompletionRequest,
  LLMCompletionResponse,
  LLMModelTier,
  LLMStopReason,
  LLMToolCall,
} from '../types';
import { LLMStructuredOutputError } from '../types';
import {
  anthropicModelSurface,
  anthropicStructuredOutputFormat,
} from './anthropic-model-surface';

const DEFAULT_MODEL = 'claude-sonnet-5-5';
const DEFAULT_MAX_TOKENS = 4096;

export const TIER_MODELS: Record<LLMModelTier, string> = {
  large:    'claude-opus-5-5',
  medium:   'claude-sonnet-5-5',
  small:    'claude-haiku-4-5',
};

/**
 * Map an Anthropic `stop_reason` to the unified LLMStopReason. Anthropic emits
 * 'end_turn' / 'tool_use' / 'max_tokens' / 'stop_sequence' / 'refusal'; we
 * collapse 'stop_sequence' (and anything unrecognised) into 'other' since we
 * don't use stop sequences. 'refusal' is emitted when a safety classifier
 * declined (GA on Opus 4.7+) — content is empty (pre-output) or partial and is
 * NEVER a successful completion. Exported as a pure function so the mapping is
 * unit-testable without mocking the Anthropic SDK. It used to have an
 * identical twin in anthropic-vertex.ts, which imported a different SDK
 * package; that provider is retired and this is now the only copy.
 */
export function mapAnthropicStopReason(reason: string | null | undefined): LLMStopReason {
  switch (reason) {
    case 'end_turn':
      return 'end_turn';
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    default:
      return 'other';
  }
}

/**
 * SDK resilience, declared rather than inherited (I1).
 *
 * There is no retry loop in this provider — the SDK's own behaviour IS our
 * resilience, so it is pinned here rather than tracking whatever a dependency
 * bump makes the default. Mirrors the control plane's provider.
 *
 *   429 / 529 / 5xx / timeout / connection error  → retried with backoff
 *   400 / 401 / 403 / 404 / 422                   → NOT retried
 *
 * Retrying auth would mask a key rotation and turn one bad deploy into a
 * thundering herd; giving up on 429/529 would turn ordinary load into a
 * user-visible failure. The SDK does neither, which is the classification we
 * want.
 *
 * The timeout is generous on purpose: a large-tier model on a long tool-calling
 * turn legitimately runs for minutes. It exists to stop a hung socket holding a
 * request open forever, not to bound normal latency.
 */
const SDK_MAX_RETRIES = 3;
const SDK_TIMEOUT_MS = 10 * 60_000;

/**
 * A caller's per-call bounds, as the SDK's request options. A short call on a
 * run's critical path (HyDE) must not inherit the ten-minute, four-attempt
 * budget above: on a dead pooled connection the request waits for exactly that
 * timer. Undefined when the caller set neither, so the client defaults apply.
 */
function perCallRequestOptions(request: LLMCompletionRequest): Anthropic.RequestOptions | undefined {
  if (request.timeoutMs === undefined && request.maxRetries === undefined) return undefined;
  return {
    ...(request.timeoutMs !== undefined ? { timeout: request.timeoutMs } : {}),
    ...(request.maxRetries !== undefined ? { maxRetries: request.maxRetries } : {}),
  };
}

export class AnthropicProvider implements LLMProviderClient {
  readonly provider = 'anthropic' as const;
  private client: Anthropic;
  /** Purpose group this provider instance serves; null for the un-pooled
   *  singleton from AnthropicProvider.create(). Used by Part 5 §F to record
   *  per-pool 429 attempts into the ring buffer that drives the delegation
   *  soft-throttle. */
  private readonly group: import('../../infrastructure/secrets').AnthropicPurposeGroup | null;

  private constructor(client: Anthropic, group: import('../../infrastructure/secrets').AnthropicPurposeGroup | null = null) {
    this.client = client;
    this.group = group;
  }

  static async create(): Promise<AnthropicProvider | null> {
    const apiKey = await getAnthropicApiKey();
    if (!apiKey) {
      logger.info({ message: 'Anthropic API key not configured, direct provider unavailable' });
      return null;
    }

    try {
      const client = new Anthropic({ apiKey, maxRetries: SDK_MAX_RETRIES, timeout: SDK_TIMEOUT_MS });
      logger.info({ message: 'Anthropic (direct API) provider initialized' });
      return new AnthropicProvider(client);
    } catch (error) {
      logger.warn({
        message: 'Failed to initialize Anthropic direct provider',
        error: (error as Error).message,
      });
      return null;
    }
  }

  /**
   * An instance that talks to the BYOK gateway instead of Anthropic directly.
   *
   * `token` is the short-lived per-run gateway credential, never a customer
   * key: the real key is attached on the far side, out of reach of anything
   * that can read this process. The SDK sends it as `x-api-key`, which is what
   * the gateway reads.
   *
   * Per call rather than pooled, because the credential is per (tenant, run)
   * and the pool below is keyed by purpose group. A per-tenant credential
   * cannot ride it as-is.
   */
  static createForGateway(baseUrl: string, token: string): AnthropicProvider {
    return new AnthropicProvider(
      new Anthropic({
        apiKey: token,
        baseURL: baseUrl,
        maxRetries: SDK_MAX_RETRIES,
        timeout: SDK_TIMEOUT_MS,
      }),
    );
  }

  /** Create a pool of four purpose-scoped providers keyed by `AnthropicPurposeGroup`.
   *
   *  Each group maps to a dedicated Anthropic API key, enabling independent
   *  billing visibility and blast-radius isolation per function category.
   *  Falls back to the legacy `anthropic-api-key` secret for any group whose
   *  purpose-specific key is not yet configured — safe to deploy before all
   *  keys are provisioned. */
  static async createPool(): Promise<Map<AnthropicPurposeGroup, AnthropicProvider> | null> {
    const groups: AnthropicPurposeGroup[] = [
      'agent-execution',
      'reflective-services',
      'platform-analytics',
      'background-services',
    ];

    const keys = await Promise.all(groups.map(g => getAnthropicApiKeyForGroup(g)));

    // If not a single key resolved, the provider is entirely unconfigured.
    if (keys.every(k => !k)) {
      logger.info({ message: 'No Anthropic API keys configured, provider pool unavailable' });
      return null;
    }

    const pool = new Map<AnthropicPurposeGroup, AnthropicProvider>();
    for (let i = 0; i < groups.length; i++) {
      const resolvedKey = keys[i];
      if (!resolvedKey) {
        throw new Error(
          `No Anthropic API key configured for purpose group '${groups[i]}' — ` +
          `add secret anthropic-api-key-${groups[i]}-{env} to Secret Manager`,
        );
      }
      pool.set(
          groups[i],
          new AnthropicProvider(
            new Anthropic({ apiKey: resolvedKey, maxRetries: SDK_MAX_RETRIES, timeout: SDK_TIMEOUT_MS }),
            groups[i],
          ),
        );
    }

    logger.info({ message: 'Anthropic provider pool initialized', groups });
    return pool;
  }

  async complete(request: LLMCompletionRequest): Promise<LLMCompletionResponse> {
    const modelName =
      request.model
      ?? (request.tier ? TIER_MODELS[request.tier] : undefined)
      ?? DEFAULT_MODEL;
    const maxTokens = request.maxTokens || DEFAULT_MAX_TOKENS;
    const perCall = perCallRequestOptions(request);

    // Extract system message if present
    const systemMessage = request.messages.find(m => m.role === 'system');
    // Build Anthropic-shaped messages from the unified LLMMessage list. The
    // unified shape uses role:'tool' for tool results and a `toolCalls`
    // array on assistant messages; Anthropic's wire format encodes both as
    // typed content blocks (`tool_use` for the assistant's request,
    // `tool_result` for the user-side result) instead of separate roles.
    // The previous implementation cast every non-system role to 'user' |
    // 'assistant', which dropped both tool_use and tool_result blocks and
    // produced messages Anthropic rejects with "tool_use ids must have
    // matching tool_result blocks in the next user message".
    const conversationMessages = this.buildAnthropicMessages(request.messages);

    // ── responseSchema: structured outputs, falling back to a tool ────────
    //
    // A caller asking for a responseSchema wants schema-shaped JSON, not a tool
    // call. Handing it a single tool and FORCING it was once the only way to
    // get that. Two things have changed since.
    //
    //  * `output_config.format` constrains the DECODER, so the guarantee no
    //    longer depends on the model choosing to call something.
    //  * Opus 5.5 REJECTS a forced tool choice outright — `tool_choice` `any`
    //    and `tool` return 400 — so the old line was a latent break the moment
    //    a caller's tier resolved there.
    //
    // Both routes stay: a model without structured outputs, or a schema the
    // constrained decoder will not take, falls through to the tool — with the
    // forced choice translated to `auto` plus an instruction where the vendor
    // no longer accepts forcing. LLMStructuredOutputError still covers a model
    // that declines.
    if (request.responseSchema) {
      const surface = anthropicModelSurface(modelName);
      const format = anthropicStructuredOutputFormat(modelName, request.responseSchema.schema);

      if (format) {
        const response = await this.createWithStats({
          model: modelName,
          max_tokens: maxTokens,
          temperature: request.temperature,
          system: systemMessage?.content,
          messages: conversationMessages,
          output_config: { format },
        }, perCall);

        // A constrained decode emits the JSON as text; there is no tool_use
        // block to unwrap.
        const text = response.content
          .filter((c): c is Anthropic.TextBlock => c.type === 'text')
          .map((c) => c.text)
          .join('');
        if (!text.trim()) {
          throw new LLMStructuredOutputError(this.provider, request.responseSchema.name);
        }

        return {
          content: text,
          model: modelName,
          provider: this.provider,
          usage: {
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
            cachedTokens: (response.usage as { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number }).cache_read_input_tokens || 0,
          },
        };
      }

      const tool: Anthropic.Tool = {
        name: request.responseSchema.name,
        description: request.responseSchema.description || `Generate structured output for ${request.responseSchema.name}`,
        input_schema: request.responseSchema.schema as Anthropic.Tool.InputSchema,
      };

      const instruction = surface.acceptsForcedToolChoice
        ? null
        : `You must call the ${tool.name} tool to answer this request. Do not reply with plain text.`;

      const response = await this.createWithStats({
        model: modelName,
        max_tokens: maxTokens,
        temperature: request.temperature,
        system: instruction
          ? [systemMessage?.content, instruction].filter(Boolean).join('\n\n')
          : systemMessage?.content,
        messages: conversationMessages,
        tools: [tool],
        tool_choice: surface.acceptsForcedToolChoice
          ? { type: 'tool', name: tool.name }
          : { type: 'auto' },
      }, perCall);

      const toolUse = response.content.find(c => c.type === 'tool_use');
      if (!toolUse || toolUse.type !== 'tool_use') {
        throw new LLMStructuredOutputError(this.provider, tool.name);
      }

      return {
        content: JSON.stringify(toolUse.input),
        model: modelName,
        provider: this.provider,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          cachedTokens: (response.usage as { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number }).cache_read_input_tokens || 0,
        },
      };
    }

    // Build tools array if provided
    const tools = request.tools?.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema as Anthropic.Tool.InputSchema,
      ...(t.input_examples ? { input_examples: t.input_examples } : {}),
    }));

    // Standard completion with optional tools
    const response = await this.createWithStats({
      model: modelName,
      max_tokens: maxTokens,
      temperature: request.temperature,
      system: systemMessage?.content,
      messages: conversationMessages,
      tools,
    }, perCall);

    // Extract text content
    const content = response.content
      .filter(block => block.type === 'text')
      .map(block => (block as { type: 'text'; text: string }).text)
      .join('');

    // Extract tool calls if any
    const toolCalls: LLMToolCall[] = response.content
      .filter(block => block.type === 'tool_use')
      .map(block => {
        const toolUse = block as Anthropic.ToolUseBlock;
        return {
          id: toolUse.id,
          name: toolUse.name,
          input: toolUse.input as Record<string, unknown>,
        };
      });

    // Map Anthropic stop_reason to the unified LLMStopReason (see the exported
    // mapAnthropicStopReason for the full rationale).
    const stopReason = mapAnthropicStopReason(response.stop_reason);

    return {
      content,
      model: modelName,
      provider: this.provider,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      stopReason,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cachedTokens: (response.usage as { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number }).cache_read_input_tokens || 0,
      },
    };
  }

  /** Part 5 §F — wraps `this.client.messages.create` to record one sample
   *  per attempt into the per-group ring buffer that drives the delegation
   *  soft-throttle. 429s are observed but not retried here — the Anthropic
   *  SDK's built-in maxRetries already handles the retry; we only need the
   *  rate signal. */
  private async createWithStats(
    params: Anthropic.MessageCreateParamsNonStreaming,
    perCall?: Anthropic.RequestOptions,
  ): Promise<Anthropic.Message> {
    // Claude 5+ models (e.g. claude-opus-5) reject `temperature`; once we've
    // learned a model does, omit it up front rather than 400 again.
    if (params.temperature !== undefined && modelRejectsTemperature(params.model)) {
      const rest = { ...params };
      delete rest.temperature;
      params = rest;
    }
    try {
      const result = await this.client.messages.create(params, perCall);
      if (this.group) {
        // Late-bind the recorder so the import doesn't load when not pooled.
        const { recordAnthropicAttempt } = await import('../anthropic-pool-stats');
        recordAnthropicAttempt(this.group, false);
      }
      return result;
    } catch (err) {
      // First time a model rejects `temperature`: remember it, strip the param,
      // retry once. The retry carries no temperature, so it can't loop here.
      if (params.temperature !== undefined && isTemperatureUnsupportedError(err)) {
        markTemperatureUnsupported(params.model);
        logger.warn({ message: 'anthropic: model rejects temperature; retrying without it', model: params.model });
        const rest = { ...params };
        delete rest.temperature;
        return this.createWithStats(rest, perCall);
      }
      if (this.group) {
        const status = (err as { status?: number }).status;
        const { recordAnthropicAttempt } = await import('../anthropic-pool-stats');
        recordAnthropicAttempt(this.group, status === 429);
      }
      throw err;
    }
  }

  /** Part 2 — exact API-backed token count via Anthropic's messages.countTokens.
   *  GA in @anthropic-ai/sdk ≥0.30.0; no `anthropic-beta` header required. Tool
   *  definitions are included in `input_tokens` count by the API. When
   *  `thinking` is supplied, the count reflects the thinking budget the model
   *  would reserve. */
  async countTokens(request: import('../types').LLMTokenCountRequest): Promise<import('../types').LLMTokenCountResult> {
    const messages = this.buildAnthropicMessages(request.messages);
    const tools = request.tools?.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema as Anthropic.Tool.InputSchema,
      ...(t.input_examples ? { input_examples: t.input_examples } : {}),
    }));
    const result = await this.client.messages.countTokens({
      model: request.model,
      ...(request.system ? { system: request.system } : {}),
      messages,
      ...(tools && tools.length > 0 ? { tools } : {}),
      ...(request.thinking ? { thinking: request.thinking } : {}),
    } as Anthropic.MessageCountTokensParams);
    return { inputTokens: result.input_tokens, estimated: false };
  }

  /**
   * Translate the unified LLMMessage[] into Anthropic's MessageParam[] shape.
   *
   * Unified shape: { role: 'system'|'user'|'assistant'|'tool', content, toolCallId?, toolCalls? }
   * Anthropic shape: { role: 'user'|'assistant', content: string | ContentBlockParam[] }
   *
   * Mapping rules:
   *   - system messages: filtered out (Anthropic takes them in a separate `system` field)
   *   - user/assistant text-only messages: pass through with string content
   *   - assistant messages with toolCalls: content becomes an array of
   *     { type: 'text', text } + one { type: 'tool_use', id, name, input }
   *     block per tool call. Anthropic rejects assistant messages that have
   *     tool_use blocks but no matching tool_result in the next user turn.
   *   - tool messages: become user messages with a single
   *     { type: 'tool_result', tool_use_id, content } block. The unified
   *     shape only carries one tool result per message, but Anthropic
   *     allows multiple tool_result blocks in one user message — for
   *     simplicity we keep them as one-per-message and rely on the
   *     subsequent assistant message to follow the same call/result
   *     pairing the unified shape already enforces.
   */
  private buildAnthropicMessages(messages: LLMCompletionRequest['messages']): Anthropic.MessageParam[] {
    const result: Anthropic.MessageParam[] = [];
    for (const msg of messages) {
      if (msg.role === 'system') continue;

      if (msg.role === 'tool') {
        result.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: msg.toolCallId || '',
              content: msg.content,
            },
          ],
        });
        continue;
      }

      if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
        const blocks: Anthropic.ContentBlockParam[] = [];
        if (msg.content && msg.content.trim().length > 0) {
          blocks.push({ type: 'text', text: msg.content });
        }
        for (const tc of msg.toolCalls) {
          blocks.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: tc.input as Record<string, unknown>,
          });
        }
        result.push({ role: 'assistant', content: blocks });
        continue;
      }

      // Plain text user/assistant message.
      result.push({
        role: msg.role as 'user' | 'assistant',
        content: msg.content,
      });
    }
    return result;
  }
}
