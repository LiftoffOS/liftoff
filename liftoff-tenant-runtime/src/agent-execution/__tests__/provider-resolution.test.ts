import { resolveProviderFromConfig, providerForStoredName, providerForModel } from '../provider-resolution';
import { RESOLVED_PROVIDERS } from '../adapter/types';

describe('resolveProviderFromConfig', () => {
  // Enumerated from RESOLVED_PROVIDERS rather than listed here. A hand-written
  // list in the test mirrors the hand-written list in the code, so both drift
  // together and the test agrees with the bug: that is how `xai` came to
  // resolve as `anthropic` while every suite stayed green.
  // 'anthropic-vertex' is excluded because it is the one member that must NOT
  // round-trip: Claude over Google Vertex is retired, and a stored value naming
  // it now resolves to the direct transport. It is still in RESOLVED_PROVIDERS
  // until the provider itself is deleted, so it is named here rather than
  // silently skipped — when it leaves VENDORS this constant becomes an empty
  // set and goes with it.
  const RETIRED_TRANSPORTS = new Set(['anthropic-vertex']);
  const ROUND_TRIPPING = [...RESOLVED_PROVIDERS].filter((p) => !RETIRED_TRANSPORTS.has(p));

  it.each(ROUND_TRIPPING)('returns %s for a config that names it', (provider) => {
    expect(resolveProviderFromConfig({ provider })).toBe(provider);
  });

  it('resolves a stored anthropic-vertex to the direct Anthropic transport', () => {
    // Vertex and the direct API serve the SAME models under the same ids, so
    // this is not a substitution — it is the same model over the path that
    // always actually carried it.
    //
    // Untranslated it would not merely fall back: resolveModelForTier and
    // createAdapter both THROW on a provider they do not know, so a workspace
    // that pinned Vertex would lose every chat turn and every autonomous run
    // the moment the provider was deleted. This is what makes that deletion
    // safe to ship afterwards.
    expect(resolveProviderFromConfig({ provider: 'anthropic-vertex' })).toBe('anthropic');
    expect(providerForStoredName('anthropic-vertex', undefined)).toBe('anthropic');
    // The model id is irrelevant: unlike the gateway name there is nothing to
    // derive, because the id is the same id on either transport.
    expect(providerForStoredName('anthropic-vertex', 'claude-opus-5-5')).toBe('anthropic');
  });

  it('defaults to anthropic for unset / unknown', () => {
    // The fallback is why a missing provider is silent rather than loud: the
    // agent runs, on a vendor nobody chose.
    expect(resolveProviderFromConfig({})).toBe('anthropic');
    expect(resolveProviderFromConfig(undefined)).toBe('anthropic');
    expect(resolveProviderFromConfig({ provider: 'bogus' })).toBe('anthropic');
  });

  it('uses the router only when the config names no provider', () => {
    expect(resolveProviderFromConfig({}, 'google')).toBe('google');
    expect(resolveProviderFromConfig({ provider: 'openai' }, 'google')).toBe('openai');
    expect(resolveProviderFromConfig(undefined, undefined)).toBe('anthropic');
  });
});

describe('providerForStoredName', () => {
  it('sends a Grok model to xAI even when its config still says openrouter', () => {
    // Every configuration written before Grok became its own provider says
    // `openrouter` and carries a Grok id. Left alone it resolves to a gateway
    // family and a MANAGED turn runs that family's tier map — a different
    // vendor's model, silently.
    expect(providerForStoredName('openrouter', 'x-ai/grok-4.6')).toBe('xai');
    expect(providerForStoredName('openrouter', 'grok-4.3')).toBe('xai');
  });

  it('reads the family out of the model id for the rest', () => {
    // The four open-weight families are what the gateway is FOR, and the
    // publisher segment is the only thing in a stored config that says which
    // one was chosen — 'openrouter' answered for all four.
    expect(providerForStoredName('openrouter', 'z-ai/glm-4.6')).toBe('glm');
    expect(providerForStoredName('openrouter', 'qwen/qwen3-max')).toBe('qwen');
    expect(providerForStoredName('openrouter', 'deepseek/deepseek-v4-pro')).toBe('deepseek');
    expect(providerForStoredName('openrouter', 'moonshotai/kimi-k3')).toBe('kimi');
  });

  it('falls back to GLM when the id says nothing', () => {
    // What the gateway name actually ran: one tier map, publishing GLM. Any
    // other answer would change which model an existing agent runs.
    expect(providerForStoredName('openrouter', undefined)).toBe('glm');
    expect(providerForStoredName('openrouter', 'something-unnamespaced')).toBe('glm');
  });

  it('leaves every other name alone', () => {
    expect(providerForStoredName('anthropic', 'claude-opus-5')).toBe('anthropic');
    expect(providerForStoredName('qwen', 'qwen/qwen3-max')).toBe('qwen');
    expect(providerForStoredName(undefined, undefined)).toBeUndefined();
  });
});

describe('providerForModel', () => {
  it('never redirects a provider that was chosen deliberately', () => {
    // It only ever moves Grok off a gateway family. A model whose provider says
    // anything else is left alone, whatever it is named.
    expect(providerForModel('anthropic', 'x-ai/grok-4.6')).toBe('anthropic');
    expect(providerForModel('xai', 'grok-4.6')).toBe('xai');
    expect(providerForModel('openai', 'gpt-5')).toBe('openai');
  });

  it('matches a Grok id only at the START, in either namespace', () => {
    // A different vendor's model with `grok` somewhere in its name is not this
    // one, and both namespaces are live while stored configs predate the move.
    expect(providerForModel('openrouter', 'vendor/not-grok-4.6')).toBe('openrouter');
    expect(providerForModel('openrouter', 'grokking/some-model')).toBe('openrouter');
  });

  it('carries through the config resolver', () => {
    expect(resolveProviderFromConfig({ provider: 'openrouter', modelId: 'x-ai/grok-4.6' }))
      .toBe('xai');
  });
});
