// Anthropic (Claude) Provider
// The direct API path, and now the only one: Claude served over Google Vertex
// is retired, so this provider's twin is gone. Tool/stream normalization still
// lives in anthropic-shared.ts, which is now shared with the call sites rather
// than with a second provider.
import Anthropic from '@anthropic-ai/sdk';
import {
  getAnthropicApiKey,
  getAnthropicApiKeyForGroup,
  type AnthropicPurposeGroup,
} from '../../infrastructure/secrets';
import { log } from '../../infrastructure/logging';
import { liftoffifyString } from '../../branding/registry';
import type {
  LLMProviderClient,
  LLMCompletionRequest,
  LLMCompletionResponse,
  LLMModelTier,
  LLMStreamEvent,
  LLMStopReason,
  LLMToolCall,
} from '../types';
import {
  adaptToolChoiceForModel,
  anthropicModelSurface,
  anthropicOutputConfig,
  anthropicThinkingConfig,
  applyRegistryModelSurfaces,
  anthropicStructuredOutputFormat,
  appendSystemInstruction,
  buildAnthropicMessages,
  buildAnthropicSystemParam,
  extractCacheTokens,
  anthropicContextTokens,
  extractWebFetchRequests,
  extractWebSearchRequests,
  mapAnthropicStopReason,
  toAnthropicToolChoice,
  toAnthropicTools,
} from './anthropic-shared';
import { safeParseJsonObject } from './json-utils';

export const DEFAULT_MODEL = 'claude-opus-5-5';
const DEFAULT_MAX_TOKENS = 4096;

export const TIER_MODELS: Record<LLMModelTier, string> = {
  large:    'claude-opus-5-5',
  medium:   'claude-sonnet-5-5',
  // Haiku 5.5 — a tenth of Haiku 4.5's input rate, and the busiest path here.
  // It has NO entry in LEGACY_SURFACES, which is the conservative direction and
  // deliberate: it gets no `temperature` (the vendor says to omit it), no
  // forced tool choice, and no `output_config`. A small-tier caller that passed
  // `temperature` silently stops passing it, and one that forced a tool now
  // takes the tool-choice translation in anthropic-shared.ts. Adding an entry
  // later is an optimisation, not a rescue.
  small:    'claude-haiku-5-5',
};

/** Strip parameters that the resolved model doesn't support before passing
 *  the args object to `this.client.messages.create()` /
 *  `this.client.messages.stream()`. No-op for models without an entry in
 *  `MODEL_SURFACES`. Currently only filters `temperature`; the tool-choice and
 *  effort halves of the surface are applied at the call sites, because both
 *  have to touch `system` / `output_config` rather than merely remove a key.
 *
 *  The surface itself lives in anthropic-shared.ts rather than in the unified
 *  llmClient, because the capability is vendor-specific: OpenAI and Google
 *  still accept `temperature` on every model, and mirroring it into the
 *  dispatcher would couple it to Anthropic's model lifecycle.
 *
 *  Why strip-on-call instead of strip-at-build-time: callers (e.g. distill)
 *  set `temperature` for the request as a whole; the same request can be
 *  retried against multiple models if the primary one is rate-limited.
 *  Filtering at the call site preserves the request shape for retries on
 *  models that still accept the parameter. */
function dropUnsupportedParams<T extends { temperature?: number | undefined }>(
  modelId: string,
  args: T,
): T {
  if (!anthropicModelSurface(modelId).acceptsTemperature && args.temperature !== undefined) {
    const { temperature: _drop, ...rest } = args;
    return rest as unknown as T;
  }
  return args;
}

/** The live tier→model map: TIER_MODELS overlaid with the `models` registry by
 *  registry-tier-loader on a 60s refresh. Module-level rather than per-instance
 *  because every instance of this provider routes the same tiers. */
let activeTierModels: Record<LLMModelTier, string> = { ...TIER_MODELS };

/** Resolve the model ID for this provider. Explicit `model` wins over `tier`;
 *  if neither is set, falls back to DEFAULT_MODEL. No automatic fallback on
 *  invalid tier-resolved IDs — callers tolerate provider errors via their
 *  own catch blocks (e.g. fire-and-forget). */
