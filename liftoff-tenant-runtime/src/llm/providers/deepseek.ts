// DeepSeek, served over OpenRouter.
//
// Same shape as Qwen beside it: a provider the registry approves, whose ids are
// OpenRouter-namespaced and whose calls bill to the OpenRouter account, so it
// maps to the shared OpenAI-wire engine rather than an endpoint of its own.
//
// Caches automatically through that endpoint — "prompt caching with DeepSeek is
// automated and does not require any additional configuration" (openrouter.ai
// prompt-caching guide, read 2026-09-11) — so unlike Qwen it needs nothing here.
//
// Two tiers, not three. The registry approves large and medium; `small`
// resolves to medium through the tier fallback, which is the honest answer for a
// family that publishes no small model rather than a third id invented to fill
// the column.

import type { LLMModelTier } from '../types';

// V4 Pro (1.6T total / 49B activated) is Sonnet-class and holds medium,
// repeated into large — DeepSeek publishes nothing Opus-class. V4.1 Flash
// (8B activated on input, 16B on output) is Haiku-class and takes small.
export const TIER_MODELS: Record<LLMModelTier, string> = {
  large:    'deepseek/deepseek-v4-pro',
  medium:   'deepseek/deepseek-v4-pro',
  small:    'deepseek/deepseek-v4.1-flash',
};
