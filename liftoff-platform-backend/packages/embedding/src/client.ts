import {
  EmbeddingError,
  type EmbedCall,
  type EmbeddingProvider,
  type EmbeddingProviderCapabilities,
  type EmbeddingProviderClient,
  type EmbeddingResponse,
  type EmbeddingUsageCallback,
  type EmbeddingUsageEvent,
} from './types';

export interface EmbeddingClientInitConfig {
  /** Map of provider id to client. Keys can be any string — the well-known
   *  values are 'openai' | 'google' | 'voyage' but consumers can register
   *  third-party providers under any name. */
  providers: Partial<Record<EmbeddingProvider, EmbeddingProviderClient>>;
  /** Explicit default provider. Must be present in `providers`. Takes
   *  precedence over `defaultPreference`. */
  defaultProvider?: EmbeddingProvider;
  /** Ordered preference list. The first provider in this list that is
   *  also in `providers` becomes the default. If neither this nor
   *  `defaultProvider` are set, an arbitrary configured provider is picked.
   *  Defaults to ['google', 'voyage', 'openai']. */
  defaultPreference?: EmbeddingProvider[];
}

const BUILTIN_PREFERENCE: readonly EmbeddingProvider[] = ['google', 'voyage', 'openai'];

export class EmbeddingClient {
  private providers: Map<EmbeddingProvider, EmbeddingProviderClient> = new Map();
  private defaultProvider: EmbeddingProvider | undefined = undefined;
  private usageCallbacks: EmbeddingUsageCallback[] = [];
  private initialized = false;

  /** Configure the client. Idempotent — subsequent calls are no-ops. Use
   *  `reset()` first if you need to reconfigure (tests only). */
  init(config: EmbeddingClientInitConfig): void {
    if (this.initialized) return;

    for (const [provider, client] of Object.entries(config.providers)) {
      if (client) this.providers.set(provider, client);
    }
    if (this.providers.size === 0) {
      throw new Error('EmbeddingClient.init: at least one provider required');
    }

    if (config.defaultProvider) {
      if (!this.providers.has(config.defaultProvider)) {
        throw new Error(`EmbeddingClient.init: defaultProvider "${config.defaultProvider}" not configured`);
      }
      this.defaultProvider = config.defaultProvider;
    } else {
      const preference = config.defaultPreference ?? BUILTIN_PREFERENCE;
      const picked = preference.find(p => this.providers.has(p));
      this.defaultProvider = picked ?? this.providers.keys().next().value;
    }
    this.initialized = true;
  }

  /** Reset to uninitialized state. Primarily for tests that need to
   *  reconfigure between cases. NOT intended for production runtime use. */
  reset(): void {
    this.providers.clear();
    this.defaultProvider = undefined;
    this.usageCallbacks = [];
    this.initialized = false;
  }

  onUsage(callback: EmbeddingUsageCallback): void {
    this.usageCallbacks.push(callback);
  }

  /** Returns the static capability flags for a provider, or undefined if
   *  the provider is not configured. Use this to avoid passing options
   *  the provider will silently ignore (e.g. taskType on a symmetric model). */
  capabilitiesOf(provider: EmbeddingProvider): EmbeddingProviderCapabilities | undefined {
    return this.providers.get(provider)?.capabilities;
  }

  /** Returns the resolved default provider, or undefined before init. */
  getDefaultProvider(): EmbeddingProvider | undefined {
    return this.defaultProvider;
  }

  /** The space (provider + its defaultModel) that a default embed() call
   *  will produce vectors in. Undefined before init. Powers drift
   *  detection without a probe call. */
  getDefaultEmbeddingSpace(): { provider: EmbeddingProvider; model: string } | undefined {
    if (!this.defaultProvider) return undefined;
    const model = this.providers.get(this.defaultProvider)?.defaultModel;
    return model ? { provider: this.defaultProvider, model } : undefined;
  }

  /** Embed input(s) via the requested provider (or the client's default).
   *  Emits one EmbeddingUsageEvent per call to every registered onUsage
   *  callback — success AND failure. */
  async embed(call: EmbedCall): Promise<EmbeddingResponse> {
    if (!this.initialized) {
      throw new Error('EmbeddingClient not initialized; call init() first');
    }
    const targetProvider = call.provider ?? this.defaultProvider;
    if (!targetProvider) {
      throw new Error('EmbeddingClient: no provider available — init() did not resolve a default');
    }
    const client = this.providers.get(targetProvider);
    const start = new Date();
    // Strip client-level fields (`provider`, `context`) before passing to the
    // provider; the provider only sees the EmbeddingRequest slice —
    // timeoutMs/retries are part of that slice and MUST be forwarded here or
    // they silently never reach the transport.
    const { input, model, dimensions, taskType, timeoutMs, retries } = call;
    const { context } = call;
    const request = { input, model, dimensions, taskType, timeoutMs, retries };

    if (!client) {
      const event: EmbeddingUsageEvent = {
        timestamp: start,
        provider: targetProvider,
        model: '(none)',
        inputTokens: 0,
        success: false,
        error: `embedding provider "${targetProvider}" not configured`,
        context,
      };
      await this.emit(event);
      throw new EmbeddingError(event.error!, { kind: 'invalid', provider: targetProvider });
    }

    try {
      const inner = await client.embed(request);
      // Force-set provider on the response so callers can rely on it even
      // if a provider implementation forgets to populate it.
      const response: EmbeddingResponse = { ...inner, provider: client.provider };
      // Defensive vector-count check. Per-provider implementations validate
      // this too, but enforcing at the client level means any provider
      // implemented later can't silently mis-pair vectors to inputs.
      const expectedCount = Array.isArray(request.input) ? request.input.length : 1;
      if (response.embeddings.length !== expectedCount) {
        throw new EmbeddingError(
          `${client.provider}: returned ${response.embeddings.length} embeddings for ${expectedCount} inputs`,
          { kind: 'unknown', provider: client.provider },
        );
      }
      await this.emit({
        timestamp: start,
        provider: client.provider,
        model: response.model,
        inputTokens: response.promptTokens,
        success: true,
        context,
      });
      return response;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.emit({
        timestamp: start,
        provider: client.provider,
        model: request.model ?? client.defaultModel,
        inputTokens: 0,
        success: false,
        error: message,
        context,
      });
      throw err;
    }
  }

  private async emit(event: EmbeddingUsageEvent): Promise<void> {
    for (const cb of this.usageCallbacks) {
      try { await cb(event); }
      catch { /* callback failures must never abort the embed call */ }
    }
  }
}

/** Module-level singleton — same pattern as @liftoffos/service-client. For
 *  parallel configurations or test isolation, instantiate `new EmbeddingClient()`
 *  directly. */
export const embeddingClient = new EmbeddingClient();
