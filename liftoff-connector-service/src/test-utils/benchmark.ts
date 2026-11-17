// Tiny latency benchmark harness.
//
// Used by the Phase 1 CI budget tests in `src/__benchmark__/*.bench.test.ts`
// to assert p95 / p99 ceilings for the ConnectorService RPC hop. Intentionally
// dependency-free:
//   - `measureLatencies` runs `fn` N times and returns sorted percentiles
//     (p50 / p95 / p99 / min / max), all in milliseconds.
//   - `assertLatency` checks a measurement against a budget and throws an
//     Error whose message lists every breach (so a single benchmark failure
//     surfaces every regression, not just the first one).
//
// We use `process.hrtime.bigint()` for sub-microsecond resolution rather
// than `performance.now()` or `Date.now()`. The bigint diff is converted
// to ms via `Number(diff) / 1_000_000` — safe for any latency under 2^53 ns
// (~104 days), which is comfortably above any budget we care about.
//
// Percentiles are computed over the raw iteration array using the simple
// "nearest rank" method on a sorted copy. Good enough for 1k+ samples; we
// are not trying to be HdrHistogram.

export interface LatencyStats {
  /** Number of iterations the measurement was taken over. */
  iterations: number;
  /** Minimum observed latency, in ms. */
  min: number;
  /** Maximum observed latency, in ms. */
  max: number;
  /** 50th percentile (median), in ms. */
  p50: number;
  /** 95th percentile, in ms. */
  p95: number;
  /** 99th percentile, in ms. */
  p99: number;
}

export interface MeasureOptions {
  /** Number of iterations to run. Must be ≥ 1. */
  iterations: number;
  /** Async work to measure. Any thrown error aborts the run. */
  fn: () => Promise<unknown>;
  /** Optional warmup iterations that are NOT counted in the stats. */
  warmup?: number;
  /** Drop the slowest fraction of samples (0..0.5) before percentiles — kills single-GC-pause tail sensitivity on shared CI VMs. */
  trimTopFraction?: number;
}

/**
 * Run `fn` `iterations` times and return sorted-array percentile stats.
 * Each iteration is timed with `process.hrtime.bigint()` for precision.
 * All returned numbers are in milliseconds.
 */
export async function measureLatencies(opts: MeasureOptions): Promise<LatencyStats> {
  const { iterations, fn } = opts;
  if (!Number.isFinite(iterations) || iterations < 1) {
    throw new Error(`measureLatencies: iterations must be ≥ 1, got ${iterations}`);
  }

  const warmup = opts.warmup ?? 0;
  for (let i = 0; i < warmup; i += 1) {
    await fn();
  }

  // Preallocate — avoids array-grow costs polluting the tail.
  const samples = new Array<number>(iterations);
  for (let i = 0; i < iterations; i += 1) {
    const t0 = process.hrtime.bigint();
    await fn();
    const t1 = process.hrtime.bigint();
    samples[i] = Number(t1 - t0) / 1_000_000;
  }

  // Optionally drop the slowest fraction before summarizing. On shared 2-vCPU CI
  // VMs a single GC pause / scheduler preemption lands in the tail; trimming the
  // top ~1% removes that one-off sensitivity without hiding a real regression
  // (a regression shifts the whole distribution, not one sample).
  const trim = opts.trimTopFraction ?? 0;
  if (trim > 0 && trim < 0.5) {
    const sorted = [...samples].sort((a, b) => a - b);
    const keep = Math.max(1, Math.floor(sorted.length * (1 - trim)));
    return summarize(sorted.slice(0, keep));
  }
  return summarize(samples);
}

/** Summarize a flat array of ms latencies into percentile stats. */
export function summarize(samples: number[]): LatencyStats {
  if (samples.length === 0) {
    throw new Error('summarize: samples array must be non-empty');
  }
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    iterations: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
  };
}

/**
 * Nearest-rank percentile on a pre-sorted array.
 * For q=0.95 and N=1000, returns sorted[ceil(0.95*1000) - 1] = sorted[949].
 */
function percentile(sorted: number[], q: number): number {
  if (q <= 0) return sorted[0];
  if (q >= 1) return sorted[sorted.length - 1];
  const rank = Math.ceil(q * sorted.length);
  const idx = Math.max(0, Math.min(sorted.length - 1, rank - 1));
  return sorted[idx];
}

