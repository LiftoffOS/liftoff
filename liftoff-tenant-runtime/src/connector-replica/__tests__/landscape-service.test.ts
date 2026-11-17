// The workspace data landscape.
//
// Two things are being pinned. First, the bound: consumers are prompts, and an
// unbounded landscape crowds out the instructions it exists to support.
// Second, the honesty: a count here is a floor, a null is not a zero, and a
// shortened list says it was shortened.

const mockQuery = jest.fn();
let pool: { query: typeof mockQuery };

jest.mock('../../infrastructure/database', () => ({
  get pool() { return pool; },
  withTenantScope: async (_t: string, fn: (c: unknown) => Promise<unknown>) => fn(pool),
}));

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockCachedKnowledgeCount = jest.fn();
jest.mock('../knowledge-count-client', () => ({
  getCachedKnowledgeItemCount: (...a: unknown[]) => mockCachedKnowledgeCount(...a),
}));

import {
  boundLandscape,
  getDataLandscape,
  renderLandscapeBlock,
  type DataLandscape,
} from '../landscape-service';

const TENANT = '11111111-1111-1111-1111-111111111111';

beforeEach(() => {
  mockQuery.mockReset();
  mockCachedKnowledgeCount.mockReset().mockReturnValue(null);
  pool = { query: mockQuery };
});

/** census row, then the indexed-content row. */
function respondWith(census: unknown[], indexed = { n: '0', oldest: null, newest: null }) {
  mockQuery
    .mockResolvedValueOnce({ rows: census })
    .mockResolvedValueOnce({ rows: [indexed] });
}

describe('reading the landscape', () => {
  it('groups entity counts by connector', async () => {
    respondWith([
      { connector_type: 'slack', entity_type: 'channel', n: '12', hydrated: '3', stubs: '9', oldest: new Date('2026-07-01'), newest: new Date('2026-08-18') },
      { connector_type: 'slack', entity_type: 'user', n: '40', hydrated: '0', stubs: '40', oldest: new Date('2026-07-05'), newest: new Date('2026-08-17') },
      { connector_type: 'hubspot', entity_type: 'deal', n: '7', hydrated: '7', stubs: '0', oldest: new Date('2026-08-01'), newest: new Date('2026-08-18') },
    ]);

    const out = await getDataLandscape({ tenantId: TENANT });

    expect(out.connectors).toHaveLength(2);
    const slack = out.connectors.find((c) => c.connectorType === 'slack')!;
    expect(slack.entityCounts).toEqual({ channel: 12, user: 40 });
    expect(slack.hydratedCount).toBe(3);
    expect(slack.stubCount).toBe(49);
    expect(slack.oldestObservedAt).toBe('2026-07-01T00:00:00.000Z');
  });

  it('reports indexed content separately from the census', async () => {
    respondWith([], { n: '1500', oldest: new Date('2026-06-01'), newest: new Date('2026-08-18') });
    const out = await getDataLandscape({ tenantId: TENANT });
    expect(out.indexedContext.items).toBe(1500);
    expect(out.indexedContext.oldest).toBe('2026-06-01T00:00:00.000Z');
  });

  it('reports an unknown knowledge count as null, never as zero', async () => {
    respondWith([]);
    const out = await getDataLandscape({ tenantId: TENANT });
    expect(out.knowledgeItems).toBeNull();
  });

  it('carries a supplied knowledge count through', async () => {
    respondWith([]);
    const out = await getDataLandscape({ tenantId: TENANT, knowledgeItems: 42 });
    expect(out.knowledgeItems).toBe(42);
  });

  it('falls back to its own cached count when the caller supplies none', async () => {
    // The agent-facing paths — the session prompt and the data_landscape tool
    // — have no control-plane number to pass down, and without this the
    // knowledge line would be permanently absent for every agent.
    mockCachedKnowledgeCount.mockReturnValue(17);
    respondWith([]);
    const out = await getDataLandscape({ tenantId: TENANT });
    expect(out.knowledgeItems).toBe(17);
  });

  it('prefers an explicitly supplied count over the cache', async () => {
    // The control plane owns that table; when it is the caller, its number is
    // authoritative and fresher than anything cached here.
    mockCachedKnowledgeCount.mockReturnValue(17);
    respondWith([]);
    const out = await getDataLandscape({ tenantId: TENANT, knowledgeItems: 3 });
    expect(out.knowledgeItems).toBe(3);
  });

  it('honours an explicit null rather than silently substituting the cache', async () => {
    mockCachedKnowledgeCount.mockReturnValue(17);
    respondWith([]);
    const out = await getDataLandscape({ tenantId: TENANT, knowledgeItems: null });
    expect(out.knowledgeItems).toBeNull();
  });

  it('never throws — a failed read costs the agent its map, not its turn', async () => {
    mockQuery.mockRejectedValue(new Error('connection terminated'));
    const out = await getDataLandscape({ tenantId: TENANT });
    expect(out.connectors).toEqual([]);
    expect(out.knowledgeItems).toBeNull();
    expect(out.truncated).toBe(false);
  });

  it('still reports the knowledge count when the census read fails', async () => {
    // The two are independent sources; one failing should not blank the other.
    mockCachedKnowledgeCount.mockReturnValue(17);
    mockQuery.mockRejectedValue(new Error('connection terminated'));
    const out = await getDataLandscape({ tenantId: TENANT });
    expect(out.knowledgeItems).toBe(17);
  });
});

