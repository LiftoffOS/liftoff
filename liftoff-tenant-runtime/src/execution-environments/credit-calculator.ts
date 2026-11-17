// Sandbox Cost Calculator
// All arithmetic is integer-based — no floating point in the billing path.
// Internal unit is the micro-credit (μcr): 1 μcr = $0.000001 USD.
// The legacy `credits` unit (1 credit = $0.001 USD) is derived at write time
// via Math.ceil(μcr / 1000) so existing downstream readers (insights,
// invocations.sandbox_cost_credits) keep working unchanged while the
// internal billing path runs at 1000× higher precision.
//
// Calibration baseline (June 2026):
//   Cloud Run Tier 1 (us-west1) instance-based billing:
//     vCPU-second   $0.000024
//     GiB-second    $0.0000025
//   aio-sandbox instance shape: 4 vCPU + 8 GiB
//     per-second infra cost = 4 × $0.000024 + 8 × $0.0000025 = $0.0001160/sec
//
// Cost model (one meter wins — never double-counts):
//   • The instance is the thing we pay Google for. Every sandbox runs ONE
//     Cloud Run instance regardless of how many PTYs / browser tabs / file
//     watchers / bash sessions are open inside it. The `instance_alive`
//     phase is the only per-second billing.
//   • Per tool call: a small flat `exec` charge covers orchestration
//     overhead (JWT signing, HTTP roundtrip, audit write, sanitization).
//     The compute time the call took is already billed via instance_alive.
//   • Per provision: a flat `provision` charge covers image pull + cold
//     start beyond steady-state alive billing.
//   • Per teardown: a small flat charge.
//
// All rates are overridable via the credit_cost_model table; the values
// below are the seed defaults that ship with the image. The quarterly
// calibration script (scripts/calibrate-sandbox-credits.ts) measures
// realised cost against these and proposes deltas when drift > 10 %.

import { SandboxPhase } from './types';
import { log } from '../infrastructure/logging';

/** 1 micro-credit = 1e-6 USD. The internal unit of all sandbox billing. */
export const MICRO_CREDITS_PER_USD = 1_000_000;
/** 1 credit = 1e-3 USD = 1000 micro-credits. Legacy unit for downstream readers. */
export const MICRO_CREDITS_PER_CREDIT = 1000;

/**
 * Convert micro-credits → legacy `credits` rounding UP so we never undercharge.
 * Reports that read sandbox_cost_credits keep working unchanged; the rounding
 * is at most $0.0009/operation against us, which the calibration loop trims.
 */
export function microCreditsToCredits(microCredits: number): number {
  return Math.ceil(microCredits / MICRO_CREDITS_PER_CREDIT);
}

/**
 * Default rates in MICRO-CREDITS. Anchored to live Cloud Run Tier 1 pricing
 * for 4 vCPU + 8 GiB instances ($0.0001160/sec infrastructure cost).
 */
const DEFAULT_RATES_MICRO_CREDITS: Record<string, number> = {
  // Flat charges
  // 30000 μcr = $0.030 covers ~60 s cold start ($0.00696 infra) with ops markup.
  sandbox_provision: 30_000,
  // 2000 μcr = $0.002 covers orchestration per call. The compute time the
  // call took is billed via instance_alive separately.
  sandbox_exec: 2_000,
  sandbox_teardown: 1_000,
  // Per-tool-family overrides. File ops have trivial overhead vs. browser
  // ops; the calibration loop can tune these independently if needed.
  sandbox_file_op: 2_000,
  sandbox_browser_action: 3_000,
  sandbox_markitdown_op: 2_000,

  // Per-second alive rate
  // 232 μcr/sec = $0.000232/sec = 2× actual infra cost ($0.0001160/sec).
  // 60 s of alive time = 13920 μcr = $0.01392 (matches calibrated Cloud Run
  // billing within calibration tolerance).
  sandbox_instance_alive_sec: 232,

  // MCP-from-sandbox dispatch: zero on the sandbox side. The MCP execution
  // boundary charges via ingestEventWithBuckets exactly once at the
  // governance pipeline, same as LLM-loop calls. Sandbox→runtime hop is free.
  sandbox_mcp_dispatch: 0,
};

