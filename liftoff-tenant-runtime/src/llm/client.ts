// Unified LLM Client
// Multi-provider LLM client for tenant-runtime.
//
// Provider selection: getDefaultProvider() returns the first available
// provider in GLOBAL_PROVIDER_PRIORITY = ['anthropic', 'openai',
// 'google']. Callers can override per-call via the
// explicit `provider` parameter on complete()/countTokens().
// Anthropic + OpenAI: purpose-keyed pools route to a dedicated API key per
// purpose group for billing-dashboard visibility (see purposeToGroup at
// lines 26-49).

import { logger } from '../infrastructure/logging';
import { AnthropicProvider, GoogleProvider, OpenAIProvider } from './providers';
import { LLMRefusalError } from './types';
import { resolveByokRoutedCall } from './byok-routing';
import type { AnthropicPurposeGroup, OpenAIPurposeGroup } from '../infrastructure/secrets';
import type {
  LLMProvider,
  LLMProviderClient,
  LLMCompletionRequest,
  LLMCompletionResponse,
  LLMClientConfig,
  LLMUsageCallback,
  LLMUsageEvent,
  LLMTokenCountRequest,
  LLMTokenCountResult,
  LLMModelTier,
  ModelSelection,
} from './types';
import { resolveModelForTier } from './tiers';
import {
  areaForPurpose,
  platformVendorForArea,
  resolvePlatformVendorTarget,
} from './platform-vendor-policy';

/** Map a call purpose string to a purpose group. Used by both the Anthropic
 *  and OpenAI pool routing — the same purpose strings map to the same
 *  groups across providers. */
export function purposeToGroup(purpose: string | undefined): AnthropicPurposeGroup {
  if (!purpose) return 'agent-execution';
  if (['reflection', 'memory_consolidation', 'suggestion_applier'].includes(purpose))
    return 'reflective-services';
  if (
    purpose.startsWith('caio') ||
    purpose.startsWith('insights') ||
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
      'retrieval_hyde',
    ].includes(purpose)
  )
    return 'background-services';
  return 'agent-execution';
}

/** OpenAI purpose-group routing — same buckets as Anthropic; exposed as a
 *  separately-typed alias so the OpenAI adapter (Part 1 §C2) and OpenAI pool
 *  routing (Part 1 §C) can consume it without depending on the Anthropic
 *  return type. The implementation forwards to purposeToGroup because the
 *  group names are identical across providers. */
export function purposeToOpenAIGroup(purpose: string | undefined): OpenAIPurposeGroup {
  return purposeToGroup(purpose) as OpenAIPurposeGroup;
}

// Global provider priority — set by the platform, not tenants.
// anthropic → openai → google
const GLOBAL_PROVIDER_PRIORITY: LLMProvider[] = ['anthropic', 'openai', 'google'];

/** `area:provider` pairs already reported as unroutable. A standing condition
 *  said once rather than on every call. */
const warnedUnroutableLevers = new Set<string>();

class LLMClient {
  private providers: Map<LLMProvider, LLMProviderClient> = new Map();
  /** Purpose-keyed pool for cost-attributed Anthropic calls. Null until init(). */
  private anthropicPool: Map<AnthropicPurposeGroup, AnthropicProvider> | null = null;
  /** Purpose-keyed pool for cost-attributed OpenAI calls. Null until init(). */
  private openaiPool: Map<OpenAIPurposeGroup, OpenAIProvider> | null = null;
  private initialized = false;
  private usageCallbacks: LLMUsageCallback[] = [];

  async init(_config?: LLMClientConfig): Promise<void> {
    if (this.initialized) {
      return;
    }

    // Initialize all available providers in parallel; also spin up the
    // Anthropic + OpenAI purpose pools for cost-attribution routing.
    const [anthropicDirect, google, openaiPool, anthropicPool] = await Promise.all([
      AnthropicProvider.create(),
      GoogleProvider.create(),
      OpenAIProvider.createPool(),
      AnthropicProvider.createPool(),
    ]);

    if (anthropicDirect) this.providers.set('anthropic', anthropicDirect);
    if (google) this.providers.set('google', google);
    this.anthropicPool = anthropicPool;

    // Register OpenAI pool and default instance. The 'agent-execution' group
    // serves as the default when no purpose is provided; if it's missing,
    // fall back to any other group key in the pool.
    if (openaiPool) {
      this.openaiPool = openaiPool;
      const defaultOpenai = openaiPool.get('agent-execution') ?? [...openaiPool.values()][0];
      if (defaultOpenai) this.providers.set('openai', defaultOpenai);
    }

    if (this.providers.size === 0) {
      throw new Error('No LLM providers available. At least one provider must be configured.');
    }

    logger.info({
      message: 'LLM client initialized',
      providers: Array.from(this.providers.keys()),
      default: this.getDefaultProvider(),
      anthropicPoolActive: anthropicPool !== null,
      openaiPoolActive: openaiPool !== null,
    });
    this.initialized = true;
  }

