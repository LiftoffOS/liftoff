// Unified LLM Client
// Manages multiple providers with graceful fallback

import { log } from '../infrastructure/logging';
import { AnthropicProvider, GoogleProvider, OpenAIProvider, OpenRouterProvider } from './providers';
import {
  areaForPurpose,
  platformVendorForArea,
  resolvePlatformVendorTarget,
} from '../model-registry/platform-vendor-policy';
import {
  contextWindowFromRegistry,
  DEFAULT_CONTEXT_WINDOW,
  startRegistryTierRefresh,
  type TierModelSink,
} from './registry-tier-loader';
import type { AnthropicPurposeGroup, OpenAIPurposeGroup } from '../infrastructure/secrets';
import type {
  LLMProvider,
  LLMProviderClient,
  LLMCompletionRequest,
  LLMCompletionResponse,
  LLMClientConfig,
  LLMStreamEvent,
  LLMUsageCallback,
  LLMUsageEvent,
} from './types';
import { LLMRefusalError } from './types';
import { resolveByokRoutedCall } from './byok-routing';
import {
  classifyStreamFailure,
  isRetryableStreamFailure,
  streamFailureMessage,
} from './stream-failure';

/**
 * Attempts at a stream that failed before saying anything.
 *
 * Matches the provider SDKs' own HTTP-leg retry count, so one upstream blip is
 * treated the same whichever side of the 200 it lands on. See stream-failure.ts
 * for why that symmetry did not exist and what it cost.
 */
const STREAM_MAX_ATTEMPTS = 3;
/** Exponential with jitter. The person is waiting, so the ceiling is low. */
const STREAM_RETRY_BASE_MS = 400;
const STREAM_RETRY_MAX_MS = 4_000;

/** `area:provider` pairs already reported as unroutable. A standing condition
 *  said once rather than on every call. */
const warnedUnroutableLevers = new Set<string>();

function streamRetryDelayMs(attempt: number): number {
  const ceiling = Math.min(STREAM_RETRY_BASE_MS * 2 ** attempt, STREAM_RETRY_MAX_MS);
  // Full jitter. Every surface shares one key, so a synchronised retry would
  // aim the whole estate at the same second of an already-overloaded provider.
  return Math.floor(Math.random() * ceiling);
}

/** Maps an LLM call purpose string to one of four Anthropic API key groups.
 *  The group determines which dedicated API key is used, enabling independent
 *  billing-dashboard visibility per function category in Anthropic's console.
 *
 *  Exported for the BYOK gateway, which needs the SAME group a direct call
 *  would have used when it falls back to a managed key: a fallback that landed
 *  on a different group would move that spend to another line in the vendor's
 *  console, and the fallback is already the surprising case. */
export function purposeToGroup(purpose: string | undefined): AnthropicPurposeGroup {
  if (!purpose) return 'agent-execution';
  if (['reflection', 'memory_consolidation', 'suggestion_applier'].includes(purpose))
    return 'reflective-services';
  if (
    purpose.startsWith('caio') ||
    purpose.startsWith('hrbp') ||
    purpose.startsWith('insights') ||
    purpose.startsWith('liftoff') ||
    ['observations', 'intro'].includes(purpose)
  )
    return 'platform-analytics';
  if (
    [
      'title_generation',
      'context_absorption',
      'rolling_summary',
      'chat-feedback-extraction',
      'embedding_retrieval',
      'embedding_consolidation',
      'embedding_save',
      'retrieval_hyde',
    ].includes(purpose)
  )
    return 'background-services';
  // Distillation and its patch rung, stated rather than left to the default
  // below: the patch is one call inside a distillation and has to land on the
  // same key as the distill call it stands in for, so a later change to the
  // default cannot move one without the other.
  if (purpose === 'distill' || purpose === 'distill_patch') return 'agent-execution';
  // agent_execution, autonomous runs, and any unknown purpose default here.
  return 'agent-execution';
}

class LLMClient {
  private providers: Map<LLMProvider, LLMProviderClient> = new Map();
  private anthropicPool: Map<AnthropicPurposeGroup, AnthropicProvider> | null = null;
  private openaiPool: Map<OpenAIPurposeGroup, OpenAIProvider> | null = null;
  private preferredProvider?: LLMProvider;
  private initialized = false;
  private usageCallbacks: LLMUsageCallback[] = [];

