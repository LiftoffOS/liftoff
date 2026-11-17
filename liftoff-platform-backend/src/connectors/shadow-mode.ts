// Shadow-mode + fail-closed helper for the connector-service migration.
//
// Every platform-backend call site that is being migrated from the legacy
// in-process path to the connector-service RPC wraps its two
// implementations with `withShadowAndFallback`:
//
//   const result = await withShadowAndFallback({
//     method: 'listFunctionalTypes',
//     legacy: () => [...STATIC_FUNCTIONAL_CONNECTOR_TYPES],
//     rpc:    () => client.getFunctionalTypes({tenantContext}).then(r => r.connectorTypes),
//     compare: (a, b) => isEqualSorted(a, b),
//   });
//
// Behaviour by CONNECTOR_SERVICE_ENABLED:
//
//   off    — `legacy()` runs. `rpc()` is never invoked. The default.
//
//   shadow — BOTH paths run in parallel via Promise.allSettled. Results
//            are compared with the caller-supplied `compare` function.
//            Any mismatch is logged at WARN with both payloads redacted
//            of obvious secrets (access_token, api_key, private_key).
//            The LEGACY path's result is returned — any divergence is
//            logged but never served. Used for 48h validation before
//            cutover.
//
//   on     — `rpc()` runs first. On network-level failure (connection
//            refused, DNS, timeout) OR Unavailable/Internal Connect-RPC
//            codes, the call falls back to `legacy()`. Other RPC errors
//            (4xx-style: InvalidArgument, NotFound, FailedPrecondition,
//            PermissionDenied) surface as-is so callers see real user
//            errors promptly. This is the plan's "fail-closed" — if we
//            can't reach the service, serve the last-known-good legacy
//            path rather than returning a stale error.
//
// Tests for every branch live in shadow-mode.test.ts.

import { getConnectorServiceMode } from './connector-service-client';
import { log } from '../infrastructure/logging';

// gRPC status codes indicating a transient network-layer failure.
// Values are from the gRPC spec and are stable across library versions.
const NETWORK_LEVEL_GRPC_CODES = new Set([2, 4, 10, 13, 14]); // Unknown, DeadlineExceeded, Aborted, Internal, Unavailable

export interface ShadowModeArgs<T> {
  /** Human-readable method label for logs. */
  method: string;
  /** Legacy in-process implementation. Must NOT call out to the RPC. */
  legacy: () => Promise<T>;
  /** New connector-service RPC path. */
  rpc: () => Promise<T>;
  /**
   * Deep-compare callback. Return true iff the two results are
   * semantically equivalent. The default is reference equality — you'll
   * almost always want to override.
   */
  compare?: (legacyResult: T, rpcResult: T) => boolean;
  /**
   * Redact a value before logging it. Defaults to the generic redactor
   * that scrubs `accessToken` / `apiKey` / `privateKey` / `refreshToken`.
   */
  redact?: (value: T) => unknown;
}

const DEFAULT_SENSITIVE_KEYS = new Set([
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'apiKey',
  'api_key',
  'privateKey',
  'private_key',
  'clientSecret',
  'client_secret',
]);

function defaultRedact(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(defaultRedact);
  if (typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (DEFAULT_SENSITIVE_KEYS.has(k)) {
      out[k] = typeof v === 'string' && v.length > 0 ? `***${v.length}***` : v;
    } else {
      out[k] = defaultRedact(v);
    }
  }
  return out;
}

function isNetworkLevelConnectError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as Record<string, unknown>;
  return e['name'] === 'ConnectError' && NETWORK_LEVEL_GRPC_CODES.has(e['code'] as number);
}

function isNodeNetworkError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return (
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'ENOTFOUND' ||
    code === 'EHOSTUNREACH'
  );
}

/**
 * Execute the dual-path pattern. Returns the value from the active path
 * for the current feature flag.
 */
export async function withShadowAndFallback<T>(args: ShadowModeArgs<T>): Promise<T> {
  const mode = getConnectorServiceMode();
  const compare = args.compare ?? ((a, b) => a === b);
  const redact = args.redact ?? defaultRedact;

  if (mode === 'off') {
    return args.legacy();
  }

  if (mode === 'shadow') {
    const [legacyRes, rpcRes] = await Promise.allSettled([args.legacy(), args.rpc()]);

    // Both fulfilled — compare.
    if (legacyRes.status === 'fulfilled' && rpcRes.status === 'fulfilled') {
      if (!compare(legacyRes.value, rpcRes.value)) {
        log.warn(
          {
            method: args.method,
            event: 'shadow_mode_mismatch',
            legacy: redact(legacyRes.value),
            rpc: redact(rpcRes.value),
          },
          'connector-service shadow mode: result mismatch (legacy served)',
        );
      } else {
        log.debug(
          { method: args.method, event: 'shadow_mode_match' },
          'connector-service shadow mode: results match',
        );
      }
      return legacyRes.value;
    }

    // Legacy succeeded, RPC failed.
    if (legacyRes.status === 'fulfilled') {
      log.warn(
        {
          method: args.method,
          event: 'shadow_mode_rpc_failed',
          error: ((rpcRes as PromiseRejectedResult).reason as Error).message,
        },
        'connector-service shadow mode: RPC threw, legacy served',
      );
      return legacyRes.value;
    }

    // Legacy failed.
    if (rpcRes.status === 'fulfilled') {
      log.warn(
        {
          method: args.method,
          event: 'shadow_mode_legacy_failed',
          legacyError: (legacyRes.reason as Error).message,
        },
        'connector-service shadow mode: legacy threw, RPC would have served (legacy re-thrown)',
      );
    } else {
      log.warn(
        {
          method: args.method,
          event: 'shadow_mode_both_failed',
          legacyError: (legacyRes.reason as Error).message,
          rpcError: (rpcRes.reason as Error).message,
        },
        'connector-service shadow mode: both paths failed (legacy re-thrown)',
      );
    }
    throw legacyRes.reason;
  }

  // mode === 'on'
  try {
    return await args.rpc();
  } catch (err) {
    if (isNetworkLevelConnectError(err) || isNodeNetworkError(err)) {
      log.warn(
        {
          method: args.method,
          event: 'rpc_fallback',
          error: (err as Error).message,
        },
        'connector-service unreachable; serving legacy path (fail-closed to last-known-good)',
      );
      return args.legacy();
    }
    // User-actionable RPC errors bubble up.
    throw err;
  }
}

// Re-export helpers so callers can write their own `compare` functions
// without importing from deep inside the module.
export const _testUtils = { defaultRedact, isNetworkLevelConnectError, isNodeNetworkError };
