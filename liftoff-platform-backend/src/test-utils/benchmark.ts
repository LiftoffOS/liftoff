// Latency benchmark utilities (Phase 0c).
//
// Runs a synchronous or async function N times and reports p50/p95/p99
// latency in milliseconds. Fails the test when any configured percentile
// exceeds its budget. Used by CI to catch per-RPC latency regressions
// the moment they land.
//
// Usage:
//   await benchmark({
//     name: 'governance.authorize',
//     iterations: 1000,
//     warmup: 50,
//     budgets: { p95: 3, p99: 10 },
//     run: async () => { await client.authorize(req); },
//   });

import { performance } from 'node:perf_hooks';

export interface BenchmarkBudgets {
  p50?: number;
  p95?: number;
  p99?: number;
  max?: number;
}

export interface BenchmarkOptions {
  /** Label used in the report. */
  name: string;
  /** Number of timed iterations. Default 1000. */
  iterations?: number;
  /** Untimed warmup iterations. Default 50. */
  warmup?: number;
  /** Budgets in milliseconds. Missing keys are skipped. */
  budgets: BenchmarkBudgets;
  /** Work to time. May be async. */
  run: () => void | Promise<void>;
}

export interface BenchmarkReport {
  name: string;
  iterations: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.floor((p / 100) * sortedAsc.length),
  );
  return sortedAsc[idx];
}

export async function benchmark(opts: BenchmarkOptions): Promise<BenchmarkReport> {
  const iterations = opts.iterations ?? 1000;
  const warmup = opts.warmup ?? 50;

  for (let i = 0; i < warmup; i++) await opts.run();

  const samples: number[] = new Array(iterations);
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await opts.run();
    samples[i] = performance.now() - start;
  }

  samples.sort((a, b) => a - b);
  const report: BenchmarkReport = {
    name: opts.name,
    iterations,
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
    p99: percentile(samples, 99),
    max: samples[samples.length - 1],
    mean: samples.reduce((sum, s) => sum + s, 0) / samples.length,
  };

  // Emit a deterministic line CI can parse into metrics.
  console.log(
    JSON.stringify({
      benchmark: report.name,
      iterations,
      p50_ms: +report.p50.toFixed(3),
      p95_ms: +report.p95.toFixed(3),
      p99_ms: +report.p99.toFixed(3),
      max_ms: +report.max.toFixed(3),
      mean_ms: +report.mean.toFixed(3),
    }),
  );

  // Assert budgets — failure aborts the test (use --bail in CI to stop
  // the whole benchmark run on the first breach).
  const breaches: string[] = [];
  if (opts.budgets.p50 !== undefined && report.p50 > opts.budgets.p50) {
    breaches.push(`p50 ${report.p50.toFixed(2)}ms > ${opts.budgets.p50}ms`);
  }
  if (opts.budgets.p95 !== undefined && report.p95 > opts.budgets.p95) {
    breaches.push(`p95 ${report.p95.toFixed(2)}ms > ${opts.budgets.p95}ms`);
  }
  if (opts.budgets.p99 !== undefined && report.p99 > opts.budgets.p99) {
    breaches.push(`p99 ${report.p99.toFixed(2)}ms > ${opts.budgets.p99}ms`);
  }
  if (opts.budgets.max !== undefined && report.max > opts.budgets.max) {
    breaches.push(`max ${report.max.toFixed(2)}ms > ${opts.budgets.max}ms`);
  }
  if (breaches.length > 0) {
    throw new Error(
      `benchmark "${opts.name}" exceeded latency budget(s): ${breaches.join('; ')}`,
    );
  }

  return report;
}
