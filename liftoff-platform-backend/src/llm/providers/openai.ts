// OpenAI (GPT) Provider
import OpenAI from 'openai';
import { getOpenAIApiKey, getOpenAIApiKeyForGroup } from '../../infrastructure/secrets';
import type { OpenAIPurposeGroup } from '../../infrastructure/secrets';
import { log } from '../../infrastructure/logging';
import type {
  LLMProvider,
  LLMProviderClient,
  LLMCompletionRequest,
  LLMCompletionResponse,
  LLMModelTier,
  LLMStreamEvent,
  LLMStopReason,
  LLMToolCall,
  LLMToolDefinition,
} from '../types';
import { safeParseJsonObject } from './json-utils';
import { sanitizeWebContent } from './web-content-sanitizer';
import { foldToolHistory } from '../fold-tool-history';

// What a request resolves to when it names neither a model nor a tier. Kept in
// step with the tier ladder below: leaving it on a previous line means an
// untiered request quietly runs a different generation from every tiered one,
// which is the same "two answers to one question" the registry overlay exists
// to remove.
//
// `gpt-5.4` and the GPT-5.6 line keep their registry rows, their rates and their
// vision marking — historical llm_usage_log rows still carry them and must still
// price and redact — they are simply no longer what anything resolves TO.
export const DEFAULT_MODEL = 'gpt-6-astra';
const DEFAULT_MAX_TOKENS = 128_000;

/** Bootstrap tier→model seed, overlaid from the `models` registry by
 *  registry-tier-loader. It must AGREE with the registry rather than merely be
 *  registered: the seed is what resolves before the first load lands and what
 *  keeps resolving if a load fails, so a seed that disagrees gives two answers
 *  for one tier depending on how long the process has been up. Asserted in
 *  migrations/__tests__/395_registry_tier_drift.integration.test.ts.
 *
 *  DEFAULT_MODEL above is the large tier of this same line, so an untiered
 *  request and a large-tier request resolve to the same model.
 *
 *  The GPT-6 line names its tiers rather than numbering them, and the names do
 *  NOT carry their GPT-5.6 meaning across the generation: `gpt-6.1-sol` is the
 *  MEDIUM tier here, where `gpt-5.6-sol` was the large tier. Reading the ladder
 *  off the name is how a $2 model comes to be charged as a $10 one — the tier
 *  is the slot this platform routes to, and the vendor's own price list is what
 *  fixes which slot a model belongs in ($10 / $2 / $0.10 per million input,
 *  astra / sol / luna).
 *
 *  That rule is what kept 6.1 Sol in the medium slot. The vendor describes it as
 *  "near-Astra performance at a lower cost", which reads like a promotion to the
 *  large tier — but it is priced at $2, in the same band its predecessor held and
 *  the same band the Anthropic medium sits in. A tier is a price-and-capability
 *  slot, not a compliment. */
export const TIER_MODELS: Record<LLMModelTier, string> = {
  large:    'gpt-6-astra',
  medium:   'gpt-6.1-sol',
  small:    'gpt-6-luna',
};

// Model resolution now lives on the class as the protected `resolveModel`
// method so subclasses (OpenRouterProvider) resolve against their own `tierModels`.

/** Map an OpenAI finish_reason to our LLMStopReason. Defaults to 'end_turn'.
 *
 *  'content_filter' means OpenAI's moderation stack blocked the completion —
 *  map it to 'refusal' so it is not treated as a successful empty answer.
 *  Note: structured-output / policy refusals can ALSO arrive with
 *  finish_reason 'stop' and a populated `message.refusal` string; that case is
 *  handled at the call sites (they promote the stopReason to 'refusal' when
 *  `.refusal` is truthy), because the finish_reason alone does not reveal it.
 *  Exported for unit testing. */
export function mapOpenAIFinishReason(reason: string | null | undefined): LLMStopReason {
  switch (reason) {
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    case 'stop':
    default:
      return 'end_turn';
  }
}

/** Translate our LLMToolDefinition[] into OpenAI's ChatCompletionTool[]. */
function toOpenAITools(
  tools: LLMToolDefinition[] | undefined,
): OpenAI.ChatCompletionTool[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map(t => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema as unknown as Record<string, unknown>,
    },
  }));
}

