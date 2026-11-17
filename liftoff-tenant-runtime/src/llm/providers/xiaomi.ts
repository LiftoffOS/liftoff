// Xiaomi's MiMo line, served over OpenRouter.
//
// Same shape as its gateway neighbours: a provider the registry approves, with
// OpenRouter-namespaced ids billing to the OpenRouter account, mapped to the
// shared OpenAI-wire engine.
//
// Two classes, not three. MiMo-V2.6-Pro is over 1T parameters and is
// Sonnet-class, so it holds medium and is REPEATED INTO LARGE — Xiaomi
// publishes nothing at the Opus class, and a tier here is an absolute
// capability class rather than a ranking of a vendor's own models.
// MiMo-V2.6-Flash is a 309B total / 15B activated MoE, the Haiku-class model,
// and takes small.
//
// `mimo-v2.6-pro-ultraspeed` is deliberately absent and is the trap in this
// line. It is not a third model: the vendor's own description says it is built
// from the same 1T MiMo-V2.6-Pro checkpoint and matches it in quality, at
// roughly 10x the speed — and 10x the rate. Nothing should route to a model
// that is its neighbour at ten times the price for the same answers.
//
// Both models read images; both were verified live through the gateway.

import type { LLMModelTier } from '../types';

export const TIER_MODELS: Record<LLMModelTier, string> = {
  large:    'xiaomi/mimo-v2.6-pro',
  medium:   'xiaomi/mimo-v2.6-pro',
  small:    'xiaomi/mimo-v2.6-flash',
};
