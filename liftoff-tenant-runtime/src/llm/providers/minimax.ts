// MiniMax, served over OpenRouter.
//
// Same shape as its three neighbours: a provider the registry approves, with
// OpenRouter-namespaced ids billing to the OpenRouter account, mapped to the
// shared OpenAI-wire engine.
//
// Two tiers, and `small` falls back to medium — but for a sharper reason than
// DeepSeek's and Kimi's "the registry approves no small model". MiniMax has no
// small CLASS. M3 is ~428B total / ~23B activated at a 1M window; the whole
// M2.x line (M2, M2.1, M2.5, M2.7) is one ~229B / 10B-activated model revised
// four times at a 204,800 window. So the obvious candidate — M2, at half the
// rate of M2.7 — is the same activated size as the model it would sit below.
// It buys cost and not speed, which is not what this tier is for.
//
// M3 is the only one that accepts an image or a video; the M2.x line is
// text-only.

import type { LLMModelTier } from '../types';

// M3 is Sonnet-class: it holds medium and is repeated into large, MiniMax
// publishing nothing Opus-class. M2.7 is the Haiku-class model and takes small.
export const TIER_MODELS: Record<LLMModelTier, string> = {
  large:    'minimax/minimax-m3',
  medium:   'minimax/minimax-m3',
  small:    'minimax/minimax-m2.7',
};
