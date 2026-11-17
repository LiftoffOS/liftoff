import { costFactor, expectedCostUsd, passesHealthFloors, routeOf, scoreCandidates, speedFactor } from '../scorer';
import type { Candidate, CapabilitySpec, JudgeVerdict } from '../types';

const SPEC: CapabilitySpec = {
  targetSystem: 'instagram',
  operation: 'monitor',
  entity: 'posts',
  mode: 'public_data',
  availableInputs: ['search_terms'],
  requiredOutputFields: ['url', 'text'],
  tenantId: 't-1',
  boundConnectorTypes: ['tikhub'],
};

const VERDICT: JudgeVerdict = {
  capabilityMatch: 3,
  inputSupplyable: 'yes',
  outputCovers: 'yes',
  shapeMatch: true,
  reason: 'fits',
};

function candidate(overrides: Partial<Candidate>): Candidate {
  return {
    source: 'connector_registry',
    sourceRef: 'tikhub:fetch_user_posts',
    title: 'TikHub — fetch_user_posts',
    description: 'posts',
    mode: 'public_data',
    connectorType: 'tikhub',
    ...overrides,
  };
}

function score(cands: Candidate[], verdicts: JudgeVerdict[]) {
  return scoreCandidates({
    spec: SPEC,
    candidates: cands,
    verdicts,
    evidence: new Map(),
    blueprints: new Map(),
  });
}

