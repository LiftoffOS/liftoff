// Indexed connector content as a search source.
//
// The two properties worth pinning are the ones that decide whether this can
// safely sit inside a tool with other sources: it never throws, and it always
// says what its coverage is — including, and especially, when it found nothing.

const mockSearch = jest.fn();
const mockCoverage = jest.fn();
jest.mock('../search-service', () => ({
  searchConnectorContent: (...a: unknown[]) => mockSearch(...a),
  connectorContentCoverage: (...a: unknown[]) => mockCoverage(...a),
}));

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  searchIndexedContext,
  _resetIndexedContextCountersForTesting,
} from '../indexed-context-source';

const TENANT = 'tenant-1';
const AGENT = 'agent-1';

const item = (id: string, score = 0.5) => ({
  id,
  content: `content ${id}`,
  connectorType: 'slack',
  entityType: 'message',
  tags: [],
  score,
});

beforeEach(() => {
  jest.clearAllMocks();
  _resetIndexedContextCountersForTesting();
  mockCoverage.mockResolvedValue({
    indexedItems: 42,
    oldestIndexedAt: '2026-07-01T00:00:00.000Z',
    newestIndexedAt: '2026-08-18T00:00:00.000Z',
  });
  mockSearch.mockResolvedValue([item('a', 0.9), item('b', 0.4)]);
});

describe('never throws', () => {
  it('returns zero items and a note when the search service rejects', async () => {
    mockSearch.mockRejectedValue(new Error('connection terminated'));
    const out = await searchIndexedContext({ tenantId: TENANT, agentId: AGENT, query: 'invoices', runKey: 'run-x' });
    expect(out.items).toEqual([]);
    expect(out.note).toMatch(/could not be searched/i);
    expect(out.coverage.indexedItems).toBe(0);
    // Distinguishable from "searched, found nothing", so the audit row can say
    // which of the two happened.
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/connection terminated/);
  });

  it('returns zero items when the coverage read rejects', async () => {
    mockCoverage.mockRejectedValue(new Error('relation does not exist'));
    const out = await searchIndexedContext({ tenantId: TENANT, agentId: AGENT, query: 'invoices', runKey: 'run-x' });
    expect(out.items).toEqual([]);
    expect(out.note).toBeDefined();
  });
});

describe('coverage is always stated', () => {
  it('carries coverage on the happy path', async () => {
    const out = await searchIndexedContext({ tenantId: TENANT, agentId: AGENT, query: 'invoices', runKey: 'run-x' });
    expect(out.items).toHaveLength(2);
    expect(out.coverage.indexedItems).toBe(42);
    expect(out.ok).toBe(true);
    // Nothing to qualify when there are hits.
    expect(out.note).toBeUndefined();
  });

  it('reports a genuine empty result as HAVING RUN', async () => {
    mockSearch.mockResolvedValue([]);
    const out = await searchIndexedContext({ tenantId: TENANT, agentId: AGENT, query: 'invoices', runKey: 'run-x' });
    expect(out.ok).toBe(true);
    expect(out.error).toBeUndefined();
  });

  it('qualifies an empty result rather than implying absence at the source', async () => {
    mockSearch.mockResolvedValue([]);
    const out = await searchIndexedContext({ tenantId: TENANT, agentId: AGENT, query: 'invoices', runKey: 'run-x' });
    expect(out.items).toEqual([]);
    expect(out.coverage.indexedItems).toBe(42);
    expect(out.note).toMatch(/absence here is not absence at the source/i);
    expect(out.note).toContain('42');
  });

  it('says the index is empty when it is, and points at the connector', async () => {
    mockSearch.mockResolvedValue([]);
    mockCoverage.mockResolvedValue({ indexedItems: 0, oldestIndexedAt: null, newestIndexedAt: null });
    const out = await searchIndexedContext({ tenantId: TENANT, agentId: AGENT, query: 'invoices', runKey: 'run-x' });
    expect(out.note).toMatch(/nothing has been indexed/i);
    expect(out.note).toMatch(/query the connector directly/i);
  });

  it('handles an empty query without calling the search service', async () => {
    const out = await searchIndexedContext({ tenantId: TENANT, agentId: AGENT, query: '   ', runKey: 'run-x' });
    expect(out.items).toEqual([]);
    expect(out.note).toBeDefined();
    expect(mockSearch).not.toHaveBeenCalled();
  });
});

describe('what the source must never return', () => {
  it('suppresses the cold-start fallback, which returns MEMORY rows', async () => {
    // `search` runs memory as its own source. Letting an empty index fall back
    // to harvest memories here returns the same content twice under two labels,
    // with a coverage object reporting zero indexed items beside them.
    await searchIndexedContext({ tenantId: TENANT, agentId: AGENT, query: 'q', runKey: 'run-x' });
    expect(mockSearch).toHaveBeenCalledWith(
      expect.objectContaining({ coldStartFallback: false }),
    );
  });

  it('passes the suppression on every per-type query too', async () => {
    await searchIndexedContext({
      tenantId: TENANT, agentId: AGENT, query: 'q',
      connectorTypes: ['slack', 'hubspot'], runKey: 'run-x',
    });
    for (const call of mockSearch.mock.calls) {
      expect(call[0]).toMatchObject({ coldStartFallback: false });
    }
  });
});

