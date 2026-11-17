// The order the web tools try their vendors in, and why.
//
// One rule, two tiers:
//
//   A vendor the team is BOUND to belongs to a higher tier than a platform-
//   provided one. Within a tier the order is fitness for the tool, then cost.
//   The platform tier is the safety net, never the first choice over an
//   account the person gave the team.
//
// The fetch and research chains used to put the platform's Perplexity first
// "because it is platform-managed and always on". That fit a connected vendor
// being a workspace-level extra backend nobody had chosen. A vendor in a chain
// is now there because the team is bound to it (vendor-scope.ts), which is a
// choice: the person pays that account directly, a platform call is metered
// against their Operating Units, and the account they gave the team would sit
// unused unless the platform backend failed. The browser session picker
// applies the same rule; this file makes the fetch and research chains agree with it, from
// one table.
//
// The within-tier orders are unchanged from what the chains did before —
// cheap text vendors ahead of browsers unless the page needs JS, Exa ahead of
// Tavily on the published per-page rate and its exact-cost capture, the
// browser preference Anchor > Browserbase > Steel > Browser Use — so a re-tier
// is the only change. Steel and Browser Use appear in BOTH tiers: the
// workspace's own connector when the team is bound to it, the platform key
// otherwise (PLATFORM_FUNDED_FALLBACK, and credential-scope's
// NO_WORKSPACE_CONNECTOR on that path).
//
// The attempt budget lives in router.ts (runChain): at most two vendors per
// call, with the platform tier's first vendor always reachable — so a team
// with two bound accounts that both fail still gets the safety net.

import type { VendorFlags } from './global-flags';
import type { WebVendor } from './types';
import type { WebToolVendor } from './web-tool-secrets';
import type { WebVendorScope } from './vendor-scope';

/** Map runtime vendor name → connector type, or null for platform-managed. */
export const CONNECTOR_TYPE_OF: Record<WebVendor, WebToolVendor | null> = {
  webclaw: 'webclaw', firecrawl: 'firecrawl',
  anchor: 'anchor_browser', browserbase: 'browserbase',
  tavily: 'tavily', exa: 'exa', browser_use: 'browser_use', steel: 'steel',
  // Platform-managed: no connector, because a customer cannot hold a key for
  // our account. xAI joins these — web_x_search runs on the platform's own xAI
  // credential, the same one managed Grok uses. browserbase_x402 has no key
  // at all: connector-service pays each call from the platform x402 wallet.
  perplexity: null, openai: null, google: null, xai: null, browserbase_x402: null,
  // locus_web and locus_exa run on the platform's Locus key: no connector,
  // no customer key.
  locus_web: null, locus_exa: null,
};

/** Vendors that have a connector AND a platform key, so the connector is an
 *  upgrade rather than the thing that switches them on. Tavily and Exa are
 *  here because the platform's keys for both are pay-as-you-go, so a team
 *  bound to neither reads and researches on our key at the vendor's real
 *  charge, metered against its Operating Units (funding 'platform').
 *
 *  Not in the null group above because the distinction still matters
 *  everywhere else: a workspace bound to its own connector uses its own key
 *  and pays the vendor directly, and the resolver has to keep preferring
 *  that. What changes here is only availability — a team with no binding can
 *  still reach the vendor, on our key.
 *
 *  Leaving browser_use out once made the fetch chain the one place that could
 *  not see the platform browser: the pane could spawn a Browser Use session
 *  while web_fetch_advanced skipped the vendor entirely, so an escalation
 *  from a blocked page had one fewer backend than the product had paid for. */
export const PLATFORM_FUNDED_FALLBACK: ReadonlySet<WebVendor> = new Set<WebVendor>(['browser_use', 'steel', 'tavily', 'exa']);

/** A vendor is available to a RUN iff the operator has not pulled its
 *  kill-switch, AND it is platform-managed, or the team is bound to the
 *  workspace's connector for it, or the platform funds it when it is not. */
export function vendorAvailable(v: WebVendor, flags: VendorFlags, usable: ReadonlySet<WebToolVendor>): boolean {
  if (!flags[v]) return false;
  const ct = CONNECTOR_TYPE_OF[v];
  if (ct === null) return true;
  return usable.has(ct) || PLATFORM_FUNDED_FALLBACK.has(v);
}

export type VendorTier = 'bound' | 'platform';

/** Which tier a vendor serves a run from: bound when the team is bound to the
 *  workspace's connector for it; platform otherwise (a platform-managed
 *  vendor, or a platform-funded one the team is not bound to). */
export function tierOf(v: WebVendor, scope: WebVendorScope): VendorTier {
  const ct = CONNECTOR_TYPE_OF[v];
  return ct !== null && scope.vendors.has(ct) ? 'bound' : 'platform';
}

/** The browser vendors, by capability preference: Anchor > Browserbase >
 *  Steel > Browser Use (Steel ahead of Browser Use because it is the
 *  platform's browser and Browser Use the fallback). The one
 *  list the session picker and the JS fetch chain both read. */
export const BROWSER_VENDOR_ORDER: readonly WebVendor[] = ['anchor', 'browserbase', 'steel', 'browser_use'];

