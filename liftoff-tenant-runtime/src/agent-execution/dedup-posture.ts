// Dedup-posture metadata (plan §4.6). Per-(canonical tool) idempotency posture
// used by the mutating-side-effect wraps (§4.4 Composio, §4.5 slack/sandbox).
//
// Default is at_most_once (the SAFE fallback — a missing entry never double-fires).
// `effectively_once` tools may carry a `vendorKeyField`: the vendor's native
// idempotency-key argument, into which we inject the deterministic step_key so a
// retry is deduplicated by the VENDOR (returns the original response) — verified
// from live vendor docs (Square idempotency_key; QuickBooks RequestId). Naturally-
// idempotent tools (act-on-existing-target deletes/updates) are also effectively_once
// with no vendorKeyField (the retry is inherently safe).
//
// NOTE: the canonical home for this is per-tool metadata in
// @liftoffos/composio-overlays (so it flows through the catalog). This map is the
// tenant-runtime projection; keep it in sync as the overlay metadata is authored.

export type DedupPolicy = 'effectively_once' | 'at_most_once';

export interface DedupPosture {
  policy: DedupPolicy;
  /** Vendor idempotency-key arg to inject (only meaningful for effectively_once). */
  vendorKeyField?: string;
}

const AT_MOST_ONCE: DedupPosture = { policy: 'at_most_once' };

// Vendor-key tools — verified the field is in Composio's tool schema AND the vendor
// dedups on it (live docs). The step_key is injected (truncated to a vendor-safe
// length) so the retry is effectively-once at the vendor.
const POSTURE: Record<string, DedupPosture> = {
  'square.refund_payment': { policy: 'effectively_once', vendorKeyField: 'idempotency_key' },
  'quickbooks.create_invoice': { policy: 'effectively_once', vendorKeyField: 'requestid' },
  'quickbooks.update_invoice': { policy: 'effectively_once', vendorKeyField: 'requestid' },
  'quickbooks.delete_bank_account': { policy: 'effectively_once', vendorKeyField: 'request_id' },
};

/** Naturally-idempotent verb prefixes (act on an existing target by id) — a retry
 *  is inherently safe (no-op / 404 / same state), so effectively_once with no key. */
const NATURAL_PREFIX = /^(?:[a-z_]+\.)(?:delete|remove|update|patch|move|mark|resolve|acknowledge|edit|trash|clear|respond|merge)/;

export function dedupPostureFor(canonicalKey: string): DedupPosture {
  const explicit = POSTURE[canonicalKey];
  if (explicit) return explicit;
  if (NATURAL_PREFIX.test(canonicalKey)) return { policy: 'effectively_once' };
  return AT_MOST_ONCE;
}

/** Max length for an injected vendor idempotency key — conservative across vendors
 *  (Square ≤45, QuickBooks RequestId ≤50). The step_key is a sha256 hex; truncating
 *  to 40 keeps it deterministic + collision-resistant (160 bits). */
export function vendorKeyFromStepKey(stepKey: string): string {
  return stepKey.slice(0, 40);
}
