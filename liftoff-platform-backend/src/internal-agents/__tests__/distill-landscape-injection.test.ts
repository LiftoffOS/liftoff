// The TENANT DATA LANDSCAPE distillation section.
//
// What matters: an unavailable landscape produces nothing rather than a claim
// about an empty workspace, counts are framed as a floor, and no customer
// entity NAMES cross into a prompt that will be stored as instructions.

import { buildDataLandscapeSection, type DataLandscapeSummary } from '../distill-landscape-injection';

const landscape = (over: Partial<DataLandscapeSummary> = {}): DataLandscapeSummary => ({
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
  ...over,
});

describe('degradation', () => {
  it('produces nothing when the landscape is unavailable', () => {
    expect(buildDataLandscapeSection(null)).toBe('');
  });

  it('produces nothing rather than asserting an empty workspace', () => {
    // A census that has not run yet is not a workspace with no data, and the
    // distiller must not write instructions around our own scheduling.
    const empty = buildDataLandscapeSection(landscape({
      connectors: [],
      indexedContext: { items: 0, oldest: null, newest: null },
      knowledgeItems: null,
    }));
    expect(empty).toBe('');
  });

  it('renders on indexed content alone, with no census', () => {
    const text = buildDataLandscapeSection(landscape({ connectors: [] }));
    expect(text).toContain('1500 items');
  });

  it('renders on a knowledge base alone, with no census and no index', () => {
    // A suppression check that reads the census and the index only gives a
    // workspace whose only catalogued data is its knowledge base no section at
    // all, and the knowledge line below becomes unreachable.
    const text = buildDataLandscapeSection(landscape({
      connectors: [],
      indexedContext: { items: 0, oldest: null, newest: null },
      knowledgeItems: 2,
    }));
    expect(text).toContain('Knowledge base: 2 items');
    expect(text).toMatch(/FLOOR, not a total/);
  });

  it('still suppresses when the knowledge count is a real zero', () => {
    const text = buildDataLandscapeSection(landscape({
      connectors: [],
      indexedContext: { items: 0, oldest: null, newest: null },
      knowledgeItems: 0,
    }));
    expect(text).toBe('');
  });
});

describe('content', () => {
  it('names entity types and counts, largest first', () => {
    const text = buildDataLandscapeSection(landscape());
    expect(text).toContain('slack: 40 users, 12 channels');
  });

  it('says how far back the record goes', () => {
    expect(buildDataLandscapeSection(landscape())).toContain('record goes back to 2026-07-01');
  });

  it('frames the numbers as a floor, not a total', () => {
    const text = buildDataLandscapeSection(landscape());
    expect(text).toMatch(/FLOOR, not a total/);
    expect(text).toMatch(/[Nn]ever write an instruction that asserts something does not/);
  });

  it('points the distiller at already-fetched content over a fresh fetch', () => {
    const text = buildDataLandscapeSection(landscape());
    expect(text).toMatch(/at no cost to the connected system/);
    expect(text).toMatch(/[Pp]refer it over a fresh fetch/);
  });

  it('omits the knowledge line when the count is unknown', () => {
    const text = buildDataLandscapeSection(landscape({ knowledgeItems: null }));
    expect(text).not.toMatch(/knowledge base/i);
  });

  it('folds a long tail of entity types instead of listing all of them', () => {
    const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`type_${i}`, i + 1]));
    const text = buildDataLandscapeSection(landscape({
      connectors: [{
        connectorType: 'hubspot', entityCounts: many,
        hydratedCount: 0, stubCount: 0, oldestObservedAt: null, newestObservedAt: null,
      }],
    }));
    expect(text).toContain('and 22 other entity types');
    // The largest survive.
    expect(text).toContain('30 type_29s');
  });

  it('says when the summary was shortened upstream', () => {
    expect(buildDataLandscapeSection(landscape({ truncated: true }))).toMatch(/was shortened/i);
  });

  it('uses a singular noun for a single entity', () => {
    const text = buildDataLandscapeSection(landscape({
      connectors: [{
        connectorType: 'hubspot', entityCounts: { deal: 1 },
        hydratedCount: 0, stubCount: 0, oldestObservedAt: null, newestObservedAt: null,
      }],
    }));
    expect(text).toContain('1 deal');
    expect(text).not.toContain('1 deals');
  });
});

describe('what must not leak', () => {
  it('carries no entity titles — counts and types only', () => {
    // Entity titles are customer business data, and a distilled prompt is
    // stored. The shape is what the distiller needs; the names are not.
    const text = buildDataLandscapeSection(landscape());
    expect(text).not.toMatch(/acme|renewal|customer-/i);
    // Nothing in the input shape can even carry a title.
    expect(Object.keys(landscape().connectors[0])).not.toContain('titles');
  });
});
