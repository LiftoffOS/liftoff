// The web tools a platform assistant gets.
//
// Liftoff, the Insights Manager and the Chief AI Officer are PB-native: they
// have no internal_agents row and no tenant runtime, so none of the tenant
// runtime's tool catalogue reaches them. Until now that left them with no way
// to look at a web page at all — a person asking one of them to check a URL got
// "I cannot check live web pages", which was TRUE rather than a hallucination,
// and true only because nobody had handed them the tools.
//
// These are the provider's own SERVER-side tools, not tools this process runs.
// The model calls them, the vendor executes them, and the results arrive as
// content blocks in the same response — so there is no loop to write here and
// no egress from this service. `serverTools` has been a first-class field on
// LLMCompletionRequest all along, and every provider already merges it
// (toAnthropicTools for Anthropic and Vertex, the grounding/urlContext pair for
// Google). It simply had no caller.
//
// Deliberately NOT the tenant runtime's browser tools. Those (web_task,
// run_browser_task, the Anchor session tools) are BYOK-exclusive and gated on a
// PER-AGENT binding — see integrations/web-fetch/expose-tools.ts in the tenant
// runtime. A platform assistant has no agent row to carry a binding and no
// browser session to drive, so there is nothing here to switch on. Reaching
// them is a separate piece of work, not a longer list.
// The value lives in @liftoffos/shared-types because the Chief AI Officer runs
// in another repository and needs the identical list. Re-exported here so this
// file stays the place a reader looks for the rationale above.
export { WEB_SERVER_TOOLS } from '@liftoffos/shared-types';
