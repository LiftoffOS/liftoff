// Claude's hosted WebSearch is counted, so it can be billed.
//
// Anthropic charges $10 per 1,000 searches — the dearest hosted search of any
// vendor we run — and `WebSearch` is attached default-on to EVERY Claude agent
// (native-web-tools.ts). Claude is the estate's default provider, so this was
// the largest unbilled tool spend we had, and it was unbilled for the most
// ordinary reason: the count sat in `usage.server_tool_use.web_search_requests`
// and nothing read it.
//
// A rate without a count changes nothing. That is not a hypothetical caution —
// the xAI rate landed first and billed zero for three deploys, because the
// count was dropped somewhere else. So this asserts the COUNT, at the point the
// adapter turns a vendor message into a usage event.

// The Claude Agent SDK is ESM-only and jest cannot parse it; the adapter only
// needs to be constructible here, since the seam under test is pure translation.
jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  AbortError: class AbortError extends Error {},
  query: jest.fn(() => {
    const it = (async function* () { /* no messages */ })();
    return Object.assign(it, { interrupt: jest.fn(), setPermissionMode: jest.fn() });
  }),
}));

import { AnthropicAdapter } from '../anthropic';
import type { InvocationEvent } from '../types';

/** Reach the private translator: this is the seam between the vendor's message
 *  and our usage event, and it is the whole of what this test is about. */
function usageFrom(resultMessage: unknown): Extract<InvocationEvent, { type: 'usage' }> | undefined {
  const adapter = new AnthropicAdapter();
  const translate = (adapter as unknown as {
    translateSDKMessage(m: unknown): InvocationEvent[];
  }).translateSDKMessage.bind(adapter);
  const events = translate(resultMessage);
  return events.find((e) => e.type === 'usage') as
    Extract<InvocationEvent, { type: 'usage' }> | undefined;
}

const baseUsage = {
  input_tokens: 1000,
  output_tokens: 200,
  cache_read_input_tokens: 300,
};

it('carries the hosted search count off the vendors own usage block', () => {
  const usage = usageFrom({
    type: 'result',
    subtype: 'success',
    usage: { ...baseUsage, server_tool_use: { web_search_requests: 3, web_fetch_requests: 5 } },
  });
  expect(usage?.usage.webSearchRequests).toBe(3);
  // Tokens are unaffected — the search count rides alongside them, it does not
  // replace or adjust them.
  expect(usage?.usage).toMatchObject({ inputTokens: 1000, outputTokens: 200, cachedTokens: 300 });
});

it('does NOT bill web fetch, which Anthropic provides at no additional cost', () => {
  // Its expense is the tokens it pulls into context, already counted above.
  // Giving it a per-call count would invent a charge the vendor does not make.
  const usage = usageFrom({
    type: 'result',
    subtype: 'success',
    usage: { ...baseUsage, server_tool_use: { web_search_requests: 0, web_fetch_requests: 9 } },
  });
  expect(usage?.usage.webSearchRequests).toBeUndefined();
});

it('omits the count entirely when no search ran', () => {
  // Absent rather than 0, matching every other adapter: the grounding-cost
  // reducer treats both the same, and an absent field says "no hosted search"
  // rather than "a search that cost nothing".
  const usage = usageFrom({ type: 'result', subtype: 'success', usage: baseUsage });
  expect(usage?.usage.webSearchRequests).toBeUndefined();
});