describe('scorer', () => {
  it('DISCARDS a wrong-mode candidate however well it judged', () => {
    const wrongMode = candidate({ mode: 'own_account', sourceRef: 'instagram:get_my_posts' });
    expect(score([wrongMode], [VERDICT])).toHaveLength(0);
  });

  it('disqualifies inputSupplyable no at any capabilityMatch', () => {
    const v: JudgeVerdict = { ...VERDICT, inputSupplyable: 'no' };
    expect(score([candidate({})], [v])).toHaveLength(0);
  });

  it('drops capabilityMatch 0', () => {
    expect(score([candidate({})], [{ ...VERDICT, capabilityMatch: 0 }])).toHaveLength(0);
  });

  it('ranks a bound connector above an unbound one at equal verdicts', () => {
    const bound = candidate({});
    const unbound = candidate({ sourceRef: 'pdl:enrich', connectorType: 'pdl' });
    const ranked = score([unbound, bound], [VERDICT, VERDICT]);
    expect(ranked[0].sourceRef).toBe('tikhub:fetch_user_posts');
    expect(ranked[0].route).toBe('bound_connector');
    expect(ranked[1].route).toBe('platform_vendor');
  });

  it('demotes on failure evidence', () => {
    const a = candidate({});
    const b = candidate({ sourceRef: 'pdl:enrich', connectorType: 'tikhub' });
    const evidence = new Map([['connector_registry:pdl:enrich', { successes: 0, failures: 5 }]]);
    const ranked = scoreCandidates({
      spec: SPEC,
      candidates: [a, b],
      verdicts: [VERDICT, VERDICT],
      evidence,
      blueprints: new Map(),
    });
    expect(ranked[0].sourceRef).toBe('tikhub:fetch_user_posts');
  });

  it('at equal fit, the cheaper of two platform vendors wins, and a free source beats both', () => {
    const dear = candidate({ sourceRef: 'vaaya:funding_rounds', connectorType: 'vaaya', price: { type: 'PER_CALL', usd: 0.25 } });
    const cheap = candidate({ sourceRef: 'locus:company_search', connectorType: 'locus', price: { type: 'PER_CALL', usd: 0.005 } });
    const free = candidate({ sourceRef: 'nasdaq:get_company_profile', connectorType: 'nasdaq', price: { type: 'PER_CALL', usd: 0 } });
    const ranked = score([dear, cheap, free], [VERDICT, VERDICT, VERDICT]);
    expect(ranked.map((r) => r.sourceRef)).toEqual(['nasdaq:get_company_profile', 'locus:company_search', 'vaaya:funding_rounds']);
  });

  it('a store actor that lists no price is not free: a priced function that fits as well outranks it', () => {
    const actor = candidate({ source: 'apify_store', sourceRef: 'memo23/crunchbase-scraper', connectorType: undefined, price: { type: 'PER_CALL', usd: 0.03, estimated: true }, stats: { users30d: 500, lastRunAt: new Date().toISOString() } });
    const fn = candidate({ sourceRef: 'locus:startup_search', connectorType: 'locus', price: { type: 'PER_CALL', usd: 0.0505 } });
    // Fit alone: the actor wins on nothing here (equal verdicts); route, cost
    // and speed decide, and the synchronous function is ahead on two of three.
    const ranked = score([actor, fn], [VERDICT, VERDICT]);
    expect(ranked[0].sourceRef).toBe('locus:startup_search');
  });

  it('a bound connector is free to the customer whatever the vendor charges', () => {
    const bound = candidate({ price: { type: 'PER_CALL', usd: 0.5 } });
    const platform = candidate({ sourceRef: 'locus:people_search', connectorType: 'locus', price: { type: 'PER_CALL', usd: 0.005 } });
    const ranked = score([platform, bound], [VERDICT, VERDICT]);
    expect(ranked[0].route).toBe('bound_connector');
  });

  it('what a candidate HAS cost outweighs what it lists, and a slow one loses to a quick one', () => {
    const listedCheap = candidate({ sourceRef: 'a:x', connectorType: 'locus', price: { type: 'PER_CALL', usd: 0.001 } });
    const listedDear = candidate({ sourceRef: 'b:y', connectorType: 'locus', price: { type: 'PER_CALL', usd: 0.1 } });
    const evidence = new Map([
      ['connector_registry:a:x', { successes: 4, failures: 0, avgCostUsd: 0.2, medianLatencyMs: 1_000 }],
      ['connector_registry:b:y', { successes: 4, failures: 0, avgCostUsd: 0.002, medianLatencyMs: 1_000 }],
    ]);
    const ranked = scoreCandidates({ spec: SPEC, candidates: [listedCheap, listedDear], verdicts: [VERDICT, VERDICT], evidence, blueprints: new Map() });
    expect(ranked[0].sourceRef).toBe('b:y');
    const quick = new Map([['connector_registry:a:x', { successes: 4, failures: 0, medianLatencyMs: 1_000 }], ['connector_registry:b:y', { successes: 4, failures: 0, medianLatencyMs: 90_000 }]]);
    const same = [candidate({ sourceRef: 'a:x', connectorType: 'locus', price: { type: 'PER_CALL', usd: 0.01 } }), candidate({ sourceRef: 'b:y', connectorType: 'locus', price: { type: 'PER_CALL', usd: 0.01 } })];
    expect(scoreCandidates({ spec: SPEC, candidates: same, verdicts: [VERDICT, VERDICT], evidence: quick, blueprints: new Map() })[0].sourceRef).toBe('a:x');
  });

  it('cost and speed are bounded factors: fit still leads', () => {
    expect(costFactor(0, 0)).toBe(1);
    expect(costFactor(0.001, 0)).toBe(1);
    expect(costFactor(0.01, 0.001)).toBeCloseTo(0.8, 9);
    expect(costFactor(0.1, 0.001)).toBeCloseTo(0.6, 9);
    expect(costFactor(10, 0.001)).toBeCloseTo(0.6, 9);
    expect(costFactor(undefined, 0.001)).toBe(0.95);
    expect(speedFactor('platform_vendor', null)).toBeCloseTo(1 - 0.2 * (Math.log10(2) / 2), 9);
    expect(speedFactor('blueprint', null)).toBeCloseTo(1 - 0.2 * (Math.log10(60) / 2), 9);
    expect(speedFactor('blueprint', { successes: 1, failures: 0, medianLatencyMs: 1_000 })).toBe(1);
    expect(speedFactor('native_tool', { successes: 1, failures: 0, medianLatencyMs: 100_000 })).toBeCloseTo(0.8, 9);
  });

  it('attaches blueprint procedure when one exists', () => {
    const c = candidate({});
    const ranked = scoreCandidates({
      spec: SPEC,
      candidates: [c],
      verdicts: [VERDICT],
      evidence: new Map(),
      blueprints: new Map([['connector_registry:tikhub:fetch_user_posts', 'step 1: fetch']]),
    });
    expect(ranked[0].blueprintProcedureMd).toBe('step 1: fetch');
  });
});

describe('health floors (store candidates only)', () => {
  const now = new Date('2026-09-08T00:00:00Z');
  const storeCandidate = (stats: Candidate['stats']): Candidate =>
    candidate({ source: 'apify_store', sourceRef: 'a/b', connectorType: undefined, stats });

  it('drops low-usage actors', () => {
    expect(
      passesHealthFloors(storeCandidate({ users30d: 3, lastRunAt: '2026-09-07T00:00:00Z' }), now),
    ).toBe(false);
  });

  it('drops stale actors', () => {
    expect(
      passesHealthFloors(storeCandidate({ users30d: 900, lastRunAt: '2026-01-01T00:00:00Z' }), now),
    ).toBe(false);
  });

  it('passes healthy actors and never gates our own candidates', () => {
    expect(
      passesHealthFloors(storeCandidate({ users30d: 900, lastRunAt: '2026-09-07T00:00:00Z' }), now),
    ).toBe(true);
    expect(passesHealthFloors(candidate({}), now)).toBe(true);
  });
});