function resolveModel(request: LLMCompletionRequest): string {
  if (request.model) return request.model;
  if (request.tier) return activeTierModels[request.tier];
  return DEFAULT_MODEL;
}

/**
 * SDK resilience, declared rather than inherited (I1).
 *
 * This provider has no retry loop of its own — a failed call surfaces as an
 * error event and the CALLER decides what to do. That leaves the SDK's own
 * behaviour as the whole of our resilience story, so it is pinned here instead
 * of tracking whatever a dependency bump makes the default.
 *
 * What the SDK retries, and what we rely on:
 *
 *   429 rate limit      retried with backoff, honouring retry-after
 *   529 overloaded      retried with backoff
 *   500 / 502 / 503     retried with backoff
 *   408 / timeout       retried with backoff
 *   connection errors   retried with backoff
 *   400 bad request     NOT retried — the request is wrong, repeating it wastes time
 *   401 / 403 auth      NOT retried — a bad key does not become good; retrying
 *                       an auth failure is how a rotation outage turns into a
 *                       thundering herd
 *   404 / 422           NOT retried
 *
 * That classification is the one we want: the only dangerous mistake here would
 * be retrying auth (masking a rotation problem) or giving up on 429/529 (turning
 * ordinary load into user-visible failure), and the SDK does neither.
 *
 * The timeout is generous because a large-tier model on a long tool-calling turn
 * legitimately takes minutes; it exists to stop a hung socket holding a request
 * open indefinitely, not to bound normal latency.
 */
const SDK_MAX_RETRIES = 3;
const SDK_TIMEOUT_MS = 10 * 60_000;

export class AnthropicProvider implements LLMProviderClient {
  /** The model this request would run against. Same resolution the call
   *  itself does — explicit model, then tier, then this provider's default —
   *  exposed so a caller can ask before it builds the request. */
  resolveModelId(request: LLMCompletionRequest): string {
    return resolveModel(request);
  }

  /** Overlay registry-sourced tier→model ids onto the static TIER_MODELS seed.
   *  Called by registry-tier-loader; a tier absent from the registry keeps its
   *  seed value. */
  applyRegistryTierModels(overrides: Partial<Record<LLMModelTier, string>>): void {
    activeTierModels = { ...TIER_MODELS, ...overrides };
  }

  /** Overlay registry-sourced REQUEST SURFACES onto the static table. Forwarded
   *  to anthropic-shared, which owns the table and the merge, so the loader
   *  never imports it and it never reads a database. */
  applyRegistrySurfaces(surfaces: Record<string, Record<string, unknown>>): void {
    applyRegistryModelSurfaces(surfaces);
  }

  readonly provider = 'anthropic' as const;
  private client: Anthropic;

  private constructor(client: Anthropic) {
    this.client = client;
  }

  static async create(): Promise<AnthropicProvider | null> {
    const apiKey = await getAnthropicApiKey();
    if (!apiKey) {
      log.info('Anthropic API key not configured, provider unavailable');
      return null;
    }

    const client = new Anthropic({ apiKey, maxRetries: SDK_MAX_RETRIES, timeout: SDK_TIMEOUT_MS });
    log.info('Anthropic provider initialized');
    return new AnthropicProvider(client);
  }

