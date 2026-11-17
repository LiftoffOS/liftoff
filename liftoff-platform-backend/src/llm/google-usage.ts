// Google's billable token arithmetic, in ONE place.
//
// Two components in this repo price the same vendor: `llm/providers/google.ts`,
// which calls Vertex directly, and `byok-gateway/vendor-adapters.ts`, which reads
// a Vertex response off the wire on behalf of a subprocess engine. They must agree
// about what Google charges for, and they did not — the gateway read three of the
// four counts and under-billed every tool-using turn while the provider read all
// four. Two implementations of one vendor's arithmetic is how one of them stays
// wrong.
//
// Its own module rather than an export of the provider, because the gateway
// adapter cannot import the provider: `providers/google.ts` pulls in the Vertex
// SDK and already imports `byok-gateway/headers`, so the edge would drag the SDK
// across a boundary that exists to stay thin. Nothing here imports anything.

/**
 * Google's usage metadata, to the extent billing depends on it.
 *
 * FOUR COUNTS, AND NONE OF THEM CONTAINS ANOTHER. The SDK states the arithmetic
 * itself on `totalTokenCount`: prompt + candidates + toolUsePrompt + thoughts. So
 * each of the two obvious fields is short of what is billed, and the identity
 * `input + output === totalTokenCount` is the only check that catches an omission
 * of any of them rather than of the one somebody thought of.
 *
 * `cachedContentTokenCount` is deliberately absent: it is a SUBSET of
 * `promptTokenCount` (the whole prompt, cached part included), so adding it would
 * double-count the cached portion and break the identity.
 */
export interface GoogleUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  toolUsePromptTokenCount?: number;
}

/**
 * A count, or zero.
 *
 * Guarded rather than `|| 0`, because one of the two callers reads this off the
 * WIRE. A JSON body can carry a string where a number belongs, and `"5" || 0` is
 * `"5"` — which then makes `+` concatenate instead of add, turning two counts into
 * a nonsense figure that still looks like a number downstream. The provider's own
 * SDK-typed input never needs this; the gateway's always might.
 */
function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** What Google bills as INPUT: the prompt plus the tool results fed back in.
 *
 *  `toolUsePromptTokenCount` is not inside `promptTokenCount`, so reading the
 *  prompt alone under-counts every turn that used a tool — which on the gemini-cli
 *  engine is nearly every turn, since its only tools arrive over the governed MCP
 *  proxy. */
export function googleInputTokens(u: GoogleUsageMetadata | Record<string, unknown>): number {
  return count((u as GoogleUsageMetadata).promptTokenCount)
    + count((u as GoogleUsageMetadata).toolUsePromptTokenCount);
}

/** What Google bills as OUTPUT: the answer plus the thinking that produced it.
 *
 *  `thoughtsTokenCount` is charged at the completion rate and reported in its own
 *  field, so reading `candidatesTokenCount` alone pays for the visible answer and
 *  nothing for the reasoning — most of the call on a Gemini 3 model. */
export function googleOutputTokens(u: GoogleUsageMetadata | Record<string, unknown>): number {
  return count((u as GoogleUsageMetadata).candidatesTokenCount)
    + count((u as GoogleUsageMetadata).thoughtsTokenCount);
}
