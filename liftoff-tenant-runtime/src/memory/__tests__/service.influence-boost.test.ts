// Change B: with W_INFLUENCE=0.10, high-influence (0.9) outranks low-influence (0.1)
// at equal similarity. Uncited memories rank as well as today (no decay).

describe('scoreMemory influence boost', () => {
  beforeEach(() => {
    process.env.MEM_WEIGHT_INFLUENCE = '0.10';
    jest.resetModules();
  });
  afterEach(() => {
    delete process.env.MEM_WEIGHT_INFLUENCE;
    jest.resetModules();
  });

  it('cited memory (influence=0.9) outranks uncited (influence=0.1) at equal similarity', () => {
    jest.resetModules();
    const { scoreMemory } = require('../service');
    const now = Date.now();
    const base = { similarity: 0.5, usefulnessScore: 0, importanceScore: 3, createdAt: new Date(now), tags: [] };
    const high = scoreMemory({ ...base, influenceScore: 0.9 }, now, []);
    const low = scoreMemory({ ...base, influenceScore: 0.1 }, now, []);
    expect(high).toBeGreaterThan(low);
  });
});
