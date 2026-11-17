jest.mock('../../llm/client', () => ({ llmClient: { complete: jest.fn() } }));

import { computeFingerprint, computePriorArtHash } from '../distill-cache';
import {
  buildPriorArtSection,
  capabilitySpecsSourceHash,
  deriveCapabilitySpecs,
  deriveCapabilitySpecsLLM,
  PRIOR_ART_HEADER,
} from '../distill-prior-art-injection';
import { llmClient } from '../../llm/client';
import type { DiscoveryResult, ScoredCandidate } from '../../capability-discovery';
import type { DistillInput } from '../distill-service';

const mockComplete = llmClient.complete as jest.Mock;

const BASE_INPUT: DistillInput = {
  role: 'Competitor Analyst',
  responsibilities: 'Monitor competitor instagram posts and report weekly',
  integrations: [],
  tenantId: 't-1',
} as unknown as DistillInput;

function scored(overrides: Partial<ScoredCandidate>): ScoredCandidate {
  return {
    source: 'apify_store',
    sourceRef: 'apify/instagram-scraper',
    title: 'Instagram Scraper',
    description: 'd',
    mode: 'public_data',
    judge: {
      capabilityMatch: 3,
      inputSupplyable: 'yes',
      outputCovers: 'yes',
      shapeMatch: true,
      reason: 'monitors public posts by search term',
    },
    route: 'blueprint',
    evidence: null,
    finalScore: 2.4,
    ...overrides,
  };
}

describe('deriveCapabilitySpecs', () => {
  it('yields public_data specs for competitor-monitoring intent', () => {
    const specs = deriveCapabilitySpecs(
      'Competitor Analyst',
      'Monitor competitor instagram posts',
      ['instagram'],
      't-1',
    );
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({
      targetSystem: 'instagram',
      mode: 'public_data',
      operation: 'monitor',
    });
  });

  it('yields NOTHING for own-account intent — prior art is a public-data concept', () => {
    expect(
      deriveCapabilitySpecs('Assistant', 'Triage my inbox and draft replies', ['google_mail'], 't-1'),
    ).toEqual([]);
  });

  it('caps at three target systems', () => {
    const specs = deriveCapabilitySpecs(
      'Analyst',
      'competitor research across instagram tiktok linkedin youtube reddit',
      [],
      't-1',
    );
    expect(specs.length).toBeLessThanOrEqual(3);
  });

  it('does not fire on a substring — "marketing" must not match the "market" cue', () => {
    // Real false positive: an own-account PMM coordinating launches in Google
    // Docs/Jira/Slack derived a public_data spec because "market" matched
    // "marketing". Word-boundary matching keeps it own-account (empty).
    const specs = deriveCapabilitySpecs(
      'Product Marketing Manager',
      'Coordinate launches in Google Docs and Jira, track approvals in Slack, assemble readiness decks.',
      ['google_docs'],
      't-1',
    );
    expect(specs).toEqual([]);
  });

  it('derives the entity from the text, not the operation default of "posts"', () => {
    // "competitor news" → news (a concrete, retrievable entity), not the
    // monitor-pattern default 'posts'.
    const news = deriveCapabilitySpecs('Competitive Intelligence Analyst', 'Monitor competitor news across the market', [], 't-1');
    expect(news[0]).toMatchObject({ operation: 'monitor', entity: 'news', mode: 'public_data' });

    // A competitor-only intent with no concrete deliverable noun falls to the
    // competitor entity, still not 'posts'.
    const rivals = deriveCapabilitySpecs('Analyst', 'Track what competitors and rivals are doing publicly', [], 't-1');
    expect(rivals[0]?.entity).toBe('competitor activity');

    const reviews = deriveCapabilitySpecs('Reputation Analyst', 'Track public reviews and ratings of a product', [], 't-1');
    expect(reviews[0]?.entity).toBe('reviews');
  });
});

describe('buildPriorArtSection', () => {
  it('returns empty string for null, empty, and candidate-less results', () => {
    expect(buildPriorArtSection(null)).toBe('');
    expect(buildPriorArtSection([])).toBe('');
    const empty: DiscoveryResult = {
      spec: {
        targetSystem: 'instagram', operation: 'monitor', entity: 'posts',
        mode: 'public_data', availableInputs: [], requiredOutputFields: [],
        tenantId: 't-1', boundConnectorTypes: [],
      },
      candidates: [],
      degraded: true,
    };
    expect(buildPriorArtSection([empty])).toBe('');
  });

  it('renders a store actor the platform can run as a capability, without its procedure', () => {
    // The procedure's stages read as a how-to, and a distiller that follows
    // them re-implements a feed pull as a web search.
    process.env.APIFY_PLATFORM_TOKEN = 'apify_platform_test_token';
    try {
      const result: DiscoveryResult = {
        spec: {
          targetSystem: 'reddit', operation: 'pull', entity: 'posts',
          mode: 'public_data', availableInputs: [], requiredOutputFields: [],
          tenantId: 't-1', boundConnectorTypes: [],
        },
        candidates: [scored({ blueprintProcedureMd: '### Stages\n1. request the feed\n2. page through results' })],
        degraded: false,
      };
      const body = buildPriorArtSection([result]);
      expect(body).toContain('[capability] Instagram Scraper: monitors public posts by search term (runs at a type=capability step)');
      expect(body).not.toContain('[blueprint]');
      expect(body).not.toContain('request the feed');
    } finally {
      delete process.env.APIFY_PLATFORM_TOKEN;
    }
  });

  it('renders route, title, judge reason and blueprint lines', () => {
    delete process.env.APIFY_PLATFORM_TOKEN;
    const result: DiscoveryResult = {
      spec: {
        targetSystem: 'instagram', operation: 'monitor', entity: 'posts',
        mode: 'public_data', availableInputs: [], requiredOutputFields: [],
        tenantId: 't-1', boundConnectorTypes: [],
      },
      candidates: [scored({ blueprintProcedureMd: 'step 1: search by handle' })],
      degraded: false,
    };
    const body = buildPriorArtSection([result]);
    expect(body).toContain('[blueprint] Instagram Scraper');
    expect(body).toContain('monitors public posts by search term');
    expect(body).toContain('step 1: search by handle');
    // The header is the caller's to render OUTSIDE the fence, never in the body.
    expect(body).not.toContain(PRIOR_ART_HEADER.slice(0, 20));
  });
});