  async init(config?: LLMClientConfig): Promise<void> {
    if (this.initialized) {
      return;
    }

    this.preferredProvider = config?.preferredProvider;

    // Initialize all available providers in parallel
    // Priority: anthropic → openai → google
    const [anthropicPool, google, openaiPool, openrouter] = await Promise.all([
      AnthropicProvider.createPool(),
      GoogleProvider.create(),
      OpenAIProvider.createPool(),
      OpenRouterProvider.createOpenRouter(),
    ]);

    if (anthropicPool) {
      this.anthropicPool = anthropicPool;
      // Register the agent-execution instance as the default 'anthropic' provider
      // so existing callers that don't pass a purpose still work.
      const defaultInstance = anthropicPool.get('agent-execution');
      if (defaultInstance) this.providers.set('anthropic', defaultInstance);
    }
    if (google) this.providers.set('google', google);
    if (openaiPool) {
      this.openaiPool = openaiPool;
      // Register the agent-execution instance as the default 'openai' provider.
      const defaultOpenai = openaiPool.get('agent-execution');
      if (defaultOpenai) this.providers.set('openai', defaultOpenai);
    }
    // Z.ai / GLM (single instance like Google; no purpose-keyed pool yet).
    if (openrouter) this.providers.set('openrouter', openrouter);

    if (this.providers.size === 0) {
      throw new Error('No LLM providers available. At least one provider must be configured.');
    }

    // Tier resolution comes from the `models` registry for every provider, the
    // way it already did for OpenRouter — which starts its own refresh inside
    // createOpenRouter(). Each provider's static TIER_MODELS is the bootstrap
    // fallback until the first load lands.
    //
    // Every Anthropic instance is handed over as a sink — the pool needs that
    // because its map is per-instance. This used to join a second provider,
    // Claude over Google Vertex, onto the same refresh: the rows were the same
    // registry rows, so a second timer would have been a second identical query
    // every 60s. That provider is retired and the pool is now the whole list.
    const anthropicSinks: TierModelSink[] = [];
    if (anthropicPool) anthropicSinks.push(...anthropicPool.values());
    if (anthropicSinks.length > 0) {
      startRegistryTierRefresh('anthropic', anthropicSinks, ['anthropic']);
    }
    if (openaiPool && openaiPool.size > 0) {
      startRegistryTierRefresh('openai', [...openaiPool.values()], ['openai']);
    }
    if (google) startRegistryTierRefresh('google', [google], ['google']);

    log.info(
      { providers: Array.from(this.providers.keys()) },
      'LLM client initialized with providers'
    );
    this.initialized = true;
  }

  /** Return the Anthropic provider instance appropriate for the given purpose.
   *  Falls back to the default 'anthropic' provider if the pool isn't set up. */
  private getAnthropicForPurpose(purpose: string | undefined): LLMProviderClient | undefined {
    if (this.anthropicPool) {
      return this.anthropicPool.get(purposeToGroup(purpose));
    }
    return this.providers.get('anthropic');
  }

  /** Return the OpenAI provider instance appropriate for the given purpose.
   *  Falls back to the default 'openai' provider if the pool isn't set up. */
  private getOpenAIForPurpose(purpose: string | undefined): LLMProviderClient | undefined {
    if (this.openaiPool) {
      return this.openaiPool.get(purposeToGroup(purpose));
    }
    return this.providers.get('openai');
  }

  /**
   * Which concrete model a request WOULD run against, resolved exactly the way
   * `complete` and `completeStream` resolve it.
   *
   * Exists for the vision gate. Whether a turn may carry an image block is
   * decided while the request is still being built, and it depends on the
   * model — but the model is chosen HERE, from the preferred provider, the
   * purpose-keyed pool and the provider's own tier map, none of which a chat
   * service can see. Without this a caller would have to duplicate that
   * resolution and would be wrong the first time any of it changed.
   *
   * Returns undefined when the model cannot be determined. A caller treats that
   * as an unknown model, which means no vision and an honest note in the
   * prompt — never an image sent hopefully.
   */
  async resolvePlannedModel(
    request: LLMCompletionRequest,
    provider?: LLMProvider,
    usageContext?: Record<string, string>,
  ): Promise<string | undefined> {
    if (!this.initialized) {
      await this.init();
    }
    const targetProvider = provider || this.preferredProvider || this.getFirstAvailableProvider();
    const purpose = usageContext?.purpose;
    let client: LLMProviderClient | undefined;
    if (targetProvider === 'anthropic') {
      client = this.getAnthropicForPurpose(purpose);
    } else if (targetProvider === 'openai') {
      client = this.getOpenAIForPurpose(purpose);
    } else {
      client = this.providers.get(targetProvider);
    }
    if (!client) client = this.providers.get(this.getFirstAvailableProvider());
    return client?.resolveModelId?.(request);
  }

