/**
 * Tools that share a vendor endpoint share its ceiling.
 *
 * `limits-config` gave `web_finance_search` and `web_people_search` 180,000 an
 * hour — "50 RPS sustained * 3600", which is the `/search` endpoint's figure.
 * Both of them, plus `web_fetch_advanced` and `web_research`, POST `/v1/agent`,
 * whose measured ceiling on the platform key is ONE request a second. Four
 * independent budgets were spent against one real one, so a run's fetch calls
 * starved its finance call out of the shared second while succeeding
 * themselves, one second apart in the same trace.
 *
 * `web_deep_research` in the same literal carried `300` under the comment
 * `Tier 0 = 5 RPM`, so the tier limit was known — and applied to one of the
 * tools that needed it.
 *
 * The endpoint map lives in a comment at the top of perplexity-client.ts. This
 * test is the enforcement of it, so a new Agent-API tool cannot be added with
 * the search endpoint's number again.
 */
import { rateBudgetFor, PERPLEXITY_AGENT_BUDGET, getVendorRatePerHour, _resetFlagsCache } from '../limits-config';

const getFeatureFlags = jest.fn();
jest.mock('../../../entitlements-client/service', () => ({
  getEntitlementsClient: () => ({ getFeatureFlags }),
}));
jest.mock('../../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

/** The web tools Perplexity serves from POST /v1/agent. */
const AGENT_API_TOOLS = ['web_fetch_advanced', 'web_research', 'web_people_search', 'web_finance_search'];
/** Perplexity tools on their OWN endpoint, which must NOT join that budget. */
const OWN_ENDPOINT_TOOLS = {
  web_search: 'POST /search',
  web_deep_research: 'POST /async/chat/completions',
};

beforeEach(() => {
  _resetFlagsCache();
  getFeatureFlags.mockResolvedValue({});
});

describe("Perplexity's Agent API is one budget", () => {
  it.each(AGENT_API_TOOLS)('%s spends from the shared Agent-API budget', (tool) => {
    expect(rateBudgetFor('perplexity', tool)).toBe(PERPLEXITY_AGENT_BUDGET);
  });

  it.each(Object.entries(OWN_ENDPOINT_TOOLS))('%s is %s, so it keeps its own budget', (tool) => {
    expect(rateBudgetFor('perplexity', tool)).toBe(tool);
  });

  it('every Agent-API tool resolves to the SAME hourly figure', async () => {
    const rates = await Promise.all(AGENT_API_TOOLS.map((t) => getVendorRatePerHour('perplexity', t)));
    expect(new Set(rates).size).toBe(1);
    // One request a second, measured off x-ratelimit-limit on the live key.
    expect(rates[0]).toBe(3_600);
  });

  it('no Agent-API tool carries the /search endpoint figure', async () => {
    for (const tool of AGENT_API_TOOLS) {
      expect(await getVendorRatePerHour('perplexity', tool)).not.toBe(180_000);
    }
  });

  it('web_search keeps the /search figure', async () => {
    expect(await getVendorRatePerHour('perplexity', 'web_search')).toBe(180_000);
  });
});

describe('an operator can raise the real ceiling', () => {
  it("the budget's own flag raises every tool that spends from it", async () => {
    getFeatureFlags.mockResolvedValue({ [`web_fetch_perplexity_rate_per_hour_${PERPLEXITY_AGENT_BUDGET}_value`]: 18_000 });
    for (const tool of AGENT_API_TOOLS) {
      expect(await getVendorRatePerHour('perplexity', tool)).toBe(18_000);
    }
  });

  it('a flag set on the tool name before the budget existed still works', async () => {
    getFeatureFlags.mockResolvedValue({ web_fetch_perplexity_rate_per_hour_web_finance_search_value: 7_200 });
    expect(await getVendorRatePerHour('perplexity', 'web_finance_search')).toBe(7_200);
    // ...and does not leak onto the tools that did not set it.
    expect(await getVendorRatePerHour('perplexity', 'web_research')).toBe(3_600);
  });

  it("the budget's flag wins over a tool's, because it is the ceiling the vendor enforces", async () => {
    getFeatureFlags.mockResolvedValue({
      [`web_fetch_perplexity_rate_per_hour_${PERPLEXITY_AGENT_BUDGET}_value`]: 3_600,
      web_fetch_perplexity_rate_per_hour_web_finance_search_value: 180_000,
    });
    expect(await getVendorRatePerHour('perplexity', 'web_finance_search')).toBe(3_600);
  });
});

describe('every other vendor is unchanged', () => {
  it.each([
    ['exa', 'web_fetch_advanced'],
    ['tavily', 'web_research'],
    ['webclaw', 'web_fetch_advanced'],
    ['anchor', 'web_task'],
  ] as const)('%s / %s spends from a budget of its own name', (vendor, tool) => {
    expect(rateBudgetFor(vendor, tool)).toBe(tool);
  });
});