describe('the size bound', () => {
  const connector = (name: string, types: number, per = 100) => ({
    connectorType: name,
    entityCounts: Object.fromEntries(
      Array.from({ length: types }, (_, i) => [`entity_type_number_${i}`, per + i]),
    ),
    hydratedCount: 1,
    stubCount: 1,
    oldestObservedAt: '2026-07-01T00:00:00.000Z',
    newestObservedAt: '2026-08-18T00:00:00.000Z',
  });

  const base = (connectors: ReturnType<typeof connector>[]): DataLandscape => ({
    connectors,
    indexedContext: { items: 10, oldest: null, newest: null },
    knowledgeItems: null,
    truncated: false,
  });

  it('leaves a small landscape untouched and unflagged', () => {
    const out = boundLandscape(base([connector('slack', 3)]));
    expect(out.truncated).toBe(false);
    expect(Object.keys(out.connectors[0].entityCounts)).toHaveLength(3);
  });

  it('trims entity types before dropping connectors, keeping the largest', () => {
    const out = boundLandscape(base([connector('slack', 400)]));
    expect(out.truncated).toBe(true);
    expect(out.connectors).toHaveLength(1);
    expect(Object.keys(out.connectors[0].entityCounts).length).toBeLessThanOrEqual(12);
    // The biggest types survive; the long tail is what goes.
    expect(out.connectors[0].entityCounts).toHaveProperty('entity_type_number_399');
    expect(out.connectors[0].entityCounts).not.toHaveProperty('entity_type_number_0');
  });

  it('drops whole connectors only when trimming is not enough, smallest first', () => {
    const many = Array.from({ length: 60 }, (_, i) => connector(`connector_${i}`, 20, i));
    const out = boundLandscape(base(many));
    expect(out.truncated).toBe(true);
    expect(out.connectors.length).toBeLessThan(60);
    expect(Buffer.byteLength(JSON.stringify(out), 'utf8')).toBeLessThanOrEqual(8_000);
  });

  it('always keeps at least one connector rather than reporting an empty workspace', () => {
    const huge = Array.from({ length: 400 }, (_, i) => connector(`connector_${i}`, 40, i));
    const out = boundLandscape(base(huge));
    expect(out.connectors.length).toBeGreaterThanOrEqual(1);
  });
});

