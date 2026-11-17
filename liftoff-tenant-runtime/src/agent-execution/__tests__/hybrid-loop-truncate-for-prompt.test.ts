// Unit tests for the JSON-aware shape-preserving truncator used by the
// hybrid execution engine's recovery prompts (D13).

import { truncateForPrompt } from '../engine/truncate-for-prompt';

describe('truncateForPrompt', () => {
  it('returns full value when under budget', () => {
    expect(truncateForPrompt({ k: 1 }, 200)).toBe('{"k":1}');
  });

  it('shrinks long strings preserving suffix marker', () => {
    const out = truncateForPrompt('x'.repeat(1000), 400);
    expect(out).toContain('truncated:');
    expect(out.length).toBeLessThanOrEqual(400);
  });

  it('shrinks large arrays preserving suffix marker', () => {
    const arr = Array.from({ length: 50 }, (_, i) => ({ i }));
    const out = truncateForPrompt(arr, 400);
    expect(out).toContain('more items truncated');
  });

  it('shrinks wide objects preserving suffix marker', () => {
    const wide: Record<string, number> = {};
    for (let i = 0; i < 50; i++) wide[`k${i}`] = i;
    const out = truncateForPrompt(wide, 400);
    expect(out).toContain('more keys truncated');
  });

  it('survives unserializable values (returns safe placeholder)', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const out = truncateForPrompt(cyclic, 200);
    expect(typeof out).toBe('string');
  });

  it('respects maxBytes hard cap via final fallback', () => {
    const deeplyNested = Array.from({ length: 500 }, (_, i) => 'x'.repeat(50));
    const out = truncateForPrompt(deeplyNested, 100);
    expect(out.length).toBeLessThanOrEqual(100);
  });
});
