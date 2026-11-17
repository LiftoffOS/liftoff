// xAI (Grok) tier map.
//
// Grok used to execute as `openrouter`, which put it behind the same tier map
// as GLM, Qwen, DeepSeek and Kimi and made two things impossible to express:
// which of those five vendors an agent had actually chosen, and the fact that
// exactly one of them can be funded by a customer's own key. Selecting Grok at
// the agent level therefore resolved a GLM model unless a concrete id was
// pinned, and funding it meant re-routing off OpenRouter mid-run.
//
// It is its own provider now. OpenRouter keeps the open-weight models, whose
// value is one integration and one invoice across many vendors; Grok has an API
// and an account of its own, so it gets a provider of its own.
//
// MODEL IDS ARE NATIVE. `x-ai/grok-4.6` is OpenRouter's namespaced slug for the
// model; xAI's own API calls it `grok-4.6`, and that is what these are. Sending
// the slug to api.x.ai is a 404.

import type { LLMModelTier } from '../types';

export const TIER_MODELS: Record<LLMModelTier, string> = {
  large:    'grok-4.6',
  medium:   'grok-4.3',
  // Small buys SPEED rather than savings: the 4.20 family is speed-optimised
  // with a 2M window and is listed at the same rate as grok-4.3. That is a
  // deliberate product choice, not an oversight to "correct" by duplicating
  // medium down.
  //
  // The FULL id matters. There is no bare `grok-4.20` on api.x.ai — it serves
  // `grok-4.20-0309-reasoning`, `-non-reasoning` and `-multi-agent-0309`, and
  // the bare id 404s. Non-reasoning is the one a speed tier wants; both it and
  // the reasoning variant dispatch tools correctly, while multi-agent does not
  // (which is why migration 380 excluded it).
  small:    'grok-4.20-0309-non-reasoning',
};

/** The base URL xAI's own API is served from. Kept beside the tier map so the
 *  two facts about "where Grok lives" are in one file. */
export const XAI_BASE_URL = 'https://api.x.ai';

/**
 * Whether a model id names a Grok model, in EITHER namespace.
 *
 * Both forms are live and will be for as long as any stored configuration
 * predates the provider move: `x-ai/grok-4.6` is what OpenRouter published and
 * is what every agent configured before it still carries, and `grok-4.6` is
 * what xAI's own API calls the same model.
 *
 * Anchored, so an id that merely CONTAINS the segment does not match — a
 * different vendor's model with `grok` somewhere in its name is not this one.
 */
export function isGrokModel(modelId: string | null | undefined): boolean {
  return !!modelId && /^(?:x-ai\/)?grok[-.]/i.test(modelId);
}

/**
 * The canonical id for a Grok model: xAI's own, without OpenRouter's publisher
 * segment.
 *
 * Both forms arrive. `x-ai/grok-4.6` is what OpenRouter published and what every
 * configuration written before the provider move still carries; `grok-4.6` is
 * what xAI's API calls it and what it is registered and PRICED under.
 *
 * Which is why this is not only a wire concern. Sending the slug to api.x.ai is
 * a 404 — loud, and caught immediately. Looking a rate up under the slug is
 * silent: the key `xai:x-ai/grok-4.3` matches nothing, the run records its
 * tokens at zero cost, and the only trace is a counter nobody is watching. The
 * request boundary and the pricing boundary need the same answer, so they read
 * it from the same function.
 *
 * Anchored at the start: an id that merely CONTAINS the publisher segment is
 * not in OpenRouter's namespace and must not be rewritten.
 */
export function xaiNativeModelId(model: string): string {
  return model.replace(/^x-ai\//, '');
}

/**
 * Whether a Grok id names a NON-reasoning variant.
 *
 * The 4.20 family ships the same weights as `-reasoning` and `-non-reasoning`
 * ids, and the small tier above is deliberately the latter: it buys speed. A
 * consumer that flags every Grok model as reasoning-capable — opencode's model
 * record does, unless told otherwise — offers reasoning-effort variants on a
 * model that has no reasoning to vary. Read off the id in either namespace,
 * the same way `isGrokModel` is.
 */
export function isNonReasoningGrokModel(modelId: string | null | undefined): boolean {
  return isGrokModel(modelId) && /-non-reasoning$/i.test(xaiNativeModelId(modelId as string));
}