  /** Resolve the right OpenAI provider for a given purpose. When the pool is
   *  active but the requested group key isn't configured, fall through to the
   *  `agent-execution` instance (matches the lenient OpenAI behaviour in
   *  `init()` and the per-purpose provider pool the OpenAI target uses).
   *  Falls back to the non-pooled `openai` entry when no pool is active. */
  private getOpenAIForPurpose(purpose: string | undefined): LLMProviderClient | undefined {
    if (this.openaiPool) {
      return (
        this.openaiPool.get(purposeToOpenAIGroup(purpose))
        ?? this.openaiPool.get('agent-execution')
      );
    }
    return this.providers.get('openai');
  }

  // Register a callback that fires on every LLM call (success or failure).
  // This is the single integration point for usage tracking.
  onUsage(callback: LLMUsageCallback): void {
    this.usageCallbacks.push(callback);
  }

  /**
   * Turn an entitlements task pair into a selection.
   *
   * `getModelForTask` may legitimately return a model with NO provider: when a
   * routing policy names no provider anywhere there is nothing to cross with,
   * so the override stands as written (taskSpecificPair case 1b). That pair
   * cannot be a ModelSelection on its own — a model with no provider is the
   * shape the type exists to reject — so the platform default is bound to it
   * HERE, once and visibly, rather than implicitly at each call site.
   */
  modelSelectionFor(
    pair: { model?: string; provider?: string } | null | undefined,
  ): ModelSelection {
    if (!pair?.model) {
      return pair?.provider ? { provider: pair.provider as LLMProvider } : {};
    }
    return {
      provider: (pair.provider as LLMProvider | undefined) ?? this.getDefaultProvider(),
      model: pair.model,
    };
  }

  /**
   * The provider and model id a selection resolves to at a tier: the same
   * resolution `complete` performs internally, exported for a caller that
   * builds its own client around the result (the Stagehand loop's AI SDK
   * model). A pinned model on the selection wins; otherwise the provider's
   * published id for the tier. Throws for a provider with no catalogue, as
   * resolveModelForTier does.
   */
  resolveForTier(selection: ModelSelection | undefined, tier: LLMModelTier): { provider: LLMProvider; modelId: string } {
    // A selection with no provider of its own falls to the platform default,
    // which is the FIRST registered provider: readable only after init(). This
    // method is synchronous and cannot init on its own, so a caller that has
    // not is told what is actually wrong rather than "no providers", which
    // reads as an unconfigured deployment and sent one investigation after
    // the browser task's model catalogue instead of its caller.
    if (!selection?.provider && !this.initialized) {
      throw new Error('LLM client is not initialized: await llmClient.init() before resolving the platform default provider');
    }
    const provider = selection?.provider ?? this.getDefaultProvider();
    const modelId = selection?.model ?? resolveModelForTier(provider, tier);
    return { provider, modelId };
  }