/** The text vendors for reading a page, by cost: Exa ($0.001/page, exact
 *  cost from the response) ahead of Tavily (~$0.0016/page, flat credit
 *  constant), then the credit-priced Firecrawl and WebClaw. */
export const FETCH_TEXT_ORDER: readonly WebVendor[] = ['exa', 'tavily', 'firecrawl', 'webclaw'];

/** The text vendors for research, by cost per typical call: Exa /answer
 *  ($0.007, exact cost), Tavily /search (1 credit ≈ $0.008), then WebClaw and
 *  Firecrawl as credit-priced fallbacks. */
export const RESEARCH_TEXT_ORDER: readonly WebVendor[] = ['exa', 'tavily', 'webclaw', 'firecrawl'];

/** The platform tier's text reads, by cost: Perplexity's fetch_url first (the
 *  cheap, always-on read), then the platform's pay-as-you-go Exa ($0.001 a
 *  page), then the same read on Exa's x402 API through the platform's Locus
 *  key — the overflow for when the Exa key is at its ten-queries-a-second
 *  cap, which is why it sits directly behind it — then Tavily (~$0.0016).
 *  None renders JavaScript. */
export const PLATFORM_FETCH_TEXT_ORDER: readonly WebVendor[] = ['perplexity', 'exa', 'locus_exa', 'tavily'];

/** The platform tier's JavaScript-rendering reads, by cost: the pay-per-use
 *  scrape on the platform's Locus key ($0.003 a page, a headless browser
 *  behind it) ahead of the platform browsers in preference order. */
export const PLATFORM_FETCH_JS_ORDER: readonly WebVendor[] = ['locus_web', 'steel', 'browser_use'];

/** The platform tier for reading a page, assembled the way the bound tier is:
 *  text reads then the rendering reads, or the reverse when the page needs
 *  JavaScript — the attempt budget is two vendors, so a rendering read must
 *  be reachable within it. The pay-per-call x402 gateway is last either way:
 *  it runs only when the vendors ahead of it are unavailable or marked
 *  unhealthy. A fallback, never a competitor. */
export function platformFetchOrder(needsJs: boolean): WebVendor[] {
  return needsJs
    ? [...PLATFORM_FETCH_JS_ORDER, ...PLATFORM_FETCH_TEXT_ORDER, 'browserbase_x402']
    : [...PLATFORM_FETCH_TEXT_ORDER, ...PLATFORM_FETCH_JS_ORDER, 'browserbase_x402'];
}

/** The platform tier for extraction: the pay-per-use extract on the
 *  platform's Locus key. It is the ONLY platform extract backend, which is
 *  what makes web_extract a tool every agent has rather than a BYOK-only one. */
export const PLATFORM_EXTRACT_ORDER: readonly WebVendor[] = ['locus_web'];

/** The platform tier for basic search, by cost: Perplexity's search ($0.005),
 *  the pay-per-use search on the platform's Locus key (under a cent), the
 *  x402 gateway last. */
export const PLATFORM_SEARCH_ORDER: readonly WebVendor[] = ['perplexity', 'locus_web', 'browserbase_x402'];

/** The platform tier for research: Perplexity first (several sources read and
 *  one cited answer, the fittest), then the platform's pay-as-you-go Exa
 *  /answer, its overflow on Exa's x402 API through the Locus key, and Tavily
 *  /search as the safety net behind them. */
export const PLATFORM_RESEARCH_ORDER: readonly WebVendor[] = ['perplexity', 'exa', 'locus_exa', 'tavily'];

export interface VendorHealth { isHealthy(vendor: WebVendor): boolean }

/** The fetch chain for one call: the team's own accounts first (text vendors
 *  ahead of browsers unless the page needs JS, in which case the browsers
 *  lead and the text vendors are the Hail Mary), then the platform tier. Each
 *  vendor once, in the first position it earns. */
export function orderFetchChain(
  needsJs: boolean,
  flags: VendorFlags,
  scope: WebVendorScope,
  health: VendorHealth,
): WebVendor[] {
  const boundText = FETCH_TEXT_ORDER.filter((v) => tierOf(v, scope) === 'bound');
  const boundBrowsers = BROWSER_VENDOR_ORDER.filter((v) => tierOf(v, scope) === 'bound');
  const bound = needsJs ? [...boundBrowsers, ...boundText] : [...boundText, ...boundBrowsers];
  const platform = platformFetchOrder(needsJs).filter((v) => tierOf(v, scope) === 'platform');
  return [...bound, ...platform].filter((v) => vendorAvailable(v, flags, scope.vendors) && health.isHealthy(v));
}

/** The research chain for one call: the team's own accounts by cost, then
 *  Perplexity — the Agent API's web_search, several sources read and one cited
 *  answer written, exact cost from the response. */
export function orderResearchChain(
  flags: VendorFlags,
  scope: WebVendorScope,
  health: VendorHealth,
): WebVendor[] {
  const bound = RESEARCH_TEXT_ORDER.filter((v) => tierOf(v, scope) === 'bound');
  const platform = PLATFORM_RESEARCH_ORDER.filter((v) => tierOf(v, scope) === 'platform');
  return [...bound, ...platform]
    .filter((v) => vendorAvailable(v, flags, scope.vendors) && health.isHealthy(v));
}
