// GLM (Z.ai) tier map.
//
// This file was named for the GATEWAY rather than the vendor, and its map was
// the only one four providers could reach: GLM, Qwen, DeepSeek and Kimi all
// resolved as 'openrouter', so a workspace set to any of them ran these ids.
// Naming it for the family it publishes is the smaller half of fixing that.
//
// GLM is reached over the OpenAI wire protocol through OpenRouter (see the
// openRouterTarget path and the opencode adapter, both of which pass the model
// straight through as the gateway's model id). Ids are full OpenRouter slugs
// (`<publisher>/<model>`), NOT bare names — a bare name is rejected.
//
// Without this map, resolveModelForTier('glm', …) throws rather than falling
// back to another vendor's catalogue. `z-ai/glm-4.7-flash` is the cheapest, so
// it serves the small tier.

import type { LLMModelTier } from '../types';

// The GLM-5.3 line. A tier is an ABSOLUTE capability class — large is
// Opus-class, medium Sonnet-class, small Haiku-class — so `glm-5.3`, which is
// Sonnet-class, holds medium and is REPEATED INTO LARGE rather than promoted:
// Z.ai publishes nothing at the Opus class. `glm-5.3-flash` is the Haiku-class
// model and takes small on its own.
//
// `glm-5.3-prime` and `glm-5.3-flashx` are deliberately absent. Each is the
// same-size faster build of the id above it, so neither is a capability class,
// and prime costs what glm-5.3 costs at endpoint-max.
export const TIER_MODELS: Record<LLMModelTier, string> = {
  large:    'z-ai/glm-5.3',
  medium:   'z-ai/glm-5.3',
  small:    'z-ai/glm-5.3-flash',
};
