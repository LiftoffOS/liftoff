/**
 * limits-config (A4b) — verifies the _value suffix encoding, defaults
 * fallback, and the 10s in-memory cache.
 */

const mockGetFeatureFlags = jest.fn();
jest.mock('../../../entitlements-client/service', () => ({
  getEntitlementsClient: () => ({ getFeatureFlags: mockGetFeatureFlags }),
}));

import { _resetFlagsCache, getVendorConcurrencyLimits, getVendorRatePerHour } from '../limits-config';

beforeEach(() => {
  mockGetFeatureFlags.mockReset();
  _resetFlagsCache();
});

describe('limits-config — concurrency', () => {
  it('returns the default when no flag is set', async () => {
    mockGetFeatureFlags.mockResolvedValueOnce({});
    const limits = await getVendorConcurrencyLimits('anchor');
    expect(limits.maxConcurrentGlobal).toBe(25);
  });

  it('reads override from the `<key>_value` suffix', async () => {
    mockGetFeatureFlags.mockResolvedValueOnce({
      web_fetch_anchor_max_concurrent_global: true,
      web_fetch_anchor_max_concurrent_global_value: 30,
    });
    const limits = await getVendorConcurrencyLimits('anchor');
    expect(limits.maxConcurrentGlobal).toBe(30);
  });

  it('ignores non-numeric and non-positive `_value` overrides', async () => {
    mockGetFeatureFlags.mockResolvedValueOnce({ web_fetch_anchor_max_concurrent_global_value: 'oops' });
    const a = await getVendorConcurrencyLimits('anchor');
    expect(a.maxConcurrentGlobal).toBe(25);

    _resetFlagsCache();
    mockGetFeatureFlags.mockResolvedValueOnce({ web_fetch_anchor_max_concurrent_global_value: -1 });
    const b = await getVendorConcurrencyLimits('anchor');
    expect(b.maxConcurrentGlobal).toBe(25);
  });
});

describe('limits-config — firecrawl', () => {
  it('returns the Free-plan default of 2 when no flag is set', async () => {
    mockGetFeatureFlags.mockResolvedValueOnce({});
    const limits = await getVendorConcurrencyLimits('firecrawl');
    expect(limits.maxConcurrentGlobal).toBe(2);
  });

  it('lets a sentinel `_value` flag raise firecrawl global concurrency for plan upgrades', async () => {
    mockGetFeatureFlags.mockResolvedValueOnce({
      web_fetch_firecrawl_max_concurrent_global: true,
      web_fetch_firecrawl_max_concurrent_global_value: 5,
    });
    const limits = await getVendorConcurrencyLimits('firecrawl');
    expect(limits.maxConcurrentGlobal).toBe(5);
  });

  it('returns the firecrawl rate-per-hour default for web_fetch_advanced (100)', async () => {
    mockGetFeatureFlags.mockResolvedValueOnce({});
    expect(await getVendorRatePerHour('firecrawl', 'web_fetch_advanced')).toBe(100);
  });

  it('lets `_value` override the firecrawl rate-per-hour', async () => {
    mockGetFeatureFlags.mockResolvedValueOnce({
      web_fetch_firecrawl_rate_per_hour_web_fetch_advanced_value: 200,
    });
    expect(await getVendorRatePerHour('firecrawl', 'web_fetch_advanced')).toBe(200);
  });
});

describe('limits-config — rate per hour', () => {
  it('returns DEFAULTS for a configured tool when no flag is set', async () => {
    mockGetFeatureFlags.mockResolvedValueOnce({});
    expect(await getVendorRatePerHour('webclaw', 'web_fetch_advanced')).toBe(200);
  });

  it('returns undefined for a tool not in the defaults map and not flag-set', async () => {
    mockGetFeatureFlags.mockResolvedValueOnce({});
    expect(await getVendorRatePerHour('webclaw', 'never_heard_of_it')).toBeUndefined();
  });

  it('flag override at `_value` suffix wins over the default', async () => {
    mockGetFeatureFlags.mockResolvedValueOnce({
      web_fetch_webclaw_rate_per_hour_web_fetch_advanced_value: 500,
    });
    expect(await getVendorRatePerHour('webclaw', 'web_fetch_advanced')).toBe(500);
  });
});

describe('limits-config — perplexity', () => {
  test('returns default global=50 when no override flag', async () => {
    mockGetFeatureFlags.mockResolvedValueOnce({});
    const limits = await getVendorConcurrencyLimits('perplexity');
    expect(limits.maxConcurrentGlobal).toBe(50);
  });

  test('respects _value sentinel override on global', async () => {
    mockGetFeatureFlags.mockResolvedValueOnce({
      web_fetch_perplexity_max_concurrent_global:        true,
      web_fetch_perplexity_max_concurrent_global_value:  25,
    });
    const limits = await getVendorConcurrencyLimits('perplexity');
    expect(limits.maxConcurrentGlobal).toBe(25);
  });

  // Both of these used to assert 180,000 — the /search endpoint's figure, on
  // two tools that POST /v1/agent, whose measured ceiling is one request a
  // second. The Agent API's budget is asserted in full, including that the four
  // tools on it SHARE it, in `agent-api-shares-one-budget.test.ts`.
  test('returns the Agent-API rate-per-hour for web_people_search', async () => {
    mockGetFeatureFlags.mockResolvedValueOnce({});
    expect(await getVendorRatePerHour('perplexity', 'web_people_search')).toBe(3_600);
  });

  test('returns the Agent-API rate-per-hour for web_finance_search', async () => {
    mockGetFeatureFlags.mockResolvedValueOnce({});
    expect(await getVendorRatePerHour('perplexity', 'web_finance_search')).toBe(3_600);
  });

  test('returns default rate-per-hour for web_deep_research (Tier 0 = 5 RPM = 300/hr)', async () => {
    mockGetFeatureFlags.mockResolvedValueOnce({});
    expect(await getVendorRatePerHour('perplexity', 'web_deep_research')).toBe(300);
  });

  test('respects _value sentinel override on web_deep_research (tier upgrade path)', async () => {
    mockGetFeatureFlags.mockResolvedValueOnce({
      web_fetch_perplexity_rate_per_hour_web_deep_research:        true,
      web_fetch_perplexity_rate_per_hour_web_deep_research_value:  6_000,  // Tier 5 = 100 RPM
    });
    expect(await getVendorRatePerHour('perplexity', 'web_deep_research')).toBe(6_000);
  });

  test('respects _value sentinel override on rate-per-hour for web_research', async () => {
    mockGetFeatureFlags.mockResolvedValueOnce({
      web_fetch_perplexity_rate_per_hour_web_research:        true,
      web_fetch_perplexity_rate_per_hour_web_research_value:  10_000,
    });
    expect(await getVendorRatePerHour('perplexity', 'web_research')).toBe(10_000);
  });
});

describe('limits-config — 10s in-memory cache', () => {
  it('only hits the entitlements client once across two reads within the TTL', async () => {
    mockGetFeatureFlags.mockResolvedValue({});
    await getVendorConcurrencyLimits('anchor');
    await getVendorConcurrencyLimits('webclaw');
    await getVendorRatePerHour('anchor', 'web_task');
    expect(mockGetFeatureFlags).toHaveBeenCalledTimes(1);
  });
});
