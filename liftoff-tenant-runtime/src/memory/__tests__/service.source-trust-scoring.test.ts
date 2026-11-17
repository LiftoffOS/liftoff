// Change D: scoreMemory with sourceTrust multiplier.

describe('scoreMemory source-trust', () => {
  beforeEach(() => {
    process.env.MEM_WEIGHT_SOURCE_TRUST = '1.0';
    jest.resetModules();
  });
  afterEach(() => {
    delete process.env.MEM_WEIGHT_SOURCE_TRUST;
    jest.resetModules();
  });

  it('high source_trust (1.0) outranks low (0.4) at equal usefulness', () => {
    jest.resetModules();
    const { scoreMemory } = require('../service');
    const now = Date.now();
    const base = {
      similarity: 0.5,
      usefulnessScore: 50,
      importanceScore: 5,
      createdAt: new Date(now),
      tags: [],
    };
    const high = scoreMemory({ ...base, sourceTrust: 1.0 }, now, []);
    const low = scoreMemory({ ...base, sourceTrust: 0.4 }, now, []);
    expect(high).toBeGreaterThan(low);
  });
});