  /**
   * Which provider a request would resolve to, without running it.
   *
   * The companion to resolvePlannedModel, and needed for the same reason: what
   * a turn may put in front of a model is the intersection of what the MODEL
   * understands and what the PROVIDER's request builder can express. Gemini's
   * inlineData carries a video; the Anthropic and OpenAI image blocks do not.
   * A caller that knows only the model id would have to guess the second half.
   *
   * Same resolution order the call itself uses, so the gate and the builder
   * cannot disagree about which provider is about to run.
   */
  resolvePlannedProvider(provider?: LLMProvider): LLMProvider {
    return provider || this.preferredProvider || this.getFirstAvailableProvider();
  }

  /**
   * The context window of a model on a provider, from the `models` registry
   * (`context_window`, migration 343) as the tier loader last cached it.
   *
   * Read by the chat loops after each call: the guard on a turn is how full
   * the model's window is, and a window is a registry fact the loop cannot
   * see. Synchronous, off the cache the 60s refresh keeps, so it costs no
   * per-call read. A model the registry does not size — or has not loaded
   * yet — is assumed to be a 128k one, which is below every current frontier
   * window, so an unknown model closes early rather than overflowing.
   */
  contextWindowFor(provider: LLMProvider | string, model: string | undefined): number {
    if (!model) return DEFAULT_CONTEXT_WINDOW;
    return contextWindowFromRegistry(provider, model) ?? DEFAULT_CONTEXT_WINDOW;
  }

  /**
   * The RECORDED window for a model, or undefined when the registry has none.
   *
   * The companion to `contextWindowFor`, and the difference is the point:
   * that one substitutes the conservative fallback and hands back a number
   * with no provenance, which is fine for a log line and wrong for a decision.
   * A caller that must tell "this model holds 1M" from "we are guessing" — the
   * shared bound policy does, and only the first may drive a destructive
   * decision — reads this.
   */
  recordedContextWindowFor(provider: LLMProvider | string, model: string | undefined): number | undefined {
    if (!model) return undefined;
    return contextWindowFromRegistry(provider, model);
  }

  // Register a callback that fires on every LLM call (success or failure).
  // This is the single integration point for usage tracking.
  onUsage(callback: LLMUsageCallback): void {
    this.usageCallbacks.push(callback);
  }