/** Translate our toolChoice into OpenAI's tool_choice parameter. */
function toOpenAIToolChoice(
  toolChoice: 'auto' | 'required' | 'none' | { name: string } | undefined,
): 'auto' | 'required' | 'none' | { type: 'function'; function: { name: string } } {
  if (!toolChoice || toolChoice === 'auto') return 'auto';
  if (toolChoice === 'required') return 'required';
  if (toolChoice === 'none') return 'none';
  return { type: 'function', function: { name: toolChoice.name } };
}

/** OpenAI represents conversation tool calls and tool results as separate
 *  messages. This function handles both the new per-message tool shape
 *  (LLMMessage.toolCalls on assistant turns, LLMMessage.toolResults on user
 *  turns — used by the insights chat multi-round tool-use loop) and the
 *  legacy request-level `toolResults` shortcut (used by the Phase 4 tests;
 *  preserved for backwards compatibility).
 *
 *  Output ordering: assistant turn (with tool_calls) → tool messages with
 *  results. The caller is responsible for including the matching assistant
 *  turn in `messages` immediately before the tool results.
 */
function buildOpenAIMessages(
  request: LLMCompletionRequest,
  /** Whether to emit `cache_control` breakpoints on messages that carry
   *  `cacheControl`. Gateway-specific: see emitsCacheControl on the class. */
  emitCacheControl = false,
): OpenAI.ChatCompletionMessageParam[] {
  const out: OpenAI.ChatCompletionMessageParam[] = [];

  for (const m of request.messages) {
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      // Assistant turn that made tool calls — emit as a single assistant
      // message with OpenAI's `tool_calls` field.
      out.push({
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map(tc => ({
          id: tc.id,
          type: 'function' as const,
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.input),
          },
        })),
      });
      continue;
    }

    if (m.role === 'user' && m.toolResults && m.toolResults.length > 0) {
      // User turn carrying tool results — emit each as a separate 'tool'
      // role message (OpenAI's required shape). Any accompanying text
      // content is emitted as a regular user message after the tool
      // messages, so the LLM sees the results first.
      for (const tr of m.toolResults) {
        out.push({
          role: 'tool' as const,
          tool_call_id: tr.toolCallId,
          content: sanitizeWebContent(tr.content),
        });
      }
      // A tool whose answer is a picture cannot carry it here: this vendor's
      // tool-role message is `string | ChatCompletionContentPartText` — text,
      // and only text. Anthropic and Google take the frame inside the tool
      // result; here it goes on a user turn immediately after, which is the
      // nearest position in the conversation that accepts an image and leaves
      // the model seeing the same thing at the same point.
      const toolImages = m.toolResults.flatMap(tr => tr.images ?? []);
      if (toolImages.length > 0) {
        out.push({
          role: 'user',
          content: [
            ...toolImages.map(img => ({
              type: 'image_url' as const,
              image_url: { url: `data:${img.mimeType};base64,${img.dataBase64}` },
            })),
            { type: 'text' as const, text: m.content || 'The image above is what the tool returned.' },
          ],
        });
        continue;
      }
      if (m.content) {
        out.push({ role: 'user', content: m.content });
      }
      continue;
    }

    if (m.role === 'user' && m.images && m.images.length > 0) {
      // OpenAI takes an image as a data: URL inside an image_url part. Images
      // lead, text follows — same ordering rule as every other vendor, same
      // reason: a question that arrives before the picture is answered without
      // it.
      out.push({
        role: 'user',
        content: [
          // Images only: the Chat Completions wire has an image_url part and no
          // video one. The gate filters to this already; the guard keeps a
          // future caller from discovering it at the vendor instead.
          ...m.images
            .filter((img) => img.mimeType.startsWith('image/'))
            .map((img) => ({
              type: 'image_url' as const,
              image_url: { url: `data:${img.mimeType};base64,${img.dataBase64}` },
            })),
          ...(m.content ? [{ type: 'text' as const, text: m.content }] : []),
        ],
      });
      continue;
    }

    // Plain message — no tool data.
    //
    // A CACHE BREAKPOINT NEEDS THE BLOCK SHAPE. `cache_control` is a property of
    // a content BLOCK, not of a message, so a string `content` has nowhere to
    // carry it and the caller's `cacheControl` was silently dropped here. The
    // vendors still cached — automatically, on a prefix they chose — so nothing
    // looked broken; it simply cached less. Measured against Qwen through the
    // gateway: an explicit breakpoint cached 7,716 tokens against 7,168-7,424
    // automatic, and made the repeat call 2.1-2.2x cheaper on plus and max. It
    // costs 1.25x once to prime, so it pays back after about two turns.
    //
    // Only where the target accepts it. This same builder serves plain OpenAI,
    // whose API does not take the field, and sending it there is a request
    // shape the vendor never agreed to.
    if (emitCacheControl && m.cacheControl && m.content) {
      out.push({
        role: m.role as 'system' | 'user' | 'assistant',
        content: [{
          type: 'text' as const,
          text: m.content,
          cache_control: { type: 'ephemeral' as const },
        }],
      } as unknown as OpenAI.ChatCompletionMessageParam);
      continue;
    }
    out.push({
      role: m.role as 'system' | 'user' | 'assistant',
      content: m.content,
    });
  }

  // Legacy: request-level `toolResults` shortcut (Phase 4). Kept for
  // backwards compatibility with the existing Phase 4 tests. The insights
  // chat uses the per-message shape exclusively.
  if (request.toolResults?.length) {
    for (const result of request.toolResults) {
      out.push({
        role: 'tool',
        tool_call_id: result.toolCallId,
        content: sanitizeWebContent(result.content),
      });
    }
  }

  return out;
}