describe('fingerprint keys on the prior-art section', () => {
  it('changes when the section content changes and only then', () => {
    const without = computeFingerprint(BASE_INPUT, 'cat-hash', '');
    const emptySection = computeFingerprint(BASE_INPUT, 'cat-hash', computePriorArtHash(''));
    const withArt = computeFingerprint(BASE_INPUT, 'cat-hash', computePriorArtHash('PRIOR ART...'));
    const withOtherArt = computeFingerprint(BASE_INPUT, 'cat-hash', computePriorArtHash('PRIOR ART v2'));
    expect(emptySection).toBe(without);
    expect(withArt).not.toBe(without);
    expect(withArt).not.toBe(withOtherArt);
  });
});

describe('capabilitySpecsSourceHash', () => {
  it('is stable for the same role text and changes when it changes', () => {
    const a = capabilitySpecsSourceHash('Analyst', 'monitor news', ['gmail']);
    expect(capabilitySpecsSourceHash('Analyst', 'monitor news', ['gmail'])).toBe(a);
    expect(capabilitySpecsSourceHash('Analyst', 'monitor REVIEWS', ['gmail'])).not.toBe(a);
  });
  it('is order-insensitive in integrations', () => {
    expect(capabilitySpecsSourceHash('r', 'x', ['a', 'b'])).toBe(capabilitySpecsSourceHash('r', 'x', ['b', 'a']));
  });
});

describe('deriveCapabilitySpecsLLM', () => {
  beforeEach(() => mockComplete.mockReset());

  it('parses structured specs and stamps tenant + bound connectors', async () => {
    mockComplete.mockResolvedValue({
      content: JSON.stringify({
        specs: [
          { operation: 'monitor', entity: 'news headlines', targetSystem: 'X', availableInputs: ['topic'], requiredOutputFields: ['headline', 'url'] },
          { operation: 'get', entity: 'stock quote' },
        ],
      }),
    });
    const specs = await deriveCapabilitySpecsLLM('Analyst', 'watch the market', ['nasdaq'], 't-9');
    expect(specs).toHaveLength(2);
    expect(specs[0]).toMatchObject({ operation: 'monitor', entity: 'news headlines', targetSystem: 'x', mode: 'public_data', tenantId: 't-9', boundConnectorTypes: ['nasdaq'] });
    expect(specs[0].availableInputs).toEqual(['topic']);
    // Missing arrays fall back to sane defaults, not empties.
    expect(specs[1].availableInputs).toEqual(['search_terms']);
    expect(specs[1]).not.toHaveProperty('targetSystem');
  });

  it('returns an empty list as a REAL answer (own-account role), not a fallback', async () => {
    mockComplete.mockResolvedValue({ content: JSON.stringify({ specs: [] }) });
    const specs = await deriveCapabilitySpecsLLM('Coordinator', 'send launch emails from our mailbox', [], 't-9');
    expect(specs).toEqual([]);
  });

  it('falls back to the keyword heuristic when the LLM throws', async () => {
    mockComplete.mockRejectedValue(new Error('relay down'));
    const specs = await deriveCapabilitySpecsLLM('Competitor Analyst', 'monitor competitor instagram posts', ['gmail'], 't-9');
    const heuristic = deriveCapabilitySpecs('Competitor Analyst', 'monitor competitor instagram posts', ['gmail'], 't-9');
    expect(specs).toEqual(heuristic);
    expect(specs.length).toBeGreaterThan(0);
  });

  it('falls back to the heuristic when the response is not valid JSON', async () => {
    mockComplete.mockResolvedValue({ content: 'not json' });
    const specs = await deriveCapabilitySpecsLLM('Competitor Analyst', 'monitor competitor instagram posts', [], 't-9');
    expect(specs).toEqual(deriveCapabilitySpecs('Competitor Analyst', 'monitor competitor instagram posts', [], 't-9'));
  });
});

// The one case a web search is mistaken for cover: records on a named
// platform. Every place the distiller is told when a capability step is the
// right step carries the same sentence.
describe('platform records are a capability need', () => {
  it('is stated in the prior-art header', () => {
    expect(PRIOR_ART_HEADER).toContain('A web search does NOT cover records that live on a named platform');
    expect(PRIOR_ART_HEADER).toContain('the step is type=capability');
  });
});
