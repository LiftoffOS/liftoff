// Side-channel for a human-approved write/outbound capability call.
//
// A `run_capability` call whose opaque handle is marked write/outbound-class
// pauses at the admission gate for human approval — like any outbound tool. But
// unlike an ordinary tool, its execution is a call BACK to platform-backend,
// which re-derives the class and refuses a write unless it is told a human
// approved THIS call. So the runtime must carry that approval from the gate
// (which sees the operator decision on resume) to the run_capability handler
// (which makes the backend call).
//
// The two run in the SAME process, one request apart — the gate's canUseTool
// and the tool dispatch — so a module-level registry is genuinely shared
// between them. This is exactly the gateway-pause-signal pattern, in the other
// direction: the gate RECORDS an approval, the handler CONSUMES it. Nothing the
// model controls can reach this map, which is the whole point — the approval
// must not be forgeable from a tool argument.
//
// Keyed by (invocation, capabilityId, args) so it authorises one specific call
// and cannot be replayed onto a different one, and is consumed on read so it
// cannot authorise the same call twice.

import { canonicalJson } from '../agent-execution/sideeffect-idempotency';

/** The approval key for a specific run_capability call in a specific run, built
 *  from the WHOLE tool input so it matches, byte for byte, the signature the
 *  admission gate resolves the operator decision against. The gate passes its
 *  canUseTool `args`; the handler passes its `payload` — the same object. */
export function capabilityApprovalKey(
  invocationId: string | undefined,
  input: Record<string, unknown> | undefined,
): string | null {
  if (!invocationId) return null;
  const capabilityId = input?.capabilityId;
  if (typeof capabilityId !== 'string' || !capabilityId) return null;
  return `${invocationId}|${canonicalJson(input ?? {})}`;
}

const approved = new Set<string>();

/** The gate records that a human approved this exact write-class capability call
 *  on resume. No-op for a key that cannot be built (missing invocation). */
export function recordCapabilityApproval(key: string | null): void {
  if (!key) return;
  approved.add(key);
}

/** The handler consumes the approval: returns true exactly once for a recorded
 *  key, then forgets it, so a later identical call must be approved afresh. */
export function consumeCapabilityApproval(key: string | null): boolean {
  if (!key) return false;
  return approved.delete(key);
}

/** Whether a capabilityId is marked write/outbound-class — read from the
 *  plaintext class marker platform-backend mints into the handle, WITHOUT
 *  decrypting it (the runtime cannot, and must not learn the vendor). The
 *  marker is only a gate hint; platform-backend re-derives the true class and
 *  refuses an unapproved write regardless, so a stripped marker degrades to a
 *  refusal, never an unapproved run. */
export function capabilityHandleNeedsApproval(capabilityId: unknown): boolean {
  return typeof capabilityId === 'string' && capabilityId.startsWith('cap_w.');
}

const HANDLE_SEGMENTS = /^cap_[wr]\.([0-9a-f]{12})(?:\.([a-z_]{1,32}))?\.[A-Za-z0-9_-]+$/;

/**
 * The operation a handle names, as the vendor-neutral fingerprint the control
 * plane minted into it: `cap_<w|r>.<operation>[.<family>].<ciphertext>`. Read
 * by format, like the class marker — the runtime holds no key to the rest and
 * needs none. Null for a handle minted before the segment existed, or for
 * anything that is not a handle.
 */
export function capabilityOperationOf(capabilityId: unknown): string | null {
  if (typeof capabilityId !== 'string') return null;
  const m = HANDLE_SEGMENTS.exec(capabilityId);
  return m ? m[1] : null;
}

/**
 * The family of the act a handle names (`mail_send`), when the control plane
 * put one there. The family is the only thing that lets a capability be
 * matched against a direct connector act of the same kind; a handle with
 * none is matched against nothing but itself.
 */
export function capabilityFamilyOf(capabilityId: unknown): string | null {
  if (typeof capabilityId !== 'string') return null;
  const m = HANDLE_SEGMENTS.exec(capabilityId);
  return m?.[2] ?? null;
}

/** The capability's call arguments, in whatever shape the model proposed them.
 *
 *  The schema declares `args` as an object, but a model carries the same
 *  content in three observed shapes: under `args` (an object), under
 *  `arguments` (an object, or a JSON-encoded string), or flattened — the
 *  fields placed at the top level beside `capabilityId`. A call that reached
 *  this handler must run with the arguments it was proposed and (for a write)
 *  approved with, not with an empty set. Reads only; `payload` is never
 *  reshaped, because the approval for a write is keyed to the payload exactly
 *  as the gate saw it. A string that is not a JSON object reads as no
 *  arguments rather than a guess. */
export function readCapabilityArgs(payload: Record<string, unknown>): Record<string, unknown> {
  const isPlainObject = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === 'object' && !Array.isArray(v);
  if (isPlainObject(payload.args)) return payload.args;
  const alt = payload.arguments;
  if (isPlainObject(alt)) return alt;
  if (typeof alt === 'string' && alt.trim().length > 0) {
    try {
      const parsed: unknown = JSON.parse(alt);
      if (isPlainObject(parsed)) return parsed;
    } catch {
      // Not JSON: there are no arguments to read.
    }
    return {};
  }
  // Flattened: everything that is not the handle is an argument.
  const flattened: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === 'capabilityId' || key === 'args' || key === 'arguments') continue;
    flattened[key] = value;
  }
  return flattened;
}
