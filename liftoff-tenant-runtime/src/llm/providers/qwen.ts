// Qwen, served over OpenRouter.
//
// A provider in its own right — the registry approves it at all three tiers —
// but not its own ENDPOINT: the ids are OpenRouter-namespaced (`qwen/...`) and
// the calls bill to the OpenRouter account. That is the difference from Grok,
// which moved to api.x.ai and took its billing with it, and it is why the vendor
// record maps this provider to the shared OpenAI-wire engine rather than a new
// one.
//
// THE ONE FAMILY THROUGH THAT ENDPOINT THAT DOES NOT CACHE ON ITS OWN.
// DeepSeek, Grok, Kimi, Moonshot and Z.AI are automatic; Alibaba requires
// explicit `cache_control: { type: 'ephemeral' }` breakpoints on the content to
// cache, and only on the models it lists (openrouter.ai prompt-caching guide,
// read 2026-09-16; see ALIBABA_EXPLICIT_CACHE_MODELS). Without them a listed
// Qwen model caches nothing while every sibling model caches fine — identical
// engine, identical adapter, identical prompt, only the model id differing,
// which is not a difference anyone would go looking for.

import type { LLMModelTier } from '../types';

/** Mirrors the approved registry rows. The registry is authoritative; this is
 *  the seed the runtime resolves against before the first overlay load, and the
 *  drift check compares the two. */
export const TIER_MODELS: Record<LLMModelTier, string> = {
  large:    'qwen/qwen3.8-max-0902',
  medium:   'qwen/qwen3.7-plus',
  // 3.8 Flash. Flat-rated, where 3.7 Flash bands upward from 32,000 prompt
  // tokens — a routine turn — so the headline gap overstates the real one.
  small:    'qwen/qwen3.8-flash',
};

/**
 * The models OpenRouter documents Alibaba explicit caching for.
 *
 * READ OFF THE VENDOR'S PAGE, never from memory, and never widened to "every
 * Qwen model": openrouter.ai/docs/guides/best-practices/prompt-caching, read
 * 2026-09-16, says verbatim — "Alibaba explicit caching is available on
 * `deepseek/deepseek-v3.2`, `qwen/qwen3-max`, `qwen/qwen-plus`,
 * `qwen/qwen3.6-plus`, `qwen/qwen3-coder-plus`, and `qwen/qwen3-coder-flash`.
 * Snapshot endpoints, including `qwen/qwen3.5-plus-02-15` and
 * `qwen/qwen3.5-flash-02-23`, do not support explicit caching."
 *
 * This used to be `/(^|\/)qwen/i` — every Qwen model — which sent a
 * `cache_control` block to endpoints the vendor says ignore it, including the
 * dated snapshots, and asserted caching on ids nobody had checked. A model not
 * on this list gets NO breakpoint: the field is omitted, not sent hopefully.
 * Note what that means for the tier map above — none of the three ids this
 * runtime resolves Qwen to is on the list today, so a Qwen tier run caches
 * nothing until either the list or the map moves. That is a fact to measure
 * (the fixed-prompt trace reads the cache counters by invocation id), not one
 * to paper over with a broader regex.
 *
 * Maintained by re-reading the page. The exclusion rule below is the page's
 * own: a dated snapshot endpoint never caches explicitly, whatever family.
 */
export const ALIBABA_EXPLICIT_CACHE_MODELS: ReadonlySet<string> = new Set([
  'deepseek/deepseek-v3.2',
  'qwen/qwen3-max',
  'qwen/qwen-plus',
  'qwen/qwen3.6-plus',
  'qwen/qwen3-coder-plus',
  'qwen/qwen3-coder-flash',
]);

/** A snapshot endpoint — an id pinned to a release date (`-02-15`, `-0902`).
 *  The page names the shape by example; the suffix is how every listed
 *  snapshot spells it. */
export function isSnapshotEndpoint(model: string): boolean {
  return /-\d{2}-\d{2}$|-\d{4}$/.test(model);
}

/** Whether this model gets explicit cache breakpoints: on the vendor's list,
 *  and not a snapshot. Matched on the id rather than on the resolved provider,
 *  because a listed model reached through the `openrouter` provider needs them
 *  just as much — the requirement is Alibaba's, not ours. */
export function needsExplicitCacheBreakpoints(model: string): boolean {
  return ALIBABA_EXPLICIT_CACHE_MODELS.has(model) && !isSnapshotEndpoint(model);
}