/** What the vendor charged for this call, when the gateway reports it.
 *
 *  OpenRouter returns `usage.cost` (and `cost_details`) on every response once
 *  the request asks for accounting; the direct OpenAI API returns nothing here
 *  and the field stays undefined, which is the signal to price from the rate
 *  table instead.
 *
 *  Guarded on `> 0` rather than `!= null`: a zero would read as a free call and
 *  un-bill it, and the one thing we must not do is turn "the vendor did not say"
 *  into "it cost nothing". A genuinely free call has no charge to record. */
function vendorCostOf(usage: unknown): number | undefined {
  const c = (usage as { cost?: unknown } | undefined)?.cost;
  return typeof c === 'number' && Number.isFinite(c) && c > 0 ? c : undefined;
}


export class OpenAIProvider implements LLMProviderClient {
  readonly provider: LLMProvider;
  protected client: OpenAI;
  protected tierModels: Record<LLMModelTier, string>;
  /** Extra top-level body fields merged into every chat.completions.create()
   *  call. Used by OpenRouterProvider to send OpenRouter's `provider` pin object. */
  protected extraBody: Record<string, unknown> = {};

  protected constructor(
    client: OpenAI,
    provider: LLMProvider = 'openai',
    tierModels: Record<LLMModelTier, string> = TIER_MODELS,
  ) {
    this.client = client;
    this.provider = provider;
    this.tierModels = tierModels;
  }

  /** Resolve the model ID for this provider. Explicit `model` wins over `tier`;
   *  if neither is set, falls back to DEFAULT_MODEL. Reads `this.tierModels` so
   *  subclasses resolve against their own tier→model map. */
  /** The model this request would run against, without running it. Delegates
   *  to `resolveModel` so a subclass that overlays its own tier map — the
   *  OpenRouter provider does, from the registry at runtime — answers with the
   *  model IT would use rather than the base one. See the note on
   *  LLMProviderClient.resolveModelId. */
  resolveModelId(request: LLMCompletionRequest): string {
    return this.resolveModel(request);
  }

  /** Whether the vendor serving `model` takes `tool_choice: "none"` on the
   *  wire. OpenAI does; a gateway subclass answers per upstream vendor. When
   *  it does not, the intent is honoured by sending no tools and folding the
   *  tool history into text (fold-tool-history.ts), which every chat API
   *  accepts. */
  protected toolChoiceNoneSupported(_model: string): boolean {
    return true;
  }

  /** The request as this vendor can take it: unchanged, or — for a
   *  `toolChoice: 'none'` the vendor cannot be told — with its tool history
   *  folded into text and no tools to send. */
  protected forVendor(request: LLMCompletionRequest, model: string): { request: LLMCompletionRequest; tools: OpenAI.Chat.ChatCompletionTool[] | undefined } {
    if (request.toolChoice === 'none' && !this.toolChoiceNoneSupported(model)) {
      return { request: foldToolHistory(request), tools: undefined };
    }
    return { request, tools: toOpenAITools(request.tools) };
  }

  protected resolveModel(request: LLMCompletionRequest): string {
    if (request.model) return request.model;
    if (request.tier) return this.tierModels[request.tier];
    return DEFAULT_MODEL;
  }