  async complete(
    request: LLMCompletionRequest,
    provider?: LLMProvider,
    /** Caller-supplied context for attribution (tenantId, purpose, etc.) */
    usageContext?: Record<string, string>
  ): Promise<LLMCompletionResponse> {
    if (!this.initialized) {
      await this.init();
    }

    const purpose = usageContext?.purpose;

    // THE PLATFORM VENDOR LEVER. An explicit `provider` argument still wins —
    // a caller that named one meant it. Below that, the area this purpose
    // belongs to decides, and only then the old fallthrough.
    //
    // This is the ONE place it can go. 36 of this method's 37 callers pass no
    // provider, so resolving here reaches all of them; resolving at the call
    // sites would be 36 edits and a 37th that gets forgotten.
    //
    // A gateway vendor also fixes the MODEL, because the gateway client's own
    // tier map is GLM's — asking it for tier 'small' would answer with GLM's
    // small whatever the lever says. An explicit `request.model` is left alone:
    // the caller pinned a model, and a lever may choose a vendor but not
    // overrule a pin.
    //
    // THE LEVER ONLY APPLIES IF THAT PROVIDER HAS A CLIENT HERE, and this check
    // is load-bearing rather than defensive. Without it the pair comes apart on
    // the fallback below: the lever would set `model` to a Qwen id, the missing
    // gateway client would fall through to Anthropic, and Anthropic would be
    // asked for a model that is not its — a vendor error for what is really an
    // unset key. A lever is a preference, not a pin, so an environment that
    // cannot serve it keeps the platform default and says so once.
    let leveredModel: string | undefined;
    let leveredProvider: LLMProvider | undefined;
    if (!provider) {
      const target = resolvePlatformVendorTarget(
        platformVendorForArea(areaForPurpose(purpose)),
        request.tier,
      );
      if (target && this.isProviderAvailable(target.provider)) {
        leveredProvider = target.provider;
        if (target.model && !request.model) leveredModel = target.model;
      } else if (target) {
        // Said ONCE per area and provider. It is a standing condition — an
        // unset key — not an event, and this runs on every platform call.
        const area = areaForPurpose(purpose);
        const key = `${area}:${target.provider}`;
        if (!warnedUnroutableLevers.has(key)) {
          warnedUnroutableLevers.add(key);
          log.warn(
            { area, wanted: target.provider, available: this.getAvailableProviders().join(', ') },
            'platform vendor lever names a provider with no client here; keeping the default',
          );
        }
      }
    }
    if (leveredModel) request = { ...request, model: leveredModel };

    // Determine which provider to use
    const targetProvider = provider || leveredProvider || this.preferredProvider || this.getFirstAvailableProvider();
    const model = request.model || 'default';

    let client: LLMProviderClient | undefined;
    let resolvedProvider = targetProvider;

    // Route through purpose-keyed pools for Anthropic and OpenAI.
    if (targetProvider === 'anthropic') {
      client = this.getAnthropicForPurpose(purpose);
    } else if (targetProvider === 'openai') {
      client = this.getOpenAIForPurpose(purpose);
    } else {
      client = this.providers.get(targetProvider);
    }

    if (!client) {
      // Fallback to any available provider
      resolvedProvider = this.getFirstAvailableProvider();
      client = this.providers.get(resolvedProvider);
      if (!client) {
        throw new Error('No LLM providers available');
      }
      log.warn(
        { requested: targetProvider, using: resolvedProvider },
        'Requested provider unavailable, using fallback'
      );
    }

    // BYO provider keys. When the customer's own key funds this call, it is
    // served by a one-off client pointed at the gateway rather than by the
    // purpose-keyed pool above — the pool is built once at boot and keyed by
    // group, and a per-tenant credential cannot ride it. Null for every
    // ordinary call, which is the overwhelming majority of them.
    const byokRouting = await resolveByokRoutedCall({
      targetProvider: resolvedProvider,
      resolvedModelId: client.resolveModelId?.(request),
      usageContext,
    });
    if (byokRouting) client = byokRouting.client;
    // The usage row has to carry the run id the gateway keyed its request rows
    // by, or the ingester cannot ask which key served it and the call bills as
    // ordinary consumption. Merged into a copy rather than mutated in place:
    // the context object belongs to the caller.
    const attributionContext = byokRouting
      ? { ...usageContext, invocationId: byokRouting.invocationId }
      : usageContext;

    try {
      const response = await client.complete(request);

      // A missing model ID means the provider didn't return one — the
      // response can't be priced correctly and will be stored as a blank
      // model string. This is a code defect, not a recoverable runtime error.
      if (!response.model) {
        throw new Error(`LLM provider '${resolvedProvider}' returned a response with no model ID`);
      }

      // Awaited so the usage row is committed to llm_usage_log before
      // complete() returns — downstream code (notably
      // attributeSessionToAgent) relies on the row being present when it
      // runs its UPDATE. Emitted for a refusal too: the provider still billed
      // the tokens, and the API call itself succeeded (success:true) — it just
      // produced a refusal rather than usable content.
      await this.emitUsage({
        timestamp: new Date(),
        provider: response.provider,
        model: response.model,
        inputTokens: response.usage?.inputTokens ?? 0,
        outputTokens: response.usage?.outputTokens ?? 0,
        webSearchRequests: response.usage?.webSearchRequests ?? 0,
        cacheWriteTokens: response.usage?.cacheWriteTokens,
        cacheReadTokens: response.usage?.cacheReadTokens,
        // The gateway's own figure for this call, when it gave one. Undefined
        // for the direct-API providers, which is the signal to price from the
        // rate table rather than a claim that the call was free.
        vendorCostUsd: response.usage?.vendorCostUsd,
        success: true,
        context: attributionContext,
      });

      // Fail loud on a safety refusal. A 'refusal' completion has no usable
      // content (empty, blocked before any output) and MUST NOT be returned as
      // a successful answer — every caller of the unified client is protected
      // by this single guard. Usage was already emitted above, so re-throwing
      // does not lose token accounting.
      if (response.stopReason === 'refusal') {
        throw new LLMRefusalError({
          provider: response.provider,
          model: response.model,
          category: response.refusalCategory,
        });
      }

      return response;
    } catch (error) {
      // A refusal already emitted its usage row above — don't double-count it
      // as a failed call; just propagate so the caller fails loud.
      if (error instanceof LLMRefusalError) throw error;
      // The call failed but we may have consumed tokens on the provider side.
      // Emit what we know so the gap is visible and auditable.
      await this.emitUsage({
        timestamp: new Date(),
        provider: resolvedProvider,
        model,
        inputTokens: 0,
        outputTokens: 0,
        success: false,
        error: (error as Error).message,
        context: attributionContext,
      });

      throw error;
    }
  }

