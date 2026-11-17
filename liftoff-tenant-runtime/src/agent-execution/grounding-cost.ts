import type { ResolvedProvider } from './adapter/types';
// Per-call web-search cost for an agent invocation (provider-aware).
//
// Each adapter reports the number of native web-search calls on its usage event
// (AdapterUsage.webSearchRequests), and the agent-execution loop lands that on
// each step's `output.webSearchRequests`. Web search is billed PER CALL, not per
// token, so it cannot be derived from token counts — and the per-call rate
// differs by provider:
//   - Gemini  googleSearch grounding: $0.014/query
//   - OpenAI  hosted web_search:      $0.01/call
//   - xAI       hosted web_search:    $0.005/call
//   - Anthropic hosted WebSearch:    $0.010/call — the dearest of the four, on
//     the estate's DEFAULT provider, attached to every agent
//
// Anthropic's WebFetch and Gemini's urlContext are absent because their vendors
// bill them at no additional cost: their expense is the tokens they add, which
// the token counts already carry.
//
// OpenRouter is the only provider billing nothing here, and that is a fact about
// OpenRouter rather than a gap: it runs no hosted tools on our behalf, so its
// models reach the web through the platform's own bridged tools.
//
// Kept in a leaf module (depends only on pricing) so the completion path's
// web-search math is cheaply unit-testable AND shared verbatim between the two
// invocation-completion sites in service.ts (success + error-salvage) — they
// must agree, or a run that errors after a search would bill a different amount.
import {
  anthropicWebSearchCostUsd,
  googleSearchGroundingCostUsd,
  openAiWebSearchCostUsd,
  xaiWebSearchCostUsd,
} from '../llm/pricing';

export function computeGroundingCost(
  steps: ReadonlyArray<{ output?: unknown }>,
  provider: ResolvedProvider,
): { queries: number; costUsd: number } {
  const queries = steps.reduce(
    (sum, s) => sum + (((s.output as { webSearchRequests?: number } | undefined)?.webSearchRequests) || 0),
    0,
  );
  const costUsd =
    provider === 'openai'
      ? openAiWebSearchCostUsd(queries)
      : provider === 'google'
        ? googleSearchGroundingCostUsd(queries)
        : provider === 'xai'
          ? xaiWebSearchCostUsd(queries)
          : provider === 'anthropic'
            ? anthropicWebSearchCostUsd(queries)
            : 0; // openrouter runs no hosted tools on our behalf
  return { queries, costUsd };
}
