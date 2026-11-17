import { EnsureSessionError_Kind } from '@liftoffos/proto-gen/dist/liftoff/platform/v1/browser_sessions_pb.js';
import { AnchorError } from '../integrations/web-fetch/anchor-client';
import {
  BrowserUseError, PlatformBrowserUnavailable,
} from '../integrations/web-fetch/browser-use-client';
import { SteelError } from '../integrations/web-fetch/steel-client';
import { SessionVendorAtCapacity, NoSessionVendorConnected } from './session-errors';
import { BYOKVendorError } from '../integrations/web-fetch/types';

// Outcome of attempting to classify an ensureSessionForThread failure into one
// of the user-facing kinds the frontend can render meaningful copy for. Null
// means "this error doesn't have a meaningful UI branch" — the service path
// rethrows it so it surfaces as ConnectError.Internal / HTTP 500, exactly the
// way unclassified errors did before this envelope existed.
export interface ClassifiedEnsureError {
  kind: EnsureSessionError_Kind;
  message: string;
}

// Mapping rationale per kind:
//   QUOTA_EXCEEDED — BYOK key is structurally valid but the upstream account
//     is out of credits. The user has to top up Anchor; retrying without action
//     will fail identically. Frontend surfaces a "your Anchor account is out of
//     credits" copy with a deep link to the connector settings.
//   INVALID_KEY — BYOK key was rejected (401/403). Same idea as quota but the
//     remediation is "reconnect your Anchor key" instead of "top up".
//   ANCHOR_UNAVAILABLE — Network failures, 5xx, 429 rate limits. Transient by
//     definition; frontend shows a generic "Anchor is temporarily unavailable"
//     copy with a Try Again button.
//   UNKNOWN — Classified-but-not-known: an AnchorError or BYOKVendorError we
//     didn't pattern-match cleanly. Frontend renders generic "Could not start
//     the browser" copy with Try Again. Distinct from `null` (returned when
//     the error isn't a vendor error at all — e.g. a DB error during INSERT)
//     because UNKNOWN is still a typed envelope the frontend can render; null
//     means "let it bubble as a 5xx".
export function classifyEnsureError(err: unknown): ClassifiedEnsureError | null {
  if (err instanceof BYOKVendorError) {
    switch (err.code) {
      case 'insufficient_funds':
        return { kind: EnsureSessionError_Kind.QUOTA_EXCEEDED, message: err.message };
      case 'invalid_key':
        return { kind: EnsureSessionError_Kind.INVALID_KEY, message: err.message };
      case 'rate_limited':
      case 'vendor_down':
        return { kind: EnsureSessionError_Kind.ANCHOR_UNAVAILABLE, message: err.message };
    }
    return { kind: EnsureSessionError_Kind.UNKNOWN, message: err.message };
  }
  // Every browser on the plan is open. Retryable in the truest sense: a slot
  // frees as soon as any session ends, so the pane should offer Try Again
  // rather than a dead end.
  if (err instanceof SessionVendorAtCapacity) {
    return { kind: EnsureSessionError_Kind.ANCHOR_UNAVAILABLE, message: err.message };
  }
  // The platform's own key failed. The workspace has nothing to fix, so a
  // retryable failure is the honest branch for the transient half and a
  // quota-shaped one for the half that needs a human on our side.
  if (err instanceof PlatformBrowserUnavailable) {
    return {
      kind: err.retryable
        ? EnsureSessionError_Kind.ANCHOR_UNAVAILABLE
        : EnsureSessionError_Kind.QUOTA_EXCEEDED,
      message: err.message,
    };
  }
  // No vendor at all, which since the platform key exists means an operator
  // switched the browser off. Typed rather than a 500: the pane can say the
  // browser is unavailable instead of showing a crash.
  if (err instanceof NoSessionVendorConnected) {
    return { kind: EnsureSessionError_Kind.ANCHOR_UNAVAILABLE, message: err.message };
  }
  // A raw Browser Use failure, mapped on the same status rules as Anchor's. It
  // fell through to null before this, so every Browser Use spawn failure
  // reached the pane as an unclassified 500 and the typed envelope — the whole
  // point of which is to tell a person WHY the browser did not open — only ever
  // worked for one of the two vendors that can own a pane.
  // Steel, on the same status rules. It is the platform's first-choice pane
  // vendor, so leaving it out would put the typed envelope back to covering
  // only the vendors a workspace brought.
  if (err instanceof BrowserUseError || err instanceof SteelError) {
    const s = err.statusCode;
    if (s === 0 || s >= 500) {
      return { kind: EnsureSessionError_Kind.ANCHOR_UNAVAILABLE, message: err.message };
    }
    if (s === 401 || s === 403) {
      return { kind: EnsureSessionError_Kind.INVALID_KEY, message: err.message };
    }
    if (s === 402) {
      return { kind: EnsureSessionError_Kind.QUOTA_EXCEEDED, message: err.message };
    }
    if (s === 429) {
      return { kind: EnsureSessionError_Kind.ANCHOR_UNAVAILABLE, message: err.message };
    }
    return { kind: EnsureSessionError_Kind.UNKNOWN, message: err.message };
  }
  if (err instanceof AnchorError) {
    const s = err.statusCode;
    // statusCode === 0 is the network-failure sentinel set in anchor-client's
    // catch around `fetch(...)`. Treat it identically to a 5xx — transient.
    if (s === 0 || s >= 500) {
      return { kind: EnsureSessionError_Kind.ANCHOR_UNAVAILABLE, message: err.message };
    }
    if (s === 401 || s === 403) {
      return { kind: EnsureSessionError_Kind.INVALID_KEY, message: err.message };
    }
    if (s === 402) {
      return { kind: EnsureSessionError_Kind.QUOTA_EXCEEDED, message: err.message };
    }
    if (s === 429) {
      return { kind: EnsureSessionError_Kind.ANCHOR_UNAVAILABLE, message: err.message };
    }
    return { kind: EnsureSessionError_Kind.UNKNOWN, message: err.message };
  }
  return null;
}
