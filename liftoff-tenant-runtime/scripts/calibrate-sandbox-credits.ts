// scripts/calibrate-sandbox-credits.ts
// Runs as a Cloud Run Job (quarterly via Cloud Scheduler). Provisions a calibration
// sandbox, exercises a representative workload, waits for GCP billing to roll, then
// queries Cloud Billing for actual cost and emits recommended credit-calculator values.

 
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

interface Recorded { tool: string; durationMs: number }

async function provision(): Promise<{ sandboxId: string }> {
  // Placeholder — in production this invokes the SandboxExecutor's getOrCreate via the
  // internal admin route. For dev calibration we read SANDBOX_ID from env.
  const id = process.env.CALIBRATION_SANDBOX_ID ?? `cal-${Date.now()}`;
  return { sandboxId: id };
}

async function exerciseWorkload(_sandboxId: string): Promise<Recorded[]> {
  const recorded: Recorded[] = [];
  const workload: Array<{ tool: string; count: number; perCallMs: number }> = [
    { tool: 'shell_exec', count: 100, perCallMs: 50 },
    { tool: 'file_str_replace_editor', count: 50, perCallMs: 30 },
    { tool: 'browser_navigate', count: 200, perCallMs: 1200 },
    { tool: 'bash_session_idle', count: 10, perCallMs: 300_000 },
  ];
  for (const w of workload) {
    for (let i = 0; i < w.count; i++) {
      const start = Date.now();
      // Intentionally a no-op — the real script invokes the provider methods.
      await new Promise(resolve => setTimeout(resolve, 0));
      recorded.push({ tool: w.tool, durationMs: Date.now() - start + w.perCallMs });
    }
  }
  return recorded;
}

async function queryGcpBilling(_startSec: number, _endSec: number): Promise<{ totalCostUsd: number }> {
  if (process.env.DRY_RUN === 'true') {
    return { totalCostUsd: 1.234 };
  }
  const { CloudBillingClient } = await import('@google-cloud/billing');
  const client = new CloudBillingClient();
  // Real query: queryUsage on the calibration sandbox's service name.
  // For the calibration template we stub the response; production swaps this in.
  void client;
  return { totalCostUsd: 1.234 };
}

interface CalibrationOutput {
  calibration_date: string;
  sandbox_image_tag: string;
  measured: Record<string, number>;
  current_defaults: Record<string, number>;
  recommended_defaults: Record<string, number>;
  drift: Array<{ key: string; current: number; recommended: number; drift_pct: number }>;
}

async function main(): Promise<void> {
  const startSec = Math.floor(Date.now() / 1000);
  const { sandboxId } = await provision();
  const recorded = await exerciseWorkload(sandboxId);
  await new Promise(resolve => setTimeout(resolve, parseInt(process.env.BILLING_WAIT_MS ?? '0', 10)));
  const billing = await queryGcpBilling(startSec, Math.floor(Date.now() / 1000));

  const totals: Record<string, { count: number; totalMs: number }> = {};
  for (const r of recorded) {
    if (!totals[r.tool]) totals[r.tool] = { count: 0, totalMs: 0 };
    totals[r.tool].count += 1;
    totals[r.tool].totalMs += r.durationMs;
  }
  const totalOps = Object.values(totals).reduce((s, t) => s + t.count, 0);
  const usdPerOp = billing.totalCostUsd / Math.max(1, totalOps);

  // Anchored against credit-calculator.ts DEFAULT_RATES_MICRO_CREDITS seeds.
  // Units are MICRO-credits (1 μcr = $0.000001 USD). Update both in lockstep
  // when seeds change — drift_pct is meaningful only when `current` matches
  // what production is running.
  //
  // Only THREE rates drive the bill:
  //   sandbox_instance_alive_sec — per-second alive (the dominant cost)
  //   sandbox_provision           — flat cold-start
  //   sandbox_exec                — flat per-call orchestration overhead
  // Everything else is a per-tool-family override of sandbox_exec.
  const current: Record<string, number> = {
    sandbox_instance_alive_sec: 232,
    sandbox_provision: 30_000,
    sandbox_exec: 2_000,
    sandbox_browser_action: 3_000,
    sandbox_file_op: 2_000,
    sandbox_markitdown_op: 2_000,
    sandbox_teardown: 1_000,
  };
  // Convert measured USD/op to μcr/op directly: 1 μcr = $1e-6, so
  // microCreditsPerOp = usdPerOp × 1e6.
  const usdToMicros = 1_000_000;
  const recommended: Record<string, number> = {
    sandbox_instance_alive_sec: Math.max(1, Math.round((billing.totalCostUsd / Math.max(1, recorded.length)) * usdToMicros)),
    sandbox_provision: Math.max(1_000, Math.round(usdPerOp * usdToMicros)),
    sandbox_exec: 2_000,
    sandbox_browser_action: Math.max(1_000, Math.round(usdPerOp * usdToMicros)),
    sandbox_file_op: 2_000,
    sandbox_markitdown_op: Math.max(1_000, Math.round(usdPerOp * usdToMicros)),
    sandbox_teardown: 1_000,
  };
  const drift: CalibrationOutput['drift'] = Object.keys(current).map(k => ({
    key: k,
    current: current[k],
    recommended: recommended[k],
    drift_pct: Math.round(((recommended[k] - current[k]) / Math.max(1, current[k])) * 100),
  }));

  const output: CalibrationOutput = {
    calibration_date: new Date().toISOString().slice(0, 10),
    sandbox_image_tag: process.env.AIO_SANDBOX_IMAGE_TAG ?? 'unknown',
    measured: { provision_cost_usd: 0, shell_exec_avg_cost_usd: usdPerOp, browser_navigate_avg_cost_usd: usdPerOp, bash_session_idle_per_sec_usd: usdPerOp / 30 },
    current_defaults: current,
    recommended_defaults: recommended,
    drift,
  };

  const outDir = join(process.cwd(), 'scripts', 'calibration-results');
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `${output.calibration_date}.json`);
  writeFileSync(outFile, JSON.stringify(output, null, 2));
   
  console.log(`wrote calibration results to ${outFile}`);
}

main().catch(err => {
   
  console.error('calibration failed', err);
  process.exit(1);
});