  /** Overlay registry-sourced tier→model ids onto the static TIER_MODELS seed.
   *  Called by registry-tier-loader; a tier absent from the registry keeps its
   *  seed value. Per-INSTANCE rather than module-level because `tierModels` is
   *  an instance field the OpenRouter subclass seeds differently — every
   *  instance in the purpose-keyed pool is handed to the loader as its own sink. */
  applyRegistryTierModels(overrides: Partial<Record<LLMModelTier, string>>): void {
    this.tierModels = { ...TIER_MODELS, ...overrides };
  }

  static async create(): Promise<OpenAIProvider | null> {
    const apiKey = await getOpenAIApiKey();
    if (!apiKey) {
      log.info('OpenAI API key not configured, provider unavailable');
      return null;
    }

    const client = new OpenAI({ apiKey });
    log.info('OpenAI provider initialized');
    return new OpenAIProvider(client);
  }

  /**
   * An instance that talks to the BYOK gateway instead of OpenAI directly.
   *
   * `baseUrl` carries the `/v1` suffix the OpenAI SDK expects to append its own
   * paths to, and `token` is the short-lived per-run gateway credential rather
   * than a customer key. Per-call for the same reason as the Anthropic twin:
   * the boot-time pool is keyed by purpose group, not by tenant.
   */
  static createForGateway(baseUrl: string, token: string): OpenAIProvider {
    return new OpenAIProvider(new OpenAI({ apiKey: token, baseURL: baseUrl }));
  }