  /**
   * An instance that talks to the BYOK gateway instead of Anthropic directly.
   *
   * `token` is the short-lived per-run gateway credential, never a customer
   * key: the real key is attached on the far side, out of reach of anything
   * that can read this process's memory or environment. The SDK sends it as
   * `x-api-key`, which is exactly what the gateway reads.
   *
   * Per-call rather than pooled, because the credential is per (tenant, run)
   * and the boot-time pools are keyed by purpose group. A per-tenant credential
   * cannot ride them as-is, which is the note in the plan's step 7.
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
      log.info('No Anthropic API keys configured, provider pool unavailable');
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
        new AnthropicProvider(new Anthropic({
          apiKey: resolvedKey,
          maxRetries: SDK_MAX_RETRIES,
          timeout: SDK_TIMEOUT_MS,
        })),
      );
    }

    log.info({ groups }, 'Anthropic provider pool initialized');
    return pool;
  }

  async complete(request: LLMCompletionRequest): Promise<LLMCompletionResponse> {
    const model = resolveModel(request);
    const maxTokens = request.maxTokens || DEFAULT_MAX_TOKENS;

    // Separate system message from other messages
    const conversationMessages = buildAnthropicMessages(request);

    // ── responseSchema: structured outputs, falling back to a forced tool ──
    //
    // A caller asking for a responseSchema wants schema-shaped JSON, not a tool
    // call. Handing it a single tool and forcing it used to be the only way to
    // get that; `output_config.format` is the vendor's real
    // answer, and it constrains the DECODER rather than relying on the model
    // being told to call something. That matters more since Opus 5.5 removed
    // forced tool use: on the tool route this request now degrades to `auto`
    // plus an instruction, which is a request rather than a guarantee.
    //
    // Null when the model does not support structured outputs or the schema
    // uses something the constrained decoder rejects — both fall through to the
    // route below, unchanged.
    if (request.responseSchema) {
      const format = anthropicStructuredOutputFormat(model, request.responseSchema.schema);
      if (format) {
        const effortConfig = anthropicOutputConfig(model, request.effort);
        const response = await this.client.messages.create(
          dropUnsupportedParams(model, {
            model,
            max_tokens: maxTokens,
            temperature: request.temperature,
            system: buildAnthropicSystemParam(request.messages),
            messages: conversationMessages,
            output_config: { ...(effortConfig ?? {}), format },
          }),
        );

        // The answer IS the text: a constrained decode emits the JSON directly,
        // with no tool_use block to unwrap.
        const text = response.content
          .filter((c): c is Anthropic.TextBlock => c.type === 'text')
          .map((c) => c.text)
          .join('');
        if (!text.trim()) {
          throw new Error('Expected structured output but got none');
        }

        const cache = extractCacheTokens(response.usage);
        return {
          content: text,
          model: response.model,
          provider: this.provider,
          usage: {
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
            webSearchRequests: extractWebSearchRequests(response.usage),
            webFetchRequests: extractWebFetchRequests(response.usage),
            cacheWriteTokens: cache.cacheWriteTokens,
            cacheReadTokens: cache.cacheReadTokens,
            contextTokens: anthropicContextTokens(
              response.usage.input_tokens, cache.cacheWriteTokens, cache.cacheReadTokens,
            ),
          },
        };
      }

      const tool: Anthropic.Tool = {
        name: request.responseSchema.name,
        description: request.responseSchema.description || `Generate structured output for ${request.responseSchema.name}`,
        input_schema: request.responseSchema.schema as Anthropic.Tool.InputSchema,
      };

      // A forced single tool call is how this path has always guaranteed a
      // schema-shaped answer, and Opus 5.5 rejects the parameter outright.
      // Translate to `auto` plus the instruction that replaces it; the
      // "expected tool use" throw below is what covers a model that declines.
      const forced = adaptToolChoiceForModel(model, { type: 'tool', name: tool.name });
      const response = await this.client.messages.create(
        dropUnsupportedParams(model, {
          model,
          max_tokens: maxTokens,
          temperature: request.temperature,
          system: appendSystemInstruction(
            buildAnthropicSystemParam(request.messages),
            forced.instruction,
          ),
          messages: conversationMessages,
          tools: [tool],
          ...(forced.toolChoice ? { tool_choice: forced.toolChoice } : {}),
          ...(anthropicOutputConfig(model, request.effort)
            ? { output_config: anthropicOutputConfig(model, request.effort) }
            : {}),
        }),
      );

      // Extract the tool use content
      const toolUse = response.content.find(c => c.type === 'tool_use');
      if (toolUse?.type !== 'tool_use') {
        throw new Error('Expected tool use response but got none');
      }

      const { cacheWriteTokens, cacheReadTokens } = extractCacheTokens(response.usage);
      return {
        content: JSON.stringify(toolUse.input),
        model: response.model,
        provider: this.provider,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          webSearchRequests: extractWebSearchRequests(response.usage),
          webFetchRequests: extractWebFetchRequests(response.usage),
          cacheWriteTokens,
          cacheReadTokens,
          contextTokens: anthropicContextTokens(response.usage.input_tokens, cacheWriteTokens, cacheReadTokens),
        },
      };
    }

    // ── General-tools path (Phase 4) ──────────────────────────────────────
    const tools = toAnthropicTools(request.tools, request.serverTools, { model });
    const forced = adaptToolChoiceForModel(model, toAnthropicToolChoice(request.toolChoice));
    const outputConfig = anthropicOutputConfig(model, request.effort);

    const response = await this.client.messages.create(
      dropUnsupportedParams(model, {
        model,
        max_tokens: maxTokens,
        temperature: request.temperature,
        system: appendSystemInstruction(
          buildAnthropicSystemParam(request.messages),
          forced.instruction,
        ),
        messages: conversationMessages,
        ...(tools ? { tools } : {}),
        ...(forced.toolChoice ? { tool_choice: forced.toolChoice } : {}),
        ...(outputConfig ? { output_config: outputConfig } : {}),
      }),
    );

    let content = '';
    const toolCalls: LLMToolCall[] = [];
    for (const block of response.content) {
      if (block.type === 'text') {
        content += block.text;
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          input: (block.input ?? {}) as Record<string, unknown>,
        });
      }
    }

    const { cacheWriteTokens: cwt, cacheReadTokens: crt } = extractCacheTokens(response.usage);
    const stopReason = mapAnthropicStopReason(response.stop_reason);
    return {
      content,
      model: response.model,
      provider: this.provider,
      stopReason,
      refusalCategory: stopReason === 'refusal' ? 'refusal' : undefined,
      toolCalls: toolCalls.length ? toolCalls : undefined,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        webSearchRequests: extractWebSearchRequests(response.usage),
        webFetchRequests: extractWebFetchRequests(response.usage),
        cacheWriteTokens: cwt,
        cacheReadTokens: crt,
        contextTokens: anthropicContextTokens(response.usage.input_tokens, cwt, crt),
      },
    };
  }

  /** Stream a completion as a sequence of normalized events.
   *
   *  Implementation is byte-identical to the Vertex provider — same SDK
   *  surface, same event names. The only difference is the underlying
   *  client constructor (this.client is `@anthropic-ai/sdk`'s Anthropic). */
  async *completeStream(request: LLMCompletionRequest): AsyncIterable<LLMStreamEvent> {
    const modelName = resolveModel(request);
    const maxTokens = request.maxTokens || DEFAULT_MAX_TOKENS;
    const conversationMessages = buildAnthropicMessages(request);
    const tools = toAnthropicTools(request.tools, request.serverTools, { model: modelName });
    const forced = adaptToolChoiceForModel(modelName, toAnthropicToolChoice(request.toolChoice));
    const outputConfig = anthropicOutputConfig(modelName, request.effort);
    // Asked for only on this path: it is what keeps a streamed turn from going
    // silent between tool calls (see anthropicThinkingConfig). When it is set,
    // a `thinking` block is the model's progress note — written for the person
    // reading the stream — and is forwarded as text below. When it is NOT set,
    // a `thinking` block is reasoning and must never reach a person, so it is
    // dropped exactly as it always has been.
    const thinkingConfig = anthropicThinkingConfig(modelName, request.effort);
    const narratesBetweenTools = !!thinkingConfig;

    type Accum =
      | { kind: 'text' }
      | { kind: 'thinking' }
      | { kind: 'tool_use'; id: string; name: string; jsonBuffer: string };
    const blocks = new Map<number, Accum>();

    let stopReason: LLMStopReason = 'end_turn';
    let inputTokens = 0;
    let outputTokens = 0;
    let webSearchRequests = 0;
    let webFetchRequests = 0;
    let cacheWriteTokens = 0;
    let cacheReadTokens = 0;

    try {
      const stream = this.client.messages.stream(
        dropUnsupportedParams(modelName, {
          model: modelName,
          max_tokens: maxTokens,
          temperature: request.temperature,
          system: appendSystemInstruction(
            buildAnthropicSystemParam(request.messages),
            forced.instruction,
          ),
          messages: conversationMessages,
          ...(tools ? { tools } : {}),
          ...(forced.toolChoice ? { tool_choice: forced.toolChoice } : {}),
          ...(outputConfig ? { output_config: outputConfig } : {}),
          ...(thinkingConfig ? { thinking: thinkingConfig } : {}),
        }),
        // A user stop (ADR-041) cancels the HTTP request itself rather than
        // letting the rest of the response arrive and be thrown away.
        request.abortSignal ? { signal: request.abortSignal } : undefined,
      );

      for await (const event of stream) {
        switch (event.type) {
          case 'message_start': {
            inputTokens = event.message.usage.input_tokens;
            outputTokens = event.message.usage.output_tokens;
            webSearchRequests = extractWebSearchRequests(event.message.usage);
            webFetchRequests = extractWebFetchRequests(event.message.usage);
            const ct = extractCacheTokens(event.message.usage);
            cacheWriteTokens = ct.cacheWriteTokens;
            cacheReadTokens = ct.cacheReadTokens;
            break;
          }

          case 'content_block_start': {
            const block = event.content_block;
            if (block.type === 'text') {
              blocks.set(event.index, { kind: 'text' });
            } else if (block.type === 'thinking' && narratesBetweenTools) {
              blocks.set(event.index, { kind: 'thinking' });
            } else if (block.type === 'tool_use') {
              blocks.set(event.index, {
                kind: 'tool_use',
                id: block.id,
                name: block.name,
                jsonBuffer: '',
              });
            }
            break;
          }

          case 'content_block_delta': {
            const delta = event.delta;
            const accum = blocks.get(event.index);
            if (delta.type === 'text_delta') {
              yield { type: 'text_delta', text: delta.text };
            } else if (delta.type === 'thinking_delta' && accum?.kind === 'thinking') {
              // A progress note, not reasoning: the accumulator only exists for
              // this index when the request asked for `between_tools`, which is
              // the setting under which these blocks carry the prose the model
              // wrote for the reader between tool calls. Forwarded as ordinary
              // text so it travels the path it travelled before Sonnet 5.5 moved
              // it — through the output guard, into the streamed reply, and into
              // the assistant turn that is replayed on the next request.
              //
              // `signature_delta` is deliberately ignored: it is a signature
              // over the block, not text, and nothing here replays a thinking
              // block back to the vendor.
              yield { type: 'text_delta', text: delta.thinking };
            } else if (delta.type === 'input_json_delta' && accum?.kind === 'tool_use') {
              accum.jsonBuffer += delta.partial_json;
            }
            break;
          }

          case 'content_block_stop': {
            const accum = blocks.get(event.index);
            if (accum?.kind === 'tool_use') {
              yield {
                type: 'tool_use',
                toolCall: {
                  id: accum.id,
                  name: accum.name,
                  input: safeParseJsonObject(accum.jsonBuffer),
                },
              };
            }
            break;
          }

          case 'message_delta':
            if (event.delta.stop_reason) {
              stopReason = mapAnthropicStopReason(event.delta.stop_reason);
            }
            if (event.usage?.output_tokens != null) {
              outputTokens = event.usage.output_tokens;
            }
            {
              const wsr = extractWebSearchRequests(event.usage);
              if (wsr > 0) webSearchRequests = wsr;
              const wfr = extractWebFetchRequests(event.usage);
              if (wfr > 0) webFetchRequests = wfr;
            }
            break;

          case 'message_stop':
            // No-op
            break;
        }
      }
    } catch (err) {
      log.error({ _internal_provider: 'anthropic', err }, 'LLM call failed');
      yield { type: 'error', message: liftoffifyString((err as Error).message) };
      return;
    }

    yield {
      type: 'message_complete',
      // The model this call was actually served by, so the usage row names it.
      // Streaming had no way to report this and recorded 'default' for every
      // tier-based caller, which prices the row against no model at all.
      model: modelName,
      stopReason,
      refusalCategory: stopReason === 'refusal' ? 'refusal' : undefined,
      usage: {
        inputTokens, outputTokens, webSearchRequests, webFetchRequests, cacheWriteTokens, cacheReadTokens,
        contextTokens: anthropicContextTokens(inputTokens, cacheWriteTokens, cacheReadTokens),
      },
    };
  }
}
