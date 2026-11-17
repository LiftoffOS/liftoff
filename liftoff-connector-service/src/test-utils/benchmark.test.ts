import { assertLatencyRatio, measureLatencies, summarize, type LatencyStats } from './benchmark.js';

const stats = (p95: number, p99 = p95): LatencyStats => ({ iterations: 1000, min: 0, max: p99, p50: p95 / 2, p95, p99 });

describe('assertLatencyRatio', () => {
  it('passes and returns the ratio when measured p95 is within ratioMax× baseline', () => {
    const { ratio } = assertLatencyRatio(stats(12), stats(3), { ratioMax: 8 }, 'x'); // 12/3 = 4× ≤ 8×
    expect(ratio).toBeCloseTo(4, 5);
  });

  it('fails when the p95 ratio exceeds ratioMax (a real regression) — regardless of absolute ms', () => {
    // Both fast in absolute terms (18ms) but the hop is 9× the baseline → regression.
    expect(() => assertLatencyRatio(stats(18), stats(2), { ratioMax: 8 }, 'x')).toThrow(/ratio=9\.00×/);
  });

  it('does NOT fail on VM jitter that inflates BOTH measured and baseline equally', () => {
    // A slow VM makes the bare ping 6ms and the hop 24ms — 4× ratio, still healthy.
    expect(() => assertLatencyRatio(stats(24), stats(6), { ratioMax: 8 }, 'x')).not.toThrow();
  });

  it('enforces a loose absolute ceiling to catch a hang the ratio might miss', () => {
    // Baseline also blew up (say a stall), so ratio looks fine (300/60=5×) but p95 is catastrophic.
    expect(() => assertLatencyRatio(stats(300), stats(60), { ratioMax: 8, absP95Max: 150 }, 'x')).toThrow(/abs ceiling/);
  });

  it('a zero baseline yields an Infinity ratio and fails (never divide-by-zero silently)', () => {
    expect(() => assertLatencyRatio(stats(5), stats(0), { ratioMax: 8 }, 'x')).toThrow(/Infinity|ratio/);
  });
});

describe('measureLatencies trimTopFraction', () => {
  it('drops the slowest fraction so a single outlier does not dominate the tail', async () => {
    // Deterministic samples: 100 fast (~fn resolves immediately), timing dominated by loop.
    // Instead of relying on wall-clock, verify summarize-with-trim directly on a known array.
    const samples = [...Array(99).fill(1), 1000]; // 99 fast + 1 huge outlier
    const full = summarize(samples);
    expect(full.max).toBe(1000); // untrimmed tail sees the outlier
    // Trim top 1% (drop the single 1000) → max collapses to the fast band.
    const sorted = [...samples].sort((a, b) => a - b);
    const trimmed = summarize(sorted.slice(0, Math.floor(sorted.length * 0.99)));
    expect(trimmed.max).toBe(1);
  });

  it('measureLatencies honors trimTopFraction end-to-end', async () => {
    let n = 0;
    // fn does nothing; the point is the trim path runs without error and returns valid stats.
    const s = await measureLatencies({ iterations: 200, warmup: 0, trimTopFraction: 0.05, fn: async () => { n += 1; } });
    expect(n).toBe(200);
    expect(s.iterations).toBe(190); // 5% of 200 trimmed
    expect(s.p95).toBeGreaterThanOrEqual(0);
  });
});