describe('the prompt block', () => {
  it('says what exists, and that the list is a floor', () => {
    const text = renderLandscapeBlock({
      connectors: [{
        connectorType: 'slack',
        entityCounts: { channel: 12, user: 40 },
        hydratedCount: 3,
        stubCount: 49,
        oldestObservedAt: '2026-07-01T00:00:00.000Z',
        newestObservedAt: '2026-08-18T00:00:00.000Z',
      }],
      indexedContext: { items: 1500, oldest: '2026-06-01T00:00:00.000Z', newest: null },
      knowledgeItems: 20,
      truncated: false,
    });

    expect(text).toContain('40 users, 12 channels');
    expect(text).toContain('seen since 2026-07-01');
    expect(text).toContain('1500 items');
    expect(text).toContain('20 items');
    expect(text).toMatch(/not everything that exists/i);
    expect(text).toMatch(/absence here is not an absence at the source/i);
  });

  it('tells an agent the workspace is uncatalogued rather than empty', () => {
    const text = renderLandscapeBlock({
      connectors: [],
      indexedContext: { items: 0, oldest: null, newest: null },
      knowledgeItems: null,
      truncated: false,
    });
    expect(text).toMatch(/nothing has been catalogued/i);
    expect(text).toMatch(/do not report that something does not exist/i);
  });

  it('reports a knowledge-only workspace instead of calling it uncatalogued', () => {
    // If the empty check looks at connectors and the index only, a workspace
    // with a populated knowledge base and nothing else falls into the "nothing
    // catalogued" branch and never reaches the knowledge line below it.
    const text = renderLandscapeBlock({
      connectors: [],
      indexedContext: { items: 0, oldest: null, newest: null },
      knowledgeItems: 2,
      truncated: false,
    });
    expect(text).toContain('Knowledge base: 2 items');
    expect(text).not.toMatch(/nothing has been catalogued for this workspace/i);
    // The connected systems genuinely ARE unexplored — still say so.
    expect(text).toMatch(/connected systems yet/i);
  });

  it('still calls a wholly empty workspace uncatalogued when the count is a real zero', () => {
    const text = renderLandscapeBlock({
      connectors: [],
      indexedContext: { items: 0, oldest: null, newest: null },
      knowledgeItems: 0,
      truncated: false,
    });
    expect(text).toMatch(/nothing has been catalogued for this workspace/i);
  });

  it('drops the connected-systems caveat once a connector is catalogued', () => {
    const text = renderLandscapeBlock({
      connectors: [{
        connectorType: 'slack', entityCounts: { channel: 3 },
        hydratedCount: 0, stubCount: 3, oldestObservedAt: null, newestObservedAt: null,
      }],
      indexedContext: { items: 0, oldest: null, newest: null },
      knowledgeItems: 2,
      truncated: false,
    });
    expect(text).toContain('Knowledge base: 2 items');
    expect(text).not.toMatch(/connected systems yet/i);
  });

  it('omits the knowledge line when the count is unknown', () => {
    const text = renderLandscapeBlock({
      connectors: [],
      indexedContext: { items: 5, oldest: null, newest: null },
      knowledgeItems: null,
      truncated: false,
    });
    expect(text).not.toMatch(/knowledge base/i);
  });

  it('says when the summary was shortened', () => {
    const text = renderLandscapeBlock({
      connectors: [{
        connectorType: 'slack', entityCounts: { channel: 1 },
        hydratedCount: 0, stubCount: 1, oldestObservedAt: null, newestObservedAt: null,
      }],
      indexedContext: { items: 0, oldest: null, newest: null },
      knowledgeItems: null,
      truncated: true,
    });
    expect(text).toMatch(/was shortened/i);
  });

  it('uses a singular noun for a single entity', () => {
    const text = renderLandscapeBlock({
      connectors: [{
        connectorType: 'hubspot', entityCounts: { deal: 1 },
        hydratedCount: 0, stubCount: 1, oldestObservedAt: null, newestObservedAt: null,
      }],
      indexedContext: { items: 0, oldest: null, newest: null },
      knowledgeItems: null,
      truncated: false,
    });
    expect(text).toContain('1 deal');
    expect(text).not.toContain('1 deals');
  });
});