describe('precomputed embedding', () => {
  it('forwards the caller vector so the search service skips HyDE', async () => {
    await searchIndexedContext({
      tenantId: TENANT,
      agentId: AGENT,
      query: 'invoices',
      embeddingJson: '[0.1,0.2]',
      runKey: 'run-x',
    });
    expect(mockSearch).toHaveBeenCalledWith(
      expect.objectContaining({ embeddingJson: '[0.1,0.2]' }),
    );
  });

  it('omits the key entirely when the caller has no vector', async () => {
    await searchIndexedContext({ tenantId: TENANT, agentId: AGENT, query: 'invoices', runKey: 'run-x' });
    expect(mockSearch).toHaveBeenCalledWith(
      expect.not.objectContaining({ embeddingJson: expect.anything() }),
    );
  });
});

describe('bounds', () => {
  it('clamps the limit', async () => {
    await searchIndexedContext({ tenantId: TENANT, agentId: AGENT, query: 'q', limit: 9999, runKey: 'run-x' });
    expect(mockSearch).toHaveBeenCalledWith(expect.objectContaining({ limit: 25 }));

    mockSearch.mockClear();
    await searchIndexedContext({ tenantId: TENANT, agentId: AGENT, query: 'q', limit: 0, runKey: 'run-x' });
    expect(mockSearch).toHaveBeenCalledWith(expect.objectContaining({ limit: 1 }));
  });

  it('runs one query per connector type and merges by score', async () => {
    mockSearch
      .mockResolvedValueOnce([item('slack-1', 0.2)])
      .mockResolvedValueOnce([item('hubspot-1', 0.8)]);
    const out = await searchIndexedContext({
      tenantId: TENANT,
      agentId: AGENT,
      query: 'q',
      connectorTypes: ['slack', 'hubspot'],
      limit: 5,
      runKey: 'run-x',
    });
    expect(mockSearch).toHaveBeenCalledTimes(2);
    expect(out.items.map((i) => i.id)).toEqual(['hubspot-1', 'slack-1']);
  });

  it('truncates a per-type fan-out back to the requested limit', async () => {
    mockSearch
      .mockResolvedValueOnce([item('a', 0.9), item('b', 0.8)])
      .mockResolvedValueOnce([item('c', 0.7), item('d', 0.6)]);
    const out = await searchIndexedContext({
      tenantId: TENANT,
      agentId: AGENT,
      query: 'q',
      connectorTypes: ['slack', 'hubspot'],
      limit: 2,
      runKey: 'run-x',
    });
    expect(out.items.map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('caps searches per run so a looping agent cannot spend unbounded retrieval', async () => {
    for (let i = 0; i < 20; i++) {
      const out = await searchIndexedContext({
        tenantId: TENANT, agentId: AGENT, query: 'q', runKey: 'run-1',
      });
      expect(out.items).toHaveLength(2);
    }
    const capped = await searchIndexedContext({
      tenantId: TENANT, agentId: AGENT, query: 'q', runKey: 'run-1',
    });
    expect(capped.items).toEqual([]);
    expect(capped.note).toMatch(/reached its limit/i);
    expect(capped.ok).toBe(false);
    expect(capped.error).toBe('run_cap_reached');
    expect(mockSearch).toHaveBeenCalledTimes(20);
  });

  it('counts each run separately', async () => {
    for (let i = 0; i < 20; i++) {
      await searchIndexedContext({ tenantId: TENANT, agentId: AGENT, query: 'q', runKey: 'run-1' });
    }
    const other = await searchIndexedContext({
      tenantId: TENANT, agentId: AGENT, query: 'q', runKey: 'run-2',
    });
    expect(other.items).toHaveLength(2);
  });

  it('expires a counter so a cap can never become permanent', async () => {
    // A cap with no expiry only ever tightens. Without this the twentieth
    // search of a long-lived key switches the feature off for good, and
    // nothing says so.
    for (let i = 0; i < 20; i++) {
      await searchIndexedContext({ tenantId: TENANT, agentId: AGENT, query: 'q', runKey: 'run-1' });
    }
    expect((await searchIndexedContext({
      tenantId: TENANT, agentId: AGENT, query: 'q', runKey: 'run-1',
    })).ok).toBe(false);

    const realNow = Date.now;
    Date.now = () => realNow() + 61 * 60 * 1000;
    try {
      const after = await searchIndexedContext({
        tenantId: TENANT, agentId: AGENT, query: 'q', runKey: 'run-1',
      });
      expect(after.ok).toBe(true);
      expect(after.items).toHaveLength(2);
    } finally {
      Date.now = realNow;
    }
  });
});