export interface CreditCostLookup {
  actionType: string;
  connector: string;
}

export interface CreditCostProvider {
  /** Returns the rate for the action in MICRO-CREDITS. */
  getCreditCost(tenantId: string, lookup: CreditCostLookup): Promise<number>;
}

const CONNECTOR = 'execution_environment';

/**
 * Per-call execute charge (flat). Compute time spent inside the call is
 * already billed by the instance_alive ticker — billing both would
 * double-count.
 */
export async function calculateExecuteMicroCredits(
  costProvider: CreditCostProvider,
  tenantId: string,
  toolName: string,
): Promise<number> {
  const actionType = toolName.startsWith('browser_')
    ? 'sandbox_browser_action'
    : toolName.startsWith('file_')
    ? 'sandbox_file_op'
    : toolName === 'util_convert_to_markdown'
    ? 'sandbox_markitdown_op'
    : 'sandbox_exec';
  return costProvider.getCreditCost(tenantId, { actionType, connector: CONNECTOR });
}

/**
 * Instance-alive charge for a window of (now - last_billed_at). Integer
 * arithmetic in micro-credits — never under-bills (we bill the exact wall
 * time, rounded UP at the second boundary to the nearest μcr).
 */
export async function calculateInstanceAliveMicroCredits(
  costProvider: CreditCostProvider,
  tenantId: string,
  elapsedMs: number,
): Promise<number> {
  if (elapsedMs <= 0) return 0;
  const rate = await costProvider.getCreditCost(tenantId, {
    actionType: 'sandbox_instance_alive_sec',
    connector: CONNECTOR,
  });
  return rate * Math.ceil(elapsedMs / 1000);
}

/**
 * Phase-driven entry point used by the executor and the alive ticker. Picks
 * the right rate lookup for each phase and returns credits (rounded up from
 * μcr at write time so downstream `sandbox_cost_credits` readers never see
 * fractional values). Callers that already know the phase (e.g. the alive
 * ticker) can call `calculateInstanceAliveMicroCredits` directly for μcr
 * precision.
 */
export async function calculateSandboxCredits(
  phase: SandboxPhase,
  wallClockMs: number,
  costProvider: CreditCostProvider,
  tenantId: string,
  toolName?: string,
): Promise<number> {
  let micros: number;
  switch (phase) {
    case 'provision':
      micros = await costProvider.getCreditCost(tenantId, { actionType: 'sandbox_provision', connector: CONNECTOR });
      break;
    case 'teardown':
      micros = await costProvider.getCreditCost(tenantId, { actionType: 'sandbox_teardown', connector: CONNECTOR });
      break;
    case 'instance_alive':
      micros = await calculateInstanceAliveMicroCredits(costProvider, tenantId, wallClockMs);
      break;
    case 'execute':
      micros = await calculateExecuteMicroCredits(costProvider, tenantId, toolName ?? 'shell_exec');
      break;
    default: {
      const exhaustiveCheck: never = phase;
      throw new Error(`unknown phase: ${exhaustiveCheck as string}`);
    }
  }
  const credits = microCreditsToCredits(micros);
  log.debug({
    message: 'Sandbox credit calculation',
    phase,
    wallClockMs,
    microCredits: micros,
    legacyCredits: credits,
  });
  return credits;
}

/**
 * Default-rate lookup used when no `credit_cost_model` row matches. Returns
 * MICRO-credits (NOT legacy credits) — callers wanting the legacy unit
 * should run microCreditsToCredits() on the result.
 */
export function getDefaultSandboxCreditCost(actionType: string): number {
  return DEFAULT_RATES_MICRO_CREDITS[actionType] ?? DEFAULT_RATES_MICRO_CREDITS.sandbox_exec;
}
