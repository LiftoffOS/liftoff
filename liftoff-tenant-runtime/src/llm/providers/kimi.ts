// Kimi (Moonshot AI), served over OpenRouter.
//
// Same shape as its two neighbours: a provider the registry approves, with
// OpenRouter-namespaced ids billing to the OpenRouter account, mapped to the
// shared OpenAI-wire engine.
//
// Caches automatically — "prompt caching with Moonshot AI is automated and does
// not require any additional configuration" (openrouter.ai prompt-caching guide,
// read 2026-09-11).
//
// Two tiers, and `small` falls back to medium for the same reason DeepSeek's
// does: the registry approves no small model, and inventing an id to fill the
// column would route traffic at a model nobody approved.

import type { LLMModelTier } from '../types';

// K3 (2.8T parameters, text/image/video, a 1M window) is Sonnet-class, so it
// holds medium and is repeated into large — Moonshot publishes nothing
// Opus-class. K2.6, the current revision of the Haiku-class K2 family, takes
// small. This corrects a ladder that repeated the WRONG WAY: K3 sat alone in
// large and K2.6 was duplicated across medium and small.
export const TIER_MODELS: Record<LLMModelTier, string> = {
  large:    'moonshotai/kimi-k3',
  medium:   'moonshotai/kimi-k3',
  small:    'moonshotai/kimi-k2.6',
};
