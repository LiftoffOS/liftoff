import { recallAtK, mrr, ndcgAtK, scoreEvent } from '../metrics';

describe('recallAtK', () => {
  it('returns 1 when all cited are within top-K', () => {
    expect(recallAtK(['a', 'b', 'c'], new Set(['a', 'b']), 5)).toBe(1);
  });
  it('returns the hit ratio for partial coverage', () => {
    expect(recallAtK(['a', 'x', 'y'], new Set(['a', 'b']), 5)).toBe(0.5);
  });
  it('returns 0 on empty cited', () => {
    expect(recallAtK(['a'], new Set(), 5)).toBe(0);
  });
  it('respects k', () => {
    expect(recallAtK(['x', 'y', 'a'], new Set(['a']), 2)).toBe(0);
    expect(recallAtK(['x', 'y', 'a'], new Set(['a']), 3)).toBe(1);
  });
});

describe('mrr', () => {
  it('rank-1 hit → 1', () => {
    expect(mrr(['a'], new Set(['a']))).toBe(1);
  });
  it('rank-2 hit → 0.5', () => {
    expect(mrr(['x', 'a'], new Set(['a']))).toBeCloseTo(0.5);
  });
  it('no hit → 0', () => {
    expect(mrr(['x'], new Set(['a']))).toBe(0);
  });
});

describe('ndcgAtK', () => {
  it('single hit at rank 1 = 1.0', () => {
    expect(ndcgAtK(['a'], new Set(['a']), 10)).toBe(1);
  });
  it('hit at rank 2 < hit at rank 1', () => {
    expect(ndcgAtK(['a', 'x'], new Set(['a']), 10))
      .toBeGreaterThan(ndcgAtK(['x', 'a'], new Set(['a']), 10));
  });
  it('multiple cites — rank-1 + rank-3 > rank-2 + rank-3', () => {
    const a = ndcgAtK(['a', 'x', 'b'], new Set(['a', 'b']), 10);
    const c = ndcgAtK(['x', 'a', 'b'], new Set(['a', 'b']), 10);
    expect(a).toBeGreaterThan(c);
  });
});

describe('scoreEvent', () => {
  it('returns all four metrics', () => {
    const s = scoreEvent(['a', 'b'], ['a']);
    expect(s.recallAt5).toBe(1);
    expect(s.recallAt10).toBe(1);
    expect(s.mrr).toBe(1);
    expect(s.ndcgAt10).toBe(1);
  });
  it('handles empty cited as all zeros', () => {
    const s = scoreEvent(['a'], []);
    expect(s.recallAt5).toBe(0);
    expect(s.mrr).toBe(0);
    expect(s.ndcgAt10).toBe(0);
  });
});