describe('routeOf', () => {
  it('maps store actors to blueprint and native tools to native_tool', () => {
    expect(routeOf(candidate({ source: 'apify_store', connectorType: undefined }), SPEC)).toBe('blueprint');
    expect(routeOf(candidate({ source: 'native_tool', connectorType: undefined }), SPEC)).toBe('native_tool');
  });
});

// The cost factor reads what a store actor HAS cost, not what the store's
// estimate says it would. The fixtures are two actors' recorded figures: a
// comments-per-post bulk scraper that cost $0.470 for a 100-record run and
// ranked fourth in the search that offered it, and a posts scraper that cost
// $0.128 for its 100-record run. The store's
// estimate prices a comments-per-post actor as if items were posts (a start
// event plus a primary event at ten items), which is what let the dearer
// actor rank as if it were the cheaper; the evidence half sees the real
// figure on the next search, and this pins that it does.
describe('the cost factor uses the recorded cost over the estimate', () => {
  const BULK_COMMENTS_REF = 'apify:reddit-post-comments-bulk-scraper';
  const POSTS_REF = 'apify:reddit-posts-scraper';
  // The store's estimate for the bulk actor: a start event plus a primary
  // event at APIFY_NOMINAL_ITEMS, priced as posts. Well under what it cost.
  const bulkComments = candidate({
    source: 'apify_store', sourceRef: BULK_COMMENTS_REF, connectorType: undefined, mode: 'public_data',
    price: { type: 'PER_RESULT', usd: 0.055, estimated: true },
    stats: { users30d: 500, lastRunAt: new Date().toISOString() },
  });
  const posts = candidate({
    source: 'apify_store', sourceRef: POSTS_REF, connectorType: undefined, mode: 'public_data',
    price: { type: 'PER_RESULT', usd: 0.06, estimated: true },
    stats: { users30d: 500, lastRunAt: new Date().toISOString() },
  });
  const recorded = new Map([
    [`apify_store:${BULK_COMMENTS_REF}`, { successes: 1, failures: 0, avgCostUsd: 0.47, medianLatencyMs: 51_000 }],
    [`apify_store:${POSTS_REF}`, { successes: 1, failures: 0, avgCostUsd: 0.128, medianLatencyMs: 40_000 }],
  ]);

  it('expectedCostUsd is the recorded average once the actor has a success, whatever the estimate said', () => {
    expect(expectedCostUsd(bulkComments, recorded.get(`apify_store:${BULK_COMMENTS_REF}`)!)).toBe(0.47);
    expect(expectedCostUsd(posts, recorded.get(`apify_store:${POSTS_REF}`)!)).toBe(0.128);
    // Without evidence the estimate stands, which is the figure that ranked
    // the bulk actor as the cheaper one.
    expect(expectedCostUsd(bulkComments, null)).toBe(0.055);
    expect(expectedCostUsd(bulkComments, { successes: 0, failures: 1, avgCostUsd: 0.47 })).toBe(0.055);
  });

  it('with the recorded figures the bulk scraper\'s cost factor is below the posts scraper\'s, where the estimates had them the other way round', () => {
    const cheapestRecorded = Math.min(0.47, 0.128);
    const bulkFactor = costFactor(0.47, cheapestRecorded);
    const postsFactor = costFactor(0.128, cheapestRecorded);
    expect(postsFactor).toBe(1);
    expect(bulkFactor).toBeLessThan(postsFactor);
    expect(bulkFactor).toBeCloseTo(1 - 0.4 * (Math.log10(0.47 / 0.128) / 2), 9);
    // The estimates alone had the bulk actor as the cheaper of the two.
    const cheapestEstimated = Math.min(0.055, 0.06);
    expect(costFactor(0.055, cheapestEstimated)).toBeGreaterThan(costFactor(0.06, cheapestEstimated));
  });

  it('at equal fit and health, the posts scraper now outranks the bulk scraper for a posts ask', () => {
    const ranked = scoreCandidates({
      spec: { ...SPEC, targetSystem: 'reddit', operation: 'search', entity: 'posts', boundConnectorTypes: [] },
      candidates: [bulkComments, posts],
      verdicts: [VERDICT, VERDICT],
      evidence: recorded,
      blueprints: new Map(),
    });
    expect(ranked.map((c) => c.sourceRef)).toEqual([POSTS_REF, BULK_COMMENTS_REF]);
  });
});
