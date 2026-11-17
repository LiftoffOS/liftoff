// The judged pool is cut for this caller BEFORE the scorer cuts to five.
//
// Discovery keeps a judged pool of up to MAX_JUDGE_CANDIDATES (12) per query,
// cached with its verdicts, and the scorer cuts it to MAX_RESULTS (5). A
// vendor the operator switched off, or whose credential THIS caller would run
// on is parked, must leave the pool between those two steps — after the cache
// (so the entry keeps the whole pool for the next caller) and before the cut
// (so a healthy sixth candidate takes the parked vendor's place). A filter
// after the cut could only shorten the list. Verdicts travel with their
// candidates; an index that slips would score every candidate with its
// neighbour's verdict.

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../sources', () => ({
  searchApifyStore: jest.fn().mockResolvedValue([]),
  searchConnectorRegistry: jest.fn().mockResolvedValue([]),
  nativeToolCandidates: jest.fn().mockReturnValue([]),
}));
jest.mock('../judge', () => ({ judgeCandidates: jest.fn() }));
jest.mock('../evidence', () => ({
  getEvidenceForCandidates: jest.fn().mockResolvedValue(new Map()),
  getBlueprintsForCandidates: jest.fn().mockResolvedValue(new Map()),
}));
jest.mock('../blueprint-analyzer', () => ({ analyzeAdoptedRef: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../vendor-gate', () => ({ switchedOffVendors: jest.fn().mockResolvedValue(new Set()) }));

import { readFileSync } from 'fs';
import { join } from 'path';
import { discoverCapabilities, filterUnusableCandidates } from '../service';
import { getCached, setCached } from '../cache';
import { switchedOffVendors } from '../vendor-gate';
import type { Candidate, CapabilitySpec, JudgeVerdict } from '../types';

const SPEC: CapabilitySpec = {
  targetSystem: 'tiktok',
  operation: 'fetch',
  entity: 'posts',
  mode: 'public_data',
  availableInputs: [],
  requiredOutputFields: [],
  tenantId: 't1',
  boundConnectorTypes: [],
};

const GOOD: JudgeVerdict = { capabilityMatch: 3, inputSupplyable: 'yes', outputCovers: 'yes', shapeMatch: true, reason: 'fits' };

function registry(ref: string, relevance: number): Candidate {
  return {
    source: 'connector_registry', sourceRef: ref, title: ref, description: '', mode: 'public_data',
    connectorType: ref.split(':')[0], relevance,
  };
}
function actor(ref: string, relevance: number): Candidate {
  return {
    source: 'apify_store', sourceRef: ref, title: ref, description: '', mode: 'public_data', relevance,
    stats: { users30d: 500, lastRunAt: new Date().toISOString() },
  };
}
function native(name: string, relevance: number): Candidate {
  return { source: 'native_tool', sourceRef: name, title: name, description: '', mode: 'public_data', relevance };
}

/** Twelve judged candidates: five TikHub functions ranked first by relevance,
 *  then a store actor, then the rest. Cached, as a live discovery would leave it. */
function cacheTwelve(): Candidate[] {
  const pool = [
    registry('tikhub:a', 12), registry('tikhub:b', 11), registry('tikhub:c', 10), registry('tikhub:d', 9), registry('tikhub:e', 8),
    actor('clockworks/tiktok-scraper', 7), registry('strale:f', 6), registry('nasdaq:g', 5), native('web_search', 4),
    registry('gloria:h', 3), registry('strale:i', 2), registry('nasdaq:j', 1),
  ];
  // Distinct verdicts per candidate, so a slipped index is visible in the output.
  setCached(SPEC, { candidates: pool, verdicts: pool.map((c) => ({ ...GOOD, reason: `verdict for ${c.sourceRef}` })) });
  return pool;
}

beforeEach(() => {
  jest.clearAllMocks();
  (switchedOffVendors as jest.Mock).mockResolvedValue(new Set());
});

describe('filterUnusableCandidates', () => {
  it('removes a candidate and its verdict together, keeping the arrays aligned', () => {
    const candidates = [registry('tikhub:a', 3), actor('x/y', 2), native('web_search', 1), registry('strale:b', 0)];
    const verdicts = candidates.map((c) => ({ ...GOOD, reason: c.sourceRef }));
    const out = filterUnusableCandidates(candidates, verdicts, new Set(['strale']), (t) => t === 'apify');
    expect(out.candidates.map((c) => c.sourceRef)).toEqual(['tikhub:a', 'web_search']);
    expect(out.verdicts.map((v) => v.reason)).toEqual(['tikhub:a', 'web_search']);
    expect(out.removed).toBe(2);
  });

  it('never filters a native tool, and filters nothing without a predicate or a switch', () => {
    const candidates = [native('web_search', 1), registry('tikhub:a', 3)];
    const verdicts = candidates.map(() => GOOD);
    expect(filterUnusableCandidates(candidates, verdicts, new Set(), undefined).removed).toBe(0);
    expect(filterUnusableCandidates(candidates, verdicts, new Set(['web_search', 'native_tool']), () => true).candidates.map((c) => c.sourceRef)).toEqual(['web_search']);
  });
});

describe('discoverCapabilities cuts the pool for this caller before the cut to five', () => {
  it('a sixth healthy candidate surfaces when a vendor in the top five is cooling for this caller', async () => {
    cacheTwelve();
    const out = await discoverCapabilities(SPEC, { vendorCooling: (t) => t === 'tikhub' });
    const refs = out.candidates.map((c) => c.sourceRef);
    expect(refs).toHaveLength(5);
    expect(refs).not.toContain('tikhub:a');
    expect(refs).toEqual(expect.arrayContaining(['clockworks/tiktok-scraper', 'strale:f', 'nasdaq:g', 'web_search', 'gloria:h']));
    // Each survivor carries ITS OWN verdict, not a neighbour's.
    for (const c of out.candidates) expect(c.judge.reason).toBe(`verdict for ${c.sourceRef}`);
  });

  it('offers fewer than five when the cached pool holds fewer healthy candidates', async () => {
    cacheTwelve();
    const out = await discoverCapabilities(SPEC, { vendorCooling: (t) => t === 'tikhub' || t === 'strale' || t === 'nasdaq' });
    expect(out.candidates.map((c) => c.sourceRef).sort()).toEqual(['clockworks/tiktok-scraper', 'gloria:h', 'web_search'].sort());
  });

  it('applies the operator switch to a cached pool the same way, and store actors follow the apify switch', async () => {
    cacheTwelve();
    (switchedOffVendors as jest.Mock).mockResolvedValue(new Set(['apify', 'tikhub']));
    const out = await discoverCapabilities(SPEC);
    const refs = out.candidates.map((c) => c.sourceRef);
    expect(refs).not.toContain('clockworks/tiktok-scraper');
    expect(refs.some((r) => r.startsWith('tikhub:'))).toBe(false);
    expect(refs).toHaveLength(5);
  });

  it('leaves the cache entry whole: the next caller sees the full pool', async () => {
    const pool = cacheTwelve();
    await discoverCapabilities(SPEC, { vendorCooling: () => true });
    expect(getCached(SPEC)?.candidates).toHaveLength(pool.length);
    expect(getCached(SPEC)?.verdicts).toHaveLength(pool.length);
    // And without the predicate the same pool ranks its top five unfiltered.
    const out = await discoverCapabilities(SPEC);
    expect(out.candidates.map((c) => c.sourceRef)).toEqual(['tikhub:a', 'tikhub:b', 'tikhub:c', 'tikhub:d', 'tikhub:e']);
  });

  it('with no predicate — the distiller\'s prior-art call — no cooldown narrows the pool', async () => {
    cacheTwelve();
    const out = await discoverCapabilities(SPEC, { budgetMs: 20000 });
    expect(out.candidates.map((c) => c.sourceRef)).toEqual(['tikhub:a', 'tikhub:b', 'tikhub:c', 'tikhub:d', 'tikhub:e']);
  });
});

// The distiller must never pass a cooling predicate: a team authored during a
// five-minute outage still gets its capability step, because needs are
// vendor-agnostic and the step resolves live at run time.
describe('the distiller\'s prior-art discovery is independent of the cooldown', () => {
  it('calls discoverCapabilities with a budget only', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'internal-agents', 'distill-service.ts'), 'utf8');
    const calls = [...src.matchAll(/discoverCapabilities\(([^)]*)\)/g)].map((m) => m[1]);
    expect(calls.length).toBeGreaterThan(0);
    for (const args of calls) {
      expect(args).not.toContain('vendorCooling');
      expect(args).not.toContain('isCooling');
    }
    expect(src).not.toMatch(/vendorCooling|isCooling|liveCooldowns/);
  });
});