export interface LatencyBudget {
  /** Fail if measured value (ms) is strictly greater than this max. */
  max: number;
}

export interface LatencyAssertion {
  min?: LatencyBudget;
  p50?: LatencyBudget;
  p95?: LatencyBudget;
  p99?: LatencyBudget;
  max?: LatencyBudget;
}

/**
 * Throw an Error if `stats` breach any of the provided budgets.
 * The error message lists EVERY breach, not just the first, so a single
 * failing CI run points at every regression at once.
 *
 * Example:
 *   assertLatency(stats, { p95: { max: 20 }, p99: { max: 50 } }, 'Execute RPC');
 */
export function assertLatency(
  stats: LatencyStats,
  budget: LatencyAssertion,
  label = 'latency',
): void {
  const breaches: string[] = [];
  const check = (name: keyof LatencyAssertion, observed: number): void => {
    const b = budget[name];
    if (b && observed > b.max) {
      breaches.push(`${name}=${observed.toFixed(3)}ms > ${b.max}ms`);
    }
  };
  check('min', stats.min);
  check('p50', stats.p50);
  check('p95', stats.p95);
  check('p99', stats.p99);
  check('max', stats.max);

  if (breaches.length > 0) {
    throw new Error(
      `${label}: latency budget breached over ${stats.iterations} iterations — ` +
        breaches.join(', '),
    );
  }
}

export interface RatioBudget {
  /** measured.p95 must be ≤ ratioMax × baseline.p95. VM speed + scheduler/GC jitter hit
   *  both the measured hop and the baseline round-trip, so the ratio cancels the environment
   *  and isolates the code path's own overhead — the robust way to gate on a noisy shared CI VM. */
  ratioMax: number;
  /** Loose ABSOLUTE ceilings (ms), well above the noise floor, purely to catch catastrophic
   *  breakage (e.g. a hang) that a ratio alone might miss if the baseline also blew up. */
  absP95Max?: number;
  absP99Max?: number;
}

/**
 * Ratio-based latency gate. Asserts `measured.p95 ≤ ratioMax × baseline.p95` (plus optional
 * loose absolute ceilings), where `baseline` is a lighter operation measured in the SAME run
 * (e.g. a bare loopback round-trip). This cancels VM speed and shared-runner jitter, so the
 * gate fails only on a genuine regression in the measured path — not on CI-VM noise. Returns
 * the observed ratio so the caller can log it (and tighten ratioMax over time from real data).
 */
export function assertLatencyRatio(
  measured: LatencyStats,
  baseline: LatencyStats,
  budget: RatioBudget,
  label = 'latency',
): { ratio: number } {
  const ratio = baseline.p95 > 0 ? measured.p95 / baseline.p95 : Infinity;
  const breaches: string[] = [];
  if (ratio > budget.ratioMax) {
    breaches.push(
      `p95 ratio=${ratio.toFixed(2)}× baseline (${measured.p95.toFixed(3)}ms / ${baseline.p95.toFixed(3)}ms) > ${budget.ratioMax}×`,
    );
  }
  if (budget.absP95Max != null && measured.p95 > budget.absP95Max) {
    breaches.push(`p95=${measured.p95.toFixed(3)}ms > ${budget.absP95Max}ms (abs ceiling)`);
  }
  if (budget.absP99Max != null && measured.p99 > budget.absP99Max) {
    breaches.push(`p99=${measured.p99.toFixed(3)}ms > ${budget.absP99Max}ms (abs ceiling)`);
  }
  if (breaches.length > 0) {
    throw new Error(
      `${label}: latency budget breached over ${measured.iterations} iterations — ` + breaches.join(', '),
    );
  }
  return { ratio };
}

/** Convenience: format stats for human-readable test output. */
export function formatStats(label: string, stats: LatencyStats): string {
  return (
    `${label} (n=${stats.iterations}): ` +
    `min=${stats.min.toFixed(3)}ms ` +
    `p50=${stats.p50.toFixed(3)}ms ` +
    `p95=${stats.p95.toFixed(3)}ms ` +
    `p99=${stats.p99.toFixed(3)}ms ` +
    `max=${stats.max.toFixed(3)}ms`
  );
}
