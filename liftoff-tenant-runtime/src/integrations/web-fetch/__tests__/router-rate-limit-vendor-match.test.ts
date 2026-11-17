/**
 * Gap #1 regression: when the first-choice vendor is unhealthy and the chain
 * escalates to the next vendor, the rate-limit token MUST be charged against
 * the actually-chosen vendor, NOT the first choice.
 *
 * Pre-fix code consumed the bucket at handler-dispatch time using the
 * tenant+tool key, debiting whichever vendor "owned" that key (often
 * whichever was the first chain entry). After the fix, consumeToken is
 * invoked inside runChain against `v` (the vendor we just admitted), so
 * fallback paths debit the bucket of the vendor that actually ran the work.
 */

const mockGetAllVendorFlags = jest.fn();
const mockAcquireInflightSlot = jest.fn();
const mockConsumeToken = jest.fn();

jest.mock('../global-flags', () => ({
  getAllVendorFlags: (...a: unknown[]) => mockGetAllVendorFlags(...a),
  isVendorEnabled:   jest.fn(),
  isVendorExcludedForTenant: jest.fn().mockResolvedValue(false),
  isEffortRoutingEnabled: jest.fn().mockResolvedValue(false),
}));
jest.mock('../concurrency-limits', () => {
  class VendorPoolBusy extends Error {
    constructor(public vendor: string, public retryAfterMs: number) { super(`busy:${vendor}`); }
  }
  return {
    acquireInflightSlot: (...a: unknown[]) => mockAcquireInflightSlot(...a),
    VendorPoolBusy,
  };
});
jest.mock('../token-bucket', () => ({
  consumeToken: (...a: unknown[]) => mockConsumeToken(...a),
}));
jest.mock('../../../infrastructure/database', () => ({
  getPool: () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }),
}));
jest.mock('../../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// vendorAvailable() gates BYOK vendors on per-tenant connector presence.
// Stub the resolver so every BYOK vendor reads as connected — this test
// asserts the rate-limit bucket selection for the perplexity → exa fallback.
jest.mock('../web-tool-secrets', () => {
  const actual = jest.requireActual('../web-tool-secrets');
  return {
    ...actual,
    getTenantConnectedWebVendors: jest.fn().mockResolvedValue(
      new Set(['firecrawl', 'anchor_browser', 'browserbase', 'tavily', 'exa', 'webclaw']),
    ),
  };
});

// The chain tests assume the team is BOUND to every vendor the workspace
// connected, so the scope is the connected set. The binding read itself is
// covered by vendor-scope.test.ts and router-vendor-scope.test.ts.
jest.mock('../vendor-scope', () => ({
  usableWebVendors: jest.fn(async (tenantId: string, _agentId: string | undefined, pre?: Set<string>) => {
    const { getTenantConnectedWebVendors } = jest.requireMock('../web-tool-secrets');
    const vendors = pre ?? await getTenantConnectedWebVendors(tenantId);
    return { vendors, connectorIds: new Map(), excluded: [], basis: 'bound' };
  }),
  logExcludedVendors: jest.fn(),
}));

import { WebFetchRouter, VendorHealthCache } from '../router';
import type { WebFetchAdvancedRequest } from '../types';

const ctx = { tenantId: 't1', agentId: 'a1', traceId: 'trace1' };

beforeEach(() => {
  jest.clearAllMocks();
  mockGetAllVendorFlags.mockResolvedValue({ webclaw: true, firecrawl: true, perplexity: true, anchor: true, browserbase: true, tavily: true, exa: true, openai: true, google: true });
  mockAcquireInflightSlot.mockResolvedValue({ requestId: 'rid', release: jest.fn().mockResolvedValue(undefined) });
  mockConsumeToken.mockResolvedValue({ ok: true });
});

const fakeResult = (v: 'webclaw' | 'firecrawl' | 'perplexity' | 'anchor' | 'browserbase' | 'tavily' | 'exa') => ({
  content: '', finalUrl: '', sessionId: undefined, vendor: v, costMicros: 0, jsRendered: false,
});

it('charges the rate-limit bucket of the actually-admitted vendor, not the first-choice vendor', async () => {
  const webclaw = { vendor: 'webclaw', fetch: jest.fn().mockResolvedValue(fakeResult('webclaw')), supportsSessions: () => false } as any;
  // Under this file's bound-to-everything fixture the team's own Exa leads
  // the no-JS chain and Tavily is position 2 (vendor-order.ts). Fail exa so
  // we exercise the exa → tavily fallback path.
  const perplexity = { vendor: 'perplexity', fetch: jest.fn().mockResolvedValue(fakeResult('perplexity')), supportsSessions: () => false } as any;
  const firecrawl = { vendor: 'firecrawl', fetch: jest.fn().mockResolvedValue(fakeResult('firecrawl')), supportsSessions: () => false } as any;
  const anchor = { vendor: 'anchor', fetch: jest.fn().mockResolvedValue(fakeResult('anchor')), supportsSessions: () => true } as any;
  const browserbase = { vendor: 'browserbase', fetch: jest.fn().mockResolvedValue(fakeResult('browserbase')), supportsSessions: () => true } as any;
  const tavily = { vendor: 'tavily', fetch: jest.fn().mockResolvedValue(fakeResult('tavily')), supportsSessions: () => false } as any;
  const exa = { vendor: 'exa', fetch: jest.fn().mockRejectedValue(new Error('exa down')), supportsSessions: () => false } as any;
  const openai = { vendor: 'openai', fetch: jest.fn().mockRejectedValue(new Error('n/a')), supportsSessions: () => false } as any;
  const google = { vendor: 'google', fetch: jest.fn().mockRejectedValue(new Error('n/a')), supportsSessions: () => false } as any;
  const router = new WebFetchRouter(webclaw, firecrawl, perplexity, anchor, browserbase, tavily, exa, openai, google, new VendorHealthCache());

  await router.fetch({ url: 'https://x' } as WebFetchAdvancedRequest, ctx);

  // Two admissions: one for exa (which then errored) and one for tavily.
  expect(mockAcquireInflightSlot).toHaveBeenCalledTimes(2);
  // Both consumeToken calls were against the vendor that was admitted at that
  // attempt — NOT a single bucket key pinned to the chain head.
  expect(mockConsumeToken).toHaveBeenCalledTimes(2);
  expect(mockConsumeToken.mock.calls[0][1]).toBe('exa');      // chain head (failed)
  expect(mockConsumeToken.mock.calls[1][1]).toBe('tavily');   // 2nd position (succeeded)
});
