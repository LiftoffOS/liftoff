// Admission failure as a typed, self-describing outcome.
//
// An admission denial is a POLICY decision — a suspended tenant, a kill switch,
// an agent that is not ACTIVE. It has a nameable reason and a human on the other
// end who can act on it. Thrown as a bare `Error`, it reaches the model as
// `TOOL_ERROR {code:"internal_error", recovery:"An internal error occurred…"}`,
// and the recovery LLM can conclude "vendor/infrastructure outage or kill-switch"
// — the one reading that guarantees nobody looks at the policy that actually
// fired. This type is what stops a policy outcome wearing the internal-error
// costume.
//
// Import-light on purpose: consumed by the tool-error contract/envelope
// modules, which the adapter recovery path reads without pulling in the MCP
// server. The only dependency is the shared error taxonomy itself.

import type { ToolErrorCode } from '@liftoffos/connector-types';

/**
 * Tool-error code for an admission denial.
 *
 * A canonical member of `@liftoffos/connector-types`' `TOOL_ERROR_CODES` since
 * 0.12.0: the taxonomy answers "why did this tool call fail", and a platform
 * policy refusal is one of the answers. `isRetryable` returns false for it
 * there — a policy gate gives the same answer to an identical call — and
 * `classifyError` can never produce it, because nothing a vendor or transport
 * does implies a platform decision. It is only ever set explicitly.
 *
 * Typed against the package so this constant cannot drift from the union; if
 * the code were ever removed upstream, this stops compiling rather than
 * silently emitting a string the parser would reject.
 *
 * The name matches the `admission_denied` anomaly kind the recovery prompt
 * already understands ("blocked by an admission policy … escalate"), which is
 * where a denial should have been landing all along.
 */
export const ADMISSION_DENIED_CODE: ToolErrorCode = 'admission_denied';

/**
 * Model-facing recovery text for a denial. Names the policy reason first, then
 * says plainly that retrying is not the answer.
 */
export function admissionDeniedRecovery(reason: string): string {
  return `${reason}. This is a policy/entitlement decision, not an outage — do not retry the same call; report it.`;
}

/**
 * Thrown when admission refuses a call. Carries the two fields the denial was
 * computed from, so every downstream surface (model envelope, HTTP status,
 * audit row, metric label) can render the real cause instead of re-deriving it
 * from a message string.
 */
export class AdmissionDeniedError extends Error {
  /** Always `admission_denied` — see ADMISSION_DENIED_CODE. */
  readonly code = ADMISSION_DENIED_CODE;
  /** Human-readable policy reason, e.g. "Tenant is suspended". */
  readonly reason: string;
  /** Which gate fired, e.g. `operational_status`, `global_freeze`. */
  readonly quotaType?: string;

  constructor(params: { reason: string; quotaType?: string; message?: string }) {
    super(params.message ?? `Admission denied: ${params.reason}`);
    this.name = 'AdmissionDeniedError';
    this.reason = params.reason;
    this.quotaType = params.quotaType;
  }
}
