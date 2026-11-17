// Concrete-engine certification contract.
//
// Certification runs at three levels: (1) contract unit tests — the
// surface checks in certify.ts, deterministic and required on every PR; (2)
// recorded-fixture integration — the per-vendor mapper + per-adapter suites that
// replay real vendor event shapes without network; (3) live engine certification
// — real provider/SDK/CLI calls in a controlled test tenant, run before enabling
// or upgrading an engine in an environment. This module owns level 1 and the
// machine-readable result the other levels + promotion automation consume.

import type { ExecutionEngineId, ResolvedProvider } from '../adapter/types';

/** Bump when the mandatory contract categories or their checks change, so a
 * stored certification result can be matched against the contract it was run
 * under. */
export const CERTIFICATION_CONTRACT_VERSION = '1.0.0';

/** The mandatory categories every eligible outer-agent engine must
 * pass. Kept as a closed list so a new category fails compilation until every
 * engine is certified against it. */
export type CertificationCategory =
  | 'invocation_and_termination'
  | 'governed_tool_execution'
  | 'hitl_and_pause_resume'
  | 'usage_and_billing'
  | 'sessions_and_state'
  | 'trajectories_and_auditability'
  /** The engine's raw output maps to the EXACT canonical block list its
   *  fidelity fixture declares. `trajectories_and_auditability` only asserts the
   *  recorder tap exists; this asserts what comes out of it is right, which is
   *  the precondition for the canonical record being a system of record at all. */
  | 'trajectory_fidelity'
  /** The vendor SDK still honours the hook semantics the native-workspace
   *  design assumes: a throw stops the tool, a deny neither runs it nor leaks
   *  its content, a modified result is what the model sees, and hooks fire per
   *  call rather than per batch. Every governance decision we make is expressed
   *  through one of those four, so this is the category that says whether our
   *  enforcement still enforces anything. Claude-SDK-specific by nature; other
   *  engines have no hooks and pass vacuously. */
  | 'sdk_hook_contract';

export const CERTIFICATION_CATEGORIES: readonly CertificationCategory[] = [
  'invocation_and_termination',
  'governed_tool_execution',
  'hitl_and_pause_resume',
  'usage_and_billing',
  'sessions_and_state',
  'trajectories_and_auditability',
  'trajectory_fidelity',
  'sdk_hook_contract',
] as const;

export interface CertificationCheck {
  category: CertificationCategory;
  /** Stable check id (e.g. 'invoke_returns_async_iterable'). */
  name: string;
  passed: boolean;
  detail?: string;
}

/** Machine-readable certification result, one per (engine, provider) pair.
 * Stored as a CI artifact; promotion automation verifies the engine + SDK/CLI
 * version in the built image has a passing result before an engine flag is
 * flipped.
 *
 * Per PAIR, not per engine: opencode driven from xAI's account and opencode
 * driven from OpenRouter's are two configurations of one engine, and a result
 * keyed on the engine alone could only speak for whichever the probe happened
 * to pick. */
export interface EngineCertificationResult {
  engine: ExecutionEngineId;
  /** The provider the probe drove the engine as. */
  provider: ResolvedProvider;
  runtimeVersion: string;
  imageRevision: string;
  contractVersion: string;
  passed: boolean;
  /** name → passed, for the compact CI artifact (`checks` map). */
  checks: Record<string, boolean>;
  /** Full per-check detail (kept out of the compact `checks` map). */
  checkDetail: CertificationCheck[];
}