  async complete(
    request: LLMCompletionRequest,
    /** Which model serves this call. One value, because a model id is only
     *  meaningful on its provider — see ModelSelection. */
    selection?: ModelSelection,
    /** Caller-supplied context for attribution (tenantId, agentId, purpose, etc.) */
    usageContext?: Record<string, string>
  ): Promise<LLMCompletionResponse> {
    if (!this.initialized) {
      await this.init();
    }

    // The selection is the single source for both halves. Callers no longer
    // hand in a model inside `request` and a provider beside it: those were
    // independent optionals, and three sites paired them from different places
    // — a provider pinned to the platform default receiving another provider's
    // model, which the vendor answers with a 404 the caller never sees coming.
    //
    // ModelSelection makes that unwritable. This assignment is what makes it
    // true at runtime as well: whatever the request carried is replaced, so a
    // stale `model` on a request object cannot survive into the call.
    // Only the MODEL comes from the selection. `tier` stays on the request:
    // it is provider-agnostic, its eleven callers already pass it there, and
    // overwriting it from a selection that carries none would silently drop
    // every one of them onto their provider's default model.
    request = { ...request, model: selection?.model };
    const explicitProvider = selection?.provider;

    // Provider comes from:
    // 1. Explicit provider (from routing policy defaultProvider/providerOverrides)
    // 2. The PLATFORM VENDOR LEVER for this purpose's area
    // 3. Global default (first available in GLOBAL_PROVIDER_PRIORITY)
    //
    // The lever sits BELOW an explicit provider and above the global default,
    // which is the only correct place for it: a tenant's routing policy names a
    // provider and that is the customer's choice, while the global default was
    // never a choice at all — it is priority order. The lever replaces the
    // second, never the first.
    //
    // A gateway vendor fixes the MODEL too, because each family has its own
    // tier map here and the provider alone would not say which model a tier
    // means. An explicit request.model is never overruled: a lever may choose a
    // vendor, not overturn a pin.
    let leveredProvider: LLMProvider | undefined;
    if (!explicitProvider && !request.model) {
      const target = resolvePlatformVendorTarget(
        platformVendorForArea(areaForPurpose(usageContext?.purpose)),
        request.tier,
      );
      // ONLY IF THAT PROVIDER HAS A CLIENT HERE, and this is not defensive
      // padding: this client registers anthropic, openai and google, and the six
      // gateway families are served by the agent-execution adapter rather than
      // by it. So a lever on one of them is INERT for this plane's own calls —
      // compaction, recall, scanning — and has to stay inert quietly. Without
      // the check the target reaches `if (!client) throw` below and a setting
      // turns a missing client into an outage across the whole area.
      //
      // Said ONCE per area and provider. It is a standing condition, not an
      // event, and this runs on every platform call — a line per call would
      // bury the log and tell nobody anything the first line did not.
      if (target && this.isProviderAvailable(target.provider)) {
        leveredProvider = target.provider;
        if (target.model) request = { ...request, model: target.model };
      } else if (target) {
        const area = areaForPurpose(usageContext?.purpose);
        const key = `${area}:${target.provider}`;
        if (!warnedUnroutableLevers.has(key)) {
          warnedUnroutableLevers.add(key);
          logger.warn('platform vendor lever names a provider this client cannot serve; keeping the default', {
            area,
            wanted: target.provider,
            available: this.getAvailableProviders().join(', '),
          });
        }
      }
    }
    const targetProvider = explicitProvider || leveredProvider || this.getDefaultProvider();

    // When the target is the direct Anthropic provider, prefer the
    // purpose-keyed pool instance so the call is attributed to the correct
    // billing group in the Anthropic dashboard. Same for OpenAI.
    let client: LLMProviderClient | undefined;
    if (targetProvider === 'anthropic' && this.anthropicPool) {
      const group = purposeToGroup(usageContext?.purpose);
      client = this.anthropicPool.get(group);
    }
    if (targetProvider === 'openai') {
      client = this.getOpenAIForPurpose(usageContext?.purpose);
    }
    client ??= this.providers.get(targetProvider);

    if (!client) {
      throw new Error(`Provider '${targetProvider}' is not available. Available: ${this.getAvailableProviders().join(', ')}`);
    }

    const model = request.model || 'default';

    // BYO provider keys. When the customer's own key funds this call it is
    // served by a one-off client pointed at the gateway rather than by the
    // purpose-keyed pool above — the pool is built once at boot and keyed by
    // group, and a per-tenant credential cannot ride it. Null for every
    // ordinary call, which is the overwhelming majority of them.
    const byokRouting = await resolveByokRoutedCall({
      targetProvider,
      model: request.model,
      usageContext,
    });
    if (byokRouting) client = byokRouting.client;

    try {
      const response = await client.complete(request);

      // Fail loud on a provider safety refusal. The per-provider adapters
      // normalise Anthropic `stop_reason: 'refusal'`, OpenAI `content_filter` /
      // `message.refusal`, and Gemini SAFETY/prompt-block signals to
      // stopReason === 'refusal'. Returning it as a normal completion would let
      // callers write empty/partial content as a real answer, so we throw a
      // typed error here (one chokepoint) — refusals surface to failure
      // classification instead. Emit usage as a failure so the tokens the
      // provider may have billed (mid-stream refusals) stay auditable.
      if (response.stopReason === 'refusal') {
        this.emitUsage({
          timestamp: new Date(),
          provider: response.provider,
          model: response.model,
          inputTokens: response.usage?.inputTokens ?? 0,
          outputTokens: response.usage?.outputTokens ?? 0,
          cachedTokens: response.usage?.cachedTokens ?? 0,
          success: false,
          error: 'llm_refusal',
          context: usageContext,
        });
        throw new LLMRefusalError(response.provider, response.model, response.content);
      }

      this.emitUsage({
        timestamp: new Date(),
        provider: response.provider,
        model: response.model,
        inputTokens: response.usage?.inputTokens ?? 0,
        outputTokens: response.usage?.outputTokens ?? 0,
        cachedTokens: response.usage?.cachedTokens ?? 0,
        success: true,
        context: usageContext,
      });

      return response;
    } catch (error) {
      // The call failed but we may have consumed tokens on the provider side.
      // Emit what we know so the gap is visible and auditable.
      this.emitUsage({
        timestamp: new Date(),
        provider: targetProvider,
        model,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        success: false,
        error: (error as Error).message,
        context: usageContext,
      });

      throw error;
    }
  }