  /** Stream a completion as a sequence of normalized events.
   *
   *  Thin dispatcher: picks the provider (with the same fallback logic as
   *  `complete()`) and forwards. The tool-use loop logic lives in the chat
   *  service (Phase 6) — `client.ts` stays a single-turn primitive.
   *
   *  Usage tracking fires once per stream, on either `message_complete` or
   *  `error`, so `llm_usage_log` keeps tracking through the streaming code
   *  path. The `finally` block ensures usage is emitted even if the consumer
   *  abandons the iterator early. */
  async *completeStream(
    request: LLMCompletionRequest,
    provider?: LLMProvider,
    /** Caller-supplied context for attribution (tenantId, purpose, etc.) */
    usageContext?: Record<string, string>,
  ): AsyncIterable<LLMStreamEvent> {
    if (!this.initialized) {
      await this.init();
    }

    const targetProvider = provider || this.preferredProvider || this.getFirstAvailableProvider();
    // Mutable: the provider names the model it actually served on
    // `message_complete`, and that is what the usage row has to carry. A
    // tier-based caller supplies no `request.model` at all, so without this
    // every streamed call from one is attributed to the literal 'default' and
    // priced against a rate belonging to no model.
    let model = request.model || 'default';
    const purpose = usageContext?.purpose;

    let client: LLMProviderClient | undefined;
    let resolvedProvider = targetProvider;

    if (targetProvider === 'anthropic') {
      client = this.getAnthropicForPurpose(purpose);
    } else if (targetProvider === 'openai') {
      client = this.getOpenAIForPurpose(purpose);
    } else {
      client = this.providers.get(targetProvider);
    }

    if (!client) {
      resolvedProvider = this.getFirstAvailableProvider();
      client = this.providers.get(resolvedProvider);
      if (!client) throw new Error('No LLM providers available');
      log.warn(
        { requested: targetProvider, using: resolvedProvider },
        'Requested provider unavailable, using fallback (stream)',
      );
    }

    let inputTokens = 0;
    let outputTokens = 0;
    let webSearchRequests = 0;
    let cacheWriteTokens: number | undefined;
    let cacheReadTokens: number | undefined;
    let vendorCostUsd: number | undefined;
    let success = false;
    let errorMessage: string | undefined;
    let usageEmitted = false;

    // Whether anything the consumer could have rendered has left this function.
    //
    // THE RETRY BOUNDARY, and it is not negotiable. A stream is not a request:
    // once one text delta has been yielded there is no way to un-yield it, so a
    // second attempt appends a whole second answer to the first. Before any
    // content, a restart is invisible; after it, the failure has to be shown.
    let yieldedContent = false;

    try {
      for (let attempt = 0; ; attempt++) {
      // Reset per attempt. A failed attempt reported no usage (the provider only
      // reports it on `message_complete`, which a failure never reaches), so the
      // counters below belong to whichever attempt actually finishes.
      let streamFailure: string | undefined;
      for await (const event of client.completeStream(request)) {
        // A cancelled call stops producing here even when the provider SDK had
        // no signal to give up on. Usage still lands in the finally below, so a
        // stopped turn is billed for what it actually consumed.
        if (request.abortSignal?.aborted) {
          return;
        }
        // Held rather than yielded. Whether this reaches the consumer at all
        // depends on the retry decision below, and a yielded error cannot be
        // taken back.
        if (event.type === 'error') {
          streamFailure = event.message;
          break;
        }
        if (event.type === 'message_complete') {
          // What the provider actually served, in preference to what the
          // caller asked for. A tier-based caller asks for nothing.
          if (event.model) model = event.model;
          inputTokens = event.usage.inputTokens;
          outputTokens = event.usage.outputTokens;
          webSearchRequests = event.usage.webSearchRequests ?? 0;
          cacheWriteTokens = event.usage.cacheWriteTokens;
          cacheReadTokens = event.usage.cacheReadTokens;
          vendorCostUsd = event.usage.vendorCostUsd ?? vendorCostUsd;
          success = true;

          // Fail loud on a safety refusal. Any partial text_delta already
          // yielded must be discarded by the consumer; throwing here aborts the
          // for-await loop so no consumer mistakes the partial stream for a
          // real answer. Emit usage first (tokens were billed) so accounting is
          // preserved, then throw the same typed error as the non-streaming path.
          if (event.stopReason === 'refusal') {
            await this.emitUsage({
              timestamp: new Date(),
              provider: resolvedProvider,
              model,
              inputTokens,
              outputTokens,
              webSearchRequests,
              cacheWriteTokens,
              cacheReadTokens,
              vendorCostUsd,
              success: true,
              context: usageContext,
            });
            usageEmitted = true;
            throw new LLMRefusalError({
              provider: resolvedProvider,
              model,
              category: event.refusalCategory,
            });
          }
        }
        if (event.type === 'text_delta' || event.type === 'tool_use') {
          yieldedContent = true;
        }
        yield event;
      }

      if (streamFailure === undefined) return;

      // The stream failed. Decide, then speak — never the other way round.
      const failureClass = classifyStreamFailure(new Error(streamFailure));
      const canRetry =
        isRetryableStreamFailure(failureClass) &&
        !yieldedContent &&
        attempt + 1 < STREAM_MAX_ATTEMPTS &&
        !request.abortSignal?.aborted;

      if (canRetry) {
        const delayMs = streamRetryDelayMs(attempt);
        log.warn(
          { provider: resolvedProvider, model, purpose, failureClass, attempt: attempt + 1, delayMs },
          'LLM stream failed before saying anything — retrying',
        );
        await new Promise(resolve => setTimeout(resolve, delayMs));
        continue;
      }

      // Terminal. The raw provider text goes to the log and the usage row, which
      // are ours; the consumer gets a sentence. Yielding `(err as Error).message`
      // here is what put an Anthropic wire frame in a person's chat window.
      log.error(
        {
          provider: resolvedProvider, model, purpose, failureClass,
          attempts: attempt + 1, yieldedContent, providerMessage: streamFailure,
        },
        'LLM stream failed',
      );
      errorMessage = streamFailure;
      success = false;
      yield { type: 'error', message: streamFailureMessage(failureClass) };
      return;
      }
    } catch (err) {
      // A refusal already emitted its usage row above — propagate without
      // re-emitting so token accounting isn't double-counted.
      if (err instanceof LLMRefusalError) throw err;
      // The provider's completeStream() should yield an `error` event rather
      // than throw, but if something escapes (e.g. consumer aborts) we still
      // emit a usage record so the gap is visible.
      errorMessage = (err as Error).message;
      success = false;
      await this.emitUsage({
        timestamp: new Date(),
        provider: resolvedProvider,
        model,
        inputTokens,
        outputTokens,
        webSearchRequests,
        cacheWriteTokens,
        cacheReadTokens,
        vendorCostUsd,
        success,
        error: errorMessage,
        context: usageContext,
      });
      usageEmitted = true;
      throw err;
    } finally {
      if (!usageEmitted) {
        await this.emitUsage({
          timestamp: new Date(),
          provider: resolvedProvider,
          model,
          inputTokens,
          outputTokens,
          webSearchRequests,
          cacheWriteTokens,
          cacheReadTokens,
          vendorCostUsd,
          success,
          error: errorMessage,
          context: usageContext,
        });
      }
    }
  }

