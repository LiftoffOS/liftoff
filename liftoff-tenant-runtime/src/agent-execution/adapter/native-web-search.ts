// Which (engine, model) pairs search the web NATIVELY — with the model
// vendor's own hosted search, attached to the model's own calls — and which
// reach it through the platform's bridged `web_search` tool instead.
//
// One rule, so a model never sees two things called web search. Where the
// engine attaches the vendor's hosted search, that IS the basic search, and
// the bridged tool is not offered; where it cannot, the bridged tool is, on
// the backend the provider owns (router.search). The advanced platform tools
// (web_research, web_fetch_advanced, …) are offered either way.
//
// Decided per ENGINE rather than per provider, because the same provider
// searches natively on one engine and not on another: Grok's search is
// attached by the OpenAI-wire target and unreachable from opencode; OpenAI's
// by Codex (live) and by the Agents SDK bridge on the Responses families
// only.

import type { ExecutionEngineId } from './types';
import { isOpenAiResponsesModel } from './openai/responses-models';
import { engineLabelFor, isResolvedProvider } from './engine-resolver';
import { resolveModelForTier } from '../../llm/tiers';

/**
 * Whether this engine, driving this model, carries the vendor's own web
 * search on the model's calls.
 *
 * Exhaustive over the union so a new engine is a compile error here rather
 * than a silent "no" — a silent no would offer the bridged tool beside a
 * native one, and a silent yes would leave an engine with no search at all.
 */
export function engineHasNativeWebSearch(engine: ExecutionEngineId, model: string): boolean {
  switch (engine) {
    // Claude's WebSearch / WebFetch, attached default-on (anthropic/native-web-tools.ts).
    case 'claude-agent-sdk':
      return true;
    // Codex's web_search, pinned live (codex/index.ts).
    case 'openai-codex':
      return true;
    // OpenAI's hosted web_search, on the Responses-API families only
    // (openai/index.ts: `nativeOpenAiWebTools`).
    case 'openai-agents':
      return isOpenAiResponsesModel(model);
    // xAI's hosted web_search, on every Grok model (xai/index.ts).
    case 'xai-openai-wire':
      return true;
    // Google Search grounding on the Gen AI SDK loop (gemini/index.ts), and
    // the CLI's own google_web_search (gemini-cli/index.ts).
    case 'google-genai':
    case 'google-gemini-cli':
      return true;
    // ADK attaches no grounding tool; the bridged search covers it.
    case 'google-adk':
      return false;
    // opencode attaches no vendor tool to the model's calls, and its own
    // `websearch` built-in is a third party's, not the vendor's, so it is
    // denied; OpenRouter runs no hosted tools on our behalf.
    case 'opencode':
    case 'openrouter-openai-wire':
      return false;
    // Never constructable; nothing is offered for it.
    case 'unknown-legacy':
      return false;
    default: {
      const _exhaustive: never = engine;
      return _exhaustive;
    }
  }
}

/**
 * The same answer for a RUN, from what the catalog builders hold: the
 * provider the run resolved to and, when known, its model. The engine is the
 * one that provider resolves to on this service; a model left unresolved is
 * the provider's medium tier, which is what the run itself would be given.
 *
 * Undefined when the caller does not know the provider at all — a pre-flight
 * check assembling a catalog for no run — and the exposure gate then offers
 * the bridged tool rather than withholding one on a guess.
 */
export function nativeWebSearchFor(provider: string | undefined, model: string | undefined): boolean | undefined {
  if (!provider || !isResolvedProvider(provider)) return undefined;
  const resolvedModel = model ?? resolveModelForTier(provider, 'medium');
  return engineHasNativeWebSearch(engineLabelFor(provider), resolvedModel);
}
