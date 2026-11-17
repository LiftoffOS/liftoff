import { isResolvedProvider } from './adapter/types';
import type { ResolvedProvider } from './adapter/types';
import { familyOfModelId, isGatewayServed, GATEWAY_DEFAULT_FAMILY } from './adapter/model-family';
import { isGrokModel } from '../llm/providers/xai';
import { resolveModelForTier } from '../llm/tiers';
import { normalizeTier } from '../llm/types';

/** The gateway's name, which is not a provider and never was a family.
 *
 *  A string rather than a member of the union, because that is exactly what it
 *  is now: a value stored configuration can still carry and this runtime does
 *  not resolve. */
const GATEWAY_PROVIDER_NAME = 'openrouter';

/** The retired transport name, for the same reason and in the same shape.
 *
 *  Claude served over Google Vertex is gone. It never named a different MODEL —
 *  Vertex and the direct API serve the same Anthropic ids — so it named a
 *  transport, and the transport that remains is the direct one. A stored value
 *  still saying it is therefore translated rather than rejected: this is the
 *  same model over the path that always actually carried it.
 *
 *  A string rather than a union member, deliberately: it is precisely a value
 *  stored configuration can still carry and this runtime no longer resolves. */
const RETIRED_TRANSPORT_NAME = 'anthropic-vertex';

/**
 * Resolve the execution provider from an agent's persisted `modelConfig`
 * (the `agents.model_config` column — a verbatim passthrough of platform-backend's
 * `payload.modelConfig`, written by events/subscriber.ts). Chat and autonomous
 * execution must agree on this. The autonomous path additionally falls back to
 * entitlements routing (`entitlementsClient.getModelForTask`); that fallback is
 * intentionally NOT replicated here — interactive chat resolves from the agent's
 * own config and defaults to Anthropic when unset/unknown.
 *
 * Membership is tested against `RESOLVED_PROVIDERS` rather than a list written
 * out here. A provider this misses does not fail: it falls through to
 * `anthropic` and the agent runs on a vendor nobody chose, which reads as a
 * routing preference rather than as a bug.
 *
 * THE LEGACY NAME IS TRANSLATED BEFORE THAT TEST, and the order is the whole
 * point. 'openrouter' is not a provider any more, so it fails the membership
 * test and lands on the Anthropic fallback — a GLM agent silently running
 * Claude, which is the quietest failure this file can produce. Translating
 * first keeps a configuration written under the old vocabulary resolving to the
 * vendor its owner chose.
 */
export function resolveProviderFromConfig(
  modelConfig: { provider?: string; modelId?: string } | undefined,
  /** The entitlements router's answer, used only when the agent's own config
   *  names no provider. Optional because the chat path had it and the
   *  autonomous path had it and this function had neither, which is how it
   *  ended up with no callers at all while both of them resolved by hand. */
  routedProvider?: string | null,
): ResolvedProvider {
  const configured = modelConfig?.provider || routedProvider || undefined;
  const named = providerForStoredName(configured, modelConfig?.modelId);
  const base = isResolvedProvider(named) ? named : 'anthropic';
  return providerForModel(base, modelConfig?.modelId);
}

/**
 * What a stored provider name means today.
 *
 * TWO names need translating.
 *
 * The retired transport's. 'anthropic-vertex' named Claude reached over Google
 * Vertex, which is gone; it never named a different model, so it resolves to
 * 'anthropic' — the same model over the path that always carried it. Left
 * untranslated it would fail the membership test in resolveProviderFromConfig
 * and, worse, reach resolveModelForTier and createAdapter, both of which THROW
 * on a provider they do not know.
 *
 * And the gateway's. GLM, Qwen, DeepSeek and Kimi were
 * all stored as 'openrouter' because that is how they are reached, and a
 * gateway cannot say which of four families a configuration chose — which is
 * why they are providers in their own right now. The model id can say, because
 * these ids carry their publisher.
 *
 * GLM when the id says nothing, because GLM is what the single OpenRouter tier
 * map published: a configuration that named the gateway and pinned no model ran
 * GLM, so any other answer would change which model that agent runs.
 *
 * Everything else passes through untouched, including a name this runtime does
 * not know — deciding what to do with one of those is the caller's job, and it
 * has a documented answer.
 */
export function providerForStoredName(
  provider: string | undefined,
  modelId: string | null | undefined,
): string | undefined {
  // The retired transport first, and unconditionally: unlike the gateway there
  // is nothing to derive from the model id, because the id is the same id.
  if (provider === RETIRED_TRANSPORT_NAME) return 'anthropic';
  if (provider !== GATEWAY_PROVIDER_NAME) return provider;
  // Grok first: it left the gateway for its own API, so a Grok id under the
  // gateway name is not one of the four open-weight families.
  if (isGrokModel(modelId)) return 'xai';
  return familyOfModelId(modelId) ?? GATEWAY_DEFAULT_FAMILY;
}

/**
 * The provider a MODEL has to execute on, which is not always the one its
 * configuration names.
 *
 * Grok is the case, and it is a migration artifact rather than a permanent
 * rule. It executed as `openrouter` until it became its own provider, so a
 * configuration written before that move can still pair a Grok model id with
 * another provider — and a Grok id sent to another vendor's endpoint names a
 * model that endpoint has never heard of.
 *
 * So the model decides. A stored provider is a statement about where a model
 * used to be reachable; the model id is a statement about what it actually is.
 *
 * NARROW ON PURPOSE: only a gateway-served family is redirected, because that
 * is where a stale Grok id can still be sitting — 'openrouter' resolved to one
 * of those four. A model whose provider was chosen deliberately is left alone
 * whatever its id says, which is what stops this from becoming a second,
 * silent routing rule.
 */
export function providerForModel(
  provider: ResolvedProvider,
  modelId: string | null | undefined,
): ResolvedProvider {
  if (isGatewayServed(provider) && isGrokModel(modelId)) return 'xai';
  return provider;
}

/**
 * The concrete model id an agent's run executes on, given the provider it was
 * already resolved to and the workspace routing policy's answer.
 *
 * THE ONE COPY. executeTask, the interactive chat turn and the test harness all
 * resolve through it, because they must agree: chat hands its tool catalog to
 * executeTask prebuilt, so the catalog's model (what code_session reads as
 * `outerModelId` and codes on) and the engine's model come from different
 * callers. While each resolved by hand, only executeTask knew the cross-vendor
 * rule below, and a Qwen-overridden team on a GLM workspace chatted on Qwen
 * while its coding sessions ran GLM's model, billed as Qwen.
 *
 * Precedence:
 *   1. An explicitly pinned `model_config.modelId`.
 *   2. The workspace routing policy's model, ONLY when it belongs to this
 *      provider. The workspace answers for the workspace's vendor; an agent
 *      moved to another by the per-agent AI Provider Override is not on it, and
 *      a policy model handed over would be another family's id. A policy naming
 *      no provider cannot be crossed, so it stands as written.
 *   3. The provider's own tier table, at the agent's tier (medium by default).
 *      Throws for a provider with no catalogue, by design.
 */
export function resolveAgentModelId(
  modelConfig: { modelId?: unknown; tier?: unknown } | undefined,
  provider: string,
  routed: { model?: string | null; provider?: string | null } | null | undefined,
): string {
  const explicitModelId = modelConfig?.modelId as string | undefined;
  if (explicitModelId) return explicitModelId;
  if (routed?.model && (!routed.provider || routed.provider === provider)) return routed.model;
  const tier = (normalizeTier(modelConfig?.tier) as string | undefined) || 'medium';
  return resolveModelForTier(provider, tier);
}
