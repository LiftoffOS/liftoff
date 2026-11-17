// Tiny latency benchmark harness for governance-engine.
//
// Ported from liftoff-connector-service's equivalent helper. Used by the
// Phase 3 CI budget tests in `src/__benchmark__/*.bench.test.ts` to assert
// p95 / p99 ceilings for the GovernanceService RPC hop. Intentionally
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
// (~104 days).
//
// Percentiles are computed over the raw iteration array using the simple
// "nearest rank" method on a sorted copy. Good enough for 1k+ samples.

export interface LatencyStats {
  iterations: number;
  min: number;
  max: number;
  p50: number;
  p95: number;
  p99: number;
}

export interface MeasureOptions {
  iterations: number;
  fn: () => Promise<unknown>;
  warmup?: number;
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

  const samples = new Array<number>(iterations);
  for (let i = 0; i < iterations; i += 1) {
    const t0 = process.hrtime.bigint();
    await fn();
    const t1 = process.hrtime.bigint();
    samples[i] = Number(t1 - t0) / 1_000_000;
  }

  return summarize(samples);
}

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
