// Change B regression: at W_INFLUENCE=0, an old memory with low influence ranks
// identically to an old memory with high influence (no decay path exists).

describe('scoreMemory no-decay invariant', () => {
  it('influence has zero effect when W_INFLUENCE=0', () => {
    delete process.env.MEM_WEIGHT_INFLUENCE;
    jest.resetModules();
    const { scoreMemory } = require('../service');
    const now = Date.now();
    const olderDate = new Date(now - 60 * 86_400_000); // 60 days old
    const base = { similarity: 0.5, usefulnessScore: 0, importanceScore: 3, createdAt: olderDate, tags: [] };
    const high = scoreMemory({ ...base, influenceScore: 0.99 }, now, []);
    const low = scoreMemory({ ...base, influenceScore: 0.01 }, now, []);
    expect(high).toBeCloseTo(low, 10);
  });
});
