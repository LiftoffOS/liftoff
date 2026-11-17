// Snapshot — asserts the refactor in PR-7 doesn't change scoreMemory
// outputs under DEFAULT_WEIGHTS. The snapshot was captured against the
// pre-refactor scoreMemory and committed alongside PR-7; if the
// refactor introduced a numeric drift, this test breaks.

import { DEFAULT_WEIGHTS, __resetEnvWeightsCacheForTests } from '../ranking-config';
import { scoreMemory } from '../service';

beforeEach(() => __resetEnvWeightsCacheForTests());

const NOW = new Date('2026-06-09T00:00:00Z').getTime();
const DAY = 86_400_000;

interface Fixture {
  label: string;
  m: Parameters<typeof scoreMemory>[0];
  contextTags: string[];
}

const FIXTURES: Fixture[] = [
  {
    label: 'fresh-no-tags',
    m: {
      similarity: 0.7, usefulnessScore: 0, importanceScore: 3,
      createdAt: new Date(NOW), tags: [],
      sourceTrust: 0.5, influenceScore: 0.5, summaryLevel: 0,
    },
    contextTags: [],
  },
  {
    label: 'fresh-gotcha-matched-tag',
    m: {
      similarity: 0.65, usefulnessScore: 5, importanceScore: 4,
      createdAt: new Date(NOW), tags: ['type:gotcha', 'connector:google-sheets'],
      sourceTrust: 0.8, influenceScore: 0.5, summaryLevel: 0,
    },
    contextTags: ['connector:google-sheets'],
  },
  {
    label: 'old-decision-no-overlap',
    m: {
      similarity: 0.5, usefulnessScore: 20, importanceScore: 4,
      createdAt: new Date(NOW - 60 * DAY), tags: ['type:decision'],
      sourceTrust: 0.7, influenceScore: 0.6, summaryLevel: 0,
    },
    contextTags: ['connector:hubspot'],
  },
  {
    label: 'summary-l1',
    m: {
      similarity: 0.55, usefulnessScore: 10, importanceScore: 3,
      createdAt: new Date(NOW - 7 * DAY), tags: ['summary-l1'],
      sourceTrust: 0.5, influenceScore: 0.5, summaryLevel: 1,
    },
    contextTags: [],
  },
  {
    label: 'low-trust-feedback',
    m: {
      similarity: 0.6, usefulnessScore: 50, importanceScore: 5,
      createdAt: new Date(NOW), tags: ['type:preference'],
      sourceTrust: 0.2, influenceScore: 0.5, summaryLevel: 0,
    },
    contextTags: [],
  },
  {
    label: 'high-influence-zero-W_INFLUENCE',
    m: {
      similarity: 0.6, usefulnessScore: 0, importanceScore: 3,
      createdAt: new Date(NOW - 10 * DAY), tags: [],
      sourceTrust: 0.5, influenceScore: 0.99, summaryLevel: 0,
    },
    contextTags: [],
  },
  {
    label: 'negative-usefulness',
    m: {
      similarity: 0.4, usefulnessScore: -5, importanceScore: 2,
      createdAt: new Date(NOW - 14 * DAY), tags: [],
      sourceTrust: 0.5, influenceScore: 0.5, summaryLevel: 0,
    },
    contextTags: [],
  },
];

describe('scoreMemory baseline under DEFAULT_WEIGHTS', () => {
  it('matches the captured snapshot', () => {
    const out = FIXTURES.map(f => ({
      label: f.label,
      score: scoreMemory(f.m, NOW, f.contextTags),
    }));
    expect(out).toMatchSnapshot();
  });
});

describe('alternate weights shift the ranking', () => {
  it('wRecency=0 lowers score on old memories (recency was still contributing)', () => {
    const old = FIXTURES.find(f => f.label === 'old-decision-no-overlap')!;
    const base = scoreMemory(old.m, NOW, old.contextTags);
    const noRecency = scoreMemory(old.m, NOW, old.contextTags,
      { ...DEFAULT_WEIGHTS, wRecency: 0 });
    // recencyScore is 1/(1+60*0.02) ≈ 0.455; removing its 0.20 weight
    // subtracts ~0.091 from the composite. Net: score drops.
    expect(noRecency).toBeLessThan(base);
  });

  it('wSemantic=0 lowers score on high-similarity rows', () => {
    const fresh = FIXTURES.find(f => f.label === 'fresh-no-tags')!;
    const base = scoreMemory(fresh.m, NOW, fresh.contextTags);
    const noSem = scoreMemory(fresh.m, NOW, fresh.contextTags,
      { ...DEFAULT_WEIGHTS, wSemantic: 0 });
    expect(noSem).toBeLessThan(base);
  });

  it('wInfluence>0 raises score on high-influence rows', () => {
    const hi = FIXTURES.find(f => f.label === 'high-influence-zero-W_INFLUENCE')!;
    const base = scoreMemory(hi.m, NOW, hi.contextTags);
    const withInf = scoreMemory(hi.m, NOW, hi.contextTags,
      { ...DEFAULT_WEIGHTS, wInfluence: 0.5 });
    expect(withInf).toBeGreaterThan(base);
  });
});