  private emitUsage(event: LLMUsageEvent): void {
    for (const cb of this.usageCallbacks) {
      try {
        cb(event);
      } catch (err) {
        logger.error({ error: (err as Error).message }, 'LLM usage callback failed');
      }
    }
  }

  // Global default: first available provider in platform-defined priority order
  private getDefaultProvider(): LLMProvider {
    for (const p of GLOBAL_PROVIDER_PRIORITY) {
      if (this.providers.has(p)) {
        return p;
      }
    }
    throw new Error('No LLM providers available');
  }

  // Resolve the actual provider being used for a request
  getResolvedProvider(explicitProvider?: LLMProvider): LLMProvider {
    return explicitProvider || this.getDefaultProvider();
  }

  /** Part 2 — token-counting orchestrator. Routes to the per-provider
   *  countTokens implementation, honoring the same purpose-pool selection as
   *  complete() so the chosen API key matches the one that would serve a
   *  real complete() call (Anthropic + OpenAI pools). */
  async countTokens(
    request: LLMTokenCountRequest,
    explicitProvider?: LLMProvider,
    usageContext?: Record<string, string>,
  ): Promise<LLMTokenCountResult> {
    if (!this.initialized) await this.init();

    const targetProvider = explicitProvider || this.getDefaultProvider();
    const purpose = usageContext?.purpose;

    let client: LLMProviderClient | undefined;
    if (targetProvider === 'anthropic' && this.anthropicPool) {
      const group = purposeToGroup(purpose);
      client = this.anthropicPool.get(group);
    } else if (targetProvider === 'openai') {
      client = this.getOpenAIForPurpose(purpose);
    }
    client ??= this.providers.get(targetProvider);

    if (!client) {
      throw new Error(`Provider '${targetProvider}' is not available. Available: ${this.getAvailableProviders().join(', ')}`);
    }
    // Part 7 §A — count-tokens metrics. Lazy-require so this file doesn't
    // depend on the metrics module's module init.
     
    const metrics = require('../observability/runtime-extensions-metrics') as typeof import('../observability/runtime-extensions-metrics');
    metrics.count_tokens_calls_total.inc({ provider: targetProvider });
    const start = Date.now();
    try {
      return await client.countTokens(request);
    } finally {
      metrics.count_tokens_latency_ms.observe(Date.now() - start, { provider: targetProvider });
    }
  }

  getAvailableProviders(): LLMProvider[] {
    return Array.from(this.providers.keys());
  }

  isProviderAvailable(provider: LLMProvider): boolean {
    return this.providers.has(provider);
  }
}

// Singleton instance
// I1 audit note: there is NO per-agent fallback-model mechanism in
// this runtime. `ModelConfig` carries modelId / maxTokens / temperature and
// nothing else, and no code path swaps to a second model when the first is
// rate-limited or overloaded.
//
// That is worth stating explicitly, because the failure this would otherwise
// invite is a fallback that fires on the WRONG errors — swapping models on a
// 401 masks a key rotation, and swapping on a 400 just repeats a bad request
// against a different model. Since no such path exists, none can be misrouted.
//
// Resilience therefore rests entirely on the SDK retry classification pinned in
// providers/anthropic.ts. If a fallback is ever added, it must trigger ONLY on
// rate-limit / overload / server errors, never on auth or validation.

export const llmClient = new LLMClient();
