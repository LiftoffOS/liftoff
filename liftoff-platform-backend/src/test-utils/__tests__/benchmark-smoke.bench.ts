// Harness smoke benchmark. Phase 1 / Phase 3 will add the real
// governance.authorize (p95 < 3ms, p99 < 10ms) and connector.execute
// (p95 < 20ms, p99 < 50ms) benchmarks next to the service clients.

import { benchmark } from '../benchmark.js';

describe('benchmark harness', () => {
  it('computes percentiles and respects budgets', async () => {
    const report = await benchmark({
      name: 'harness.smoke.fast',
      iterations: 200,
      warmup: 10,
      budgets: { p95: 5, p99: 10 },
      run: () => {
        // Intentionally trivial — exercises the timing path without
        // introducing real-world noise.
        let sum = 0;
        for (let i = 0; i < 100; i++) sum += i;
        if (sum < 0) throw new Error('never');
      },
    });

    expect(report.iterations).toBe(200);
    expect(report.p95).toBeGreaterThan(0);
    expect(report.p99).toBeGreaterThanOrEqual(report.p95);
    expect(report.max).toBeGreaterThanOrEqual(report.p99);
  });

  it('throws when a budget is breached', async () => {
    await expect(
      benchmark({
        name: 'harness.smoke.breach',
        iterations: 50,
        warmup: 5,
        // Set impossibly tight budgets — expect failure.
        budgets: { p50: 0.0000001 },
        run: async () => {
          await new Promise((r) => setTimeout(r, 1));
        },
      }),
    ).rejects.toThrow(/exceeded latency budget/);
  });
});
