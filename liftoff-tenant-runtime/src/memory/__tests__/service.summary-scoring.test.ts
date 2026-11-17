// Change C: L1 summary outranks L0 of equal similarity by W_SUMMARY.

describe('scoreMemory summary boost', () => {
  beforeEach(() => {
    process.env.MEM_WEIGHT_SUMMARY = '0.05';
    jest.resetModules();
  });
  afterEach(() => {
    delete process.env.MEM_WEIGHT_SUMMARY;
    jest.resetModules();
  });

  it('summary_level=1 outranks summary_level=0 at equal similarity', () => {
    jest.resetModules();
    const { scoreMemory } = require('../service');
    const now = Date.now();
    const base = { similarity: 0.5, usefulnessScore: 0, importanceScore: 3, createdAt: new Date(now), tags: [] };
    const summary = scoreMemory({ ...base, summaryLevel: 1 }, now, []);
    const raw = scoreMemory({ ...base, summaryLevel: 0 }, now, []);
    expect(summary).toBeGreaterThan(raw);
  });
});