  /** Build a pool of four purpose-scoped OpenAI instances, one per key group.
   *  Falls back to the legacy single key for any group not yet configured.
   *  Returns null if no OpenAI key is available at all. */
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
    log.info({ groups: [...pool.keys()] }, 'OpenAI provider pool initialized');
    return pool;
  }

  /** Whether this client's target accepts `cache_control` breakpoints on a
   *  content block.
   *
   *  OFF here, and that is the safe direction: this class talks to OpenAI's own
   *  API, which does not document the field, and a request shape a vendor never
   *  agreed to is a 400 rather than a missed discount. OpenRouter overrides it —
   *  it documents the field and every gateway vendor measured honours it.
   *
   *  Turning it off costs only the DIFFERENCE between an explicit breakpoint and
   *  the vendor's automatic prefix caching, not caching altogether. */
  protected emitsCacheControl(): boolean {
    return false;
  }

  async complete(request: LLMCompletionRequest): Promise<LLMCompletionResponse> {
    const model = this.resolveModel(request);
    const maxTokens = request.maxTokens || DEFAULT_MAX_TOKENS;

    const shaped = this.forVendor(request, model);
    const messages = buildOpenAIMessages(shaped.request, this.emitsCacheControl());

    // ── Existing responseSchema shortcut path (forced single tool call) ──
    if (request.responseSchema) {
      const tool: OpenAI.ChatCompletionTool = {
        type: 'function',
        function: {
          name: request.responseSchema.name,
          description: request.responseSchema.description || `Generate structured output for ${request.responseSchema.name}`,
          parameters: request.responseSchema.schema as unknown as Record<string, unknown>,
        },
      };

      const response = await this.client.chat.completions.create({
        ...this.extraBody,
        model,
        max_completion_tokens: maxTokens,
        temperature: request.temperature,
        messages,
        tools: [tool],
        tool_choice: { type: 'function', function: { name: tool.function.name } },
      });

      // Extract the function call arguments
      const toolCall = response.choices[0]?.message?.tool_calls?.[0];
      if (!toolCall || toolCall.type !== 'function') {
        throw new Error('Expected function call response but got none');
      }

      return {
        content: toolCall.function.arguments,
        model: response.model,
        provider: this.provider,
        usage: response.usage ? {
          inputTokens: response.usage.prompt_tokens,
          outputTokens: response.usage.completion_tokens,
          webSearchRequests: 0,
          cacheReadTokens: (response.usage as any).prompt_tokens_details?.cached_tokens ?? 0,
          // `prompt_tokens` is the whole prompt, cached part included.
          contextTokens: response.usage.prompt_tokens,
          vendorCostUsd: vendorCostOf(response.usage),
        } : undefined,
      };
    }

    // ── General-tools path (Phase 4) ──────────────────────────────────────
    const tools = shaped.tools;
    const toolChoice = toOpenAIToolChoice(request.toolChoice);

    // OpenAI's built-in web search uses a separate request parameter
    // (web_search_options), not a tool in the tools array. Detect when
    // serverTools includes web_search and enable it.
    const wantsWebCapabilities = request.serverTools?.some(t => t.name === 'web_search' || t.name === 'web_fetch');

    const response = await this.client.chat.completions.create({
      ...this.extraBody,
      model,
      max_completion_tokens: maxTokens,
      temperature: request.temperature,
      messages,
      ...(tools ? { tools, tool_choice: toolChoice } : {}),
      ...(wantsWebCapabilities ? { web_search_options: { search_context_size: 'medium' as const } } : {}),
    } as any);

    const choice = response.choices[0];
    const message = choice?.message;
    const content = message?.content ?? '';
    // OpenAI signals a structured-output / policy refusal via a populated
    // `message.refusal` string while finish_reason may still be 'stop'. Promote
    // to 'refusal' whenever that field is truthy, regardless of finish_reason.
    const refusalText = (message as { refusal?: string | null } | undefined)?.refusal;
    const stopReason: LLMStopReason = refusalText
      ? 'refusal'
      : mapOpenAIFinishReason(choice?.finish_reason);
    const refusalCategory =
      stopReason === 'refusal'
        ? (refusalText ? 'refusal' : 'content_filter')
        : undefined;

    let toolCalls: LLMToolCall[] | undefined;
    if (message?.tool_calls?.length) {
      toolCalls = message.tool_calls
        .filter((tc): tc is OpenAI.ChatCompletionMessageToolCall =>
          tc.type === 'function' && !!tc.function?.name,
        )
        .map(tc => ({
          id: tc.id,
          name: tc.function.name,
          // OpenAI returns arguments as a JSON string. Parse defensively —
          // a malformed payload becomes an empty object so the loop can recover.
          input: safeParseJsonObject(tc.function.arguments),
        }));
    }

    return {
      content,
      model: response.model,
      provider: this.provider,
      stopReason,
      refusalCategory,
      toolCalls,
      usage: response.usage ? {
        inputTokens: response.usage.prompt_tokens,
        outputTokens: response.usage.completion_tokens,
        webSearchRequests: wantsWebCapabilities ? 1 : 0,
        webFetchRequests: undefined,
        cacheReadTokens: (response.usage as any).prompt_tokens_details?.cached_tokens ?? 0,
        // `prompt_tokens` is the whole prompt, cached part included.
        contextTokens: response.usage.prompt_tokens,
        vendorCostUsd: vendorCostOf(response.usage),
      } : undefined,
    };
  }

  /** Stream a completion as a sequence of normalized events.
   *
   *  Bridges OpenAI's `Stream<ChatCompletionChunk>` async iterable into our
   *  `LLMStreamEvent` discriminated union. The tricky part is tool-call
   *  fragmentation: the first chunk for a given tool call carries `id` and
   *  `function.name`; subsequent chunks for the same `index` only carry
   *  `function.arguments` deltas. We accumulate by index and emit one
   *  `tool_use` event per call after the stream completes. */
  async *completeStream(request: LLMCompletionRequest): AsyncIterable<LLMStreamEvent> {
    const model = this.resolveModel(request);
    const maxTokens = request.maxTokens || DEFAULT_MAX_TOKENS;
    const shaped = this.forVendor(request, model);
    // Streaming gets the breakpoint too. A chat turn is the case that benefits
    // most — the system prompt is identical on every turn of the thread — so
    // omitting it here would leave the saving on exactly the hottest path.
    const messages = buildOpenAIMessages(shaped.request, this.emitsCacheControl());
    const tools = shaped.tools;
    const toolChoice = toOpenAIToolChoice(request.toolChoice);

    const wantsWebCapabilities = request.serverTools?.some(t => t.name === 'web_search' || t.name === 'web_fetch');

    let stream: AsyncIterable<OpenAI.ChatCompletionChunk>;
    try {
      stream = await (this.client.chat.completions.create as (...args: unknown[]) => Promise<AsyncIterable<OpenAI.ChatCompletionChunk>>)({
        ...this.extraBody,
        model,
        max_completion_tokens: maxTokens,
        temperature: request.temperature,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        ...(tools ? { tools, tool_choice: toolChoice } : {}),
        ...(wantsWebCapabilities ? { web_search_options: { search_context_size: 'medium' } } : {}),
      },
      // Request options, NOT body params — the signal must not be serialized
      // into the request. A user stop (ADR-041) cancels the HTTP request itself
      // rather than letting the rest of the response arrive and be discarded.
      request.abortSignal ? { signal: request.abortSignal } : undefined);
    } catch (err) {
      yield { type: 'error', message: (err as Error).message };
      return;
    }

    // Per-tool-call accumulator. Keyed by OpenAI's `index` because the same
    // logical call may span many chunks.
    const toolCallAccum = new Map<number, { id: string; name: string; argsBuffer: string }>();
    let stopReason: LLMStopReason = 'end_turn';
    // OpenAI streams a structured-output / policy refusal as `delta.refusal`
    // string fragments (finish_reason may still be 'stop'). Accumulate them so
    // we can promote the terminal stopReason to 'refusal'.
    let refusalBuffer = '';
    let vendorCostUsd: number | undefined;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;

    try {
      for await (const chunk of stream) {
        const choice = chunk.choices[0];

        // Text deltas — emit immediately so the UI can stream.
        const textDelta = choice?.delta?.content;
        if (textDelta) {
          yield { type: 'text_delta', text: textDelta };
        }

        // Refusal fragments — accumulate; do not surface as assistant text.
        const refusalDelta = (choice?.delta as { refusal?: string | null } | undefined)?.refusal;
        if (refusalDelta) {
          refusalBuffer += refusalDelta;
        }

        // Tool-call fragments — accumulate, don't emit until the stream completes.
        const tcDeltas = choice?.delta?.tool_calls;
        if (tcDeltas) {
          for (const tcDelta of tcDeltas) {
            const idx = tcDelta.index;
            let entry = toolCallAccum.get(idx);
            if (!entry) {
              entry = { id: '', name: '', argsBuffer: '' };
              toolCallAccum.set(idx, entry);
            }
            if (tcDelta.id) entry.id = tcDelta.id;
            if (tcDelta.function?.name) entry.name = tcDelta.function.name;
            if (tcDelta.function?.arguments) entry.argsBuffer += tcDelta.function.arguments;
          }
        }

        if (choice?.finish_reason) {
          stopReason = mapOpenAIFinishReason(choice.finish_reason);
        }

        // The terminal usage chunk arrives when stream_options.include_usage is set.
        if (chunk.usage) {
          inputTokens = chunk.usage.prompt_tokens;
          outputTokens = chunk.usage.completion_tokens;
          cacheReadTokens = (chunk.usage as any).prompt_tokens_details?.cached_tokens ?? 0;
          // The gateway puts the call's real charge on this same terminal chunk.
          vendorCostUsd = vendorCostOf(chunk.usage) ?? vendorCostUsd;
        }
      }
    } catch (err) {
      yield { type: 'error', message: (err as Error).message };
      return;
    }

    // Flush all accumulated tool calls in deterministic index order.
    const sortedEntries = [...toolCallAccum.entries()].sort(([a], [b]) => a - b);
    for (const [idx, entry] of sortedEntries) {
      if (!entry.name) continue; // Defensive: skip malformed accumulators
      yield {
        type: 'tool_use',
        toolCall: {
          id: entry.id || `${entry.name}-${idx}`,
          name: entry.name,
          input: safeParseJsonObject(entry.argsBuffer),
        },
      };
    }

    // A populated refusal buffer means a policy refusal even when the terminal
    // finish_reason was 'stop'. Promote the stopReason so the client fails loud.
    if (refusalBuffer) {
      stopReason = 'refusal';
    }
    const refusalCategory =
      stopReason === 'refusal'
        ? (refusalBuffer ? 'refusal' : 'content_filter')
        : undefined;

    yield {
      type: 'message_complete',
      // The model this call was actually served by, so the usage row names it.
      // Streaming had no way to report this and recorded 'default' for every
      // tier-based caller, which prices the row against no model at all.
      model: model,
      stopReason,
      refusalCategory,
      usage: {
        inputTokens, outputTokens, webSearchRequests: wantsWebCapabilities ? 1 : 0, webFetchRequests: undefined, cacheReadTokens,
        vendorCostUsd,
        // `prompt_tokens` is the whole prompt, cached part included.
        contextTokens: inputTokens,
      },
    };
  }
}

/** Test seam. See the note on the Google equivalent. */
export const __internalBuildOpenAIMessages = buildOpenAIMessages;