  /** Invoke every registered usage callback. Awaits each callback's
   *  returned promise (if any) so that downstream code — notably
   *  attributeSessionToAgent — can rely on the usage row being committed
   *  to llm_usage_log by the time an LLM call's returned promise
   *  resolves. A failing callback never blocks or fails sibling
   *  callbacks or the caller. */
  private async emitUsage(event: LLMUsageEvent): Promise<void> {
    for (const cb of this.usageCallbacks) {
      try {
        await cb(event);
      } catch (err) {
        log.error({ error: (err as Error).message }, 'LLM usage callback failed');
      }
    }
  }

  private getFirstAvailableProvider(): LLMProvider {
    // Priority order: anthropic direct first, then openai, google
    // 'openrouter' intentionally last — opt-in via explicit provider/model, never a silent fallback.
    const priority: LLMProvider[] = ['anthropic', 'openai', 'google', 'openrouter'];
    for (const p of priority) {
      if (this.providers.has(p)) {
        return p;
      }
    }
    throw new Error('No LLM providers available');
  }

  getAvailableProviders(): LLMProvider[] {
    return Array.from(this.providers.keys());
  }

  isProviderAvailable(provider: LLMProvider): boolean {
    return this.providers.has(provider);
  }
}

// Singleton instance
export const llmClient = new LLMClient();
