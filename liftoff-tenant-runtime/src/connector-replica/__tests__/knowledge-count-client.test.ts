// The knowledge count, cached.
//
// Read while a prompt is being assembled, so it must never add a network hop.
// And unknown must never render as zero: an agent told its knowledge base is
// empty reports that to a person with the same confidence it reports anything
// else.

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../../infrastructure/logging', () => ({ logger: mockLogger }));

const mockFetch = jest.fn();
let clientPresent = true;
jest.mock('../../platform-callback/client', () => ({
  getPlatformCallbackClient: () => (clientPresent ? { fetch: mockFetch } : null),
}));

import {
  _resetKnowledgeCountCacheForTesting,
  getCachedKnowledgeItemCount,
} from '../knowledge-count-client';

const TENANT = 'tenant-1';

/** The refresh is deliberately not awaited by the caller, so tests have to let
 *  the microtask queue drain before asserting on its effect. */
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  jest.clearAllMocks();
  _resetKnowledgeCountCacheForTesting();
  clientPresent = true;
  mockFetch.mockResolvedValue({ ok: true, json: async () => ({ count: 42 }) });
});

describe('never blocks the prompt build', () => {
  it('returns immediately on the first call, before the fetch resolves', () => {
    // Synchronous by design: a network round trip on every prompt build is a
    // per-turn latency cost paid for a number that changes hourly.
    expect(getCachedKnowledgeItemCount(TENANT)).toBeNull();
  });

  it('serves the real number once the background fetch lands', async () => {
    getCachedKnowledgeItemCount(TENANT);
    await settle();
    expect(getCachedKnowledgeItemCount(TENANT)).toBe(42);
  });

  it('asks for the TENANT-WIDE count, not a binding-scoped one', async () => {
    // The landscape describes what the workspace has. Scoping to one agent's
    // bindings would report a smaller number and present it as the total.
    getCachedKnowledgeItemCount(TENANT);
    await settle();
    const body = JSON.parse(mockFetch.mock.calls[0][2].body as string);
    expect(body).toMatchObject({ tenantId: TENANT, tenantWide: true });
  });

  it('does not refetch within the cache window', async () => {
    getCachedKnowledgeItemCount(TENANT);
    await settle();
    getCachedKnowledgeItemCount(TENANT);
    getCachedKnowledgeItemCount(TENANT);
    await settle();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe('unknown is not zero', () => {
  it('stays null when the control plane errors', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 });
    getCachedKnowledgeItemCount(TENANT);
    await settle();
    expect(getCachedKnowledgeItemCount(TENANT)).toBeNull();
  });

  it('stays null when the fetch throws', async () => {
    mockFetch.mockRejectedValue(new Error('socket hang up'));
    getCachedKnowledgeItemCount(TENANT);
    await settle();
    expect(getCachedKnowledgeItemCount(TENANT)).toBeNull();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT }),
      'knowledge_count_refresh_failed',
    );
  });

  it('keeps a previously-known count rather than dropping to unknown on a blip', async () => {
    getCachedKnowledgeItemCount(TENANT);
    await settle();
    expect(getCachedKnowledgeItemCount(TENANT)).toBe(42);

    mockFetch.mockRejectedValue(new Error('blip'));
    // Force the entry stale, then read.
    _forceStale(TENANT);
    getCachedKnowledgeItemCount(TENANT);
    await settle();
    // A stale count beats an unknown, and both beat a fabricated zero.
    expect(getCachedKnowledgeItemCount(TENANT)).toBe(42);
  });

  it('stays null with no callback wiring, and stops asking', async () => {
    clientPresent = false;
    getCachedKnowledgeItemCount(TENANT);
    await settle();
    expect(getCachedKnowledgeItemCount(TENANT)).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('reports a real zero as zero', async () => {
    // An empty knowledge base is a fact. Only an UNESTABLISHED one is null.
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ count: 0 }) });
    getCachedKnowledgeItemCount(TENANT);
    await settle();
    expect(getCachedKnowledgeItemCount(TENANT)).toBe(0);
  });
});

describe('tenants are independent', () => {
  it('caches per tenant', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ count: 1 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ count: 2 }) });
    getCachedKnowledgeItemCount('a');
    getCachedKnowledgeItemCount('b');
    await settle();
    expect(getCachedKnowledgeItemCount('a')).toBe(1);
    expect(getCachedKnowledgeItemCount('b')).toBe(2);
  });
});

/** Push an entry past its TTL without waiting for real time. */
function _forceStale(tenantId: string): void {
  // The module holds its cache privately; re-reading after a reset would lose
  // the value under test, so staleness is simulated by advancing the clock the
  // module reads.
  const realNow = Date.now;
  Date.now = () => realNow() + 10 * 60 * 1000;
  getCachedKnowledgeItemCount(tenantId);
  Date.now = realNow;
}
