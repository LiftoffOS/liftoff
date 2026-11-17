// Shadow-mode + fail-closed helper for the connector-service migration.
//
// Mirror of platform-backend/src/connectors/shadow-mode.ts — duplicated
// (not shared via @liftoffos/service-client) to keep the package boundary
// small; they stay in lockstep via the behavioural test suites in both
// repos. If you change one, change the other + the test IDs.
//
// Used in tool-gateway's executeConnectorCall to gate the cutover from
// in-process connector dispatch to the connector-service RPC.

import { ConnectError, Code } from '@connectrpc/connect';
import { getConnectorServiceMode } from './connector-service-client';
import { logger } from '../infrastructure/logging';

export interface ShadowModeArgs<T> {
  method: string;
  legacy: () => Promise<T>;
  rpc: () => Promise<T>;
  compare?: (legacyResult: T, rpcResult: T) => boolean;
  redact?: (value: T) => unknown;
}

const SENSITIVE = new Set([
  'accessToken', 'access_token', 'refreshToken', 'refresh_token',
  'apiKey', 'api_key', 'privateKey', 'private_key',
  'clientSecret', 'client_secret',
]);

function defaultRedact(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(defaultRedact);
  if (typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE.has(k)
      ? (typeof v === 'string' && v.length > 0 ? `***${v.length}***` : v)
      : defaultRedact(v);
  }
  return out;
}

function isNetworkLevelConnectError(err: unknown): boolean {
  if (!(err instanceof ConnectError)) return false;
  return (
    err.code === Code.Unavailable ||
    err.code === Code.DeadlineExceeded ||
    err.code === Code.Aborted ||
    err.code === Code.Unknown ||
    err.code === Code.Internal
  );
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

export async function withShadowAndFallback<T>(args: ShadowModeArgs<T>): Promise<T> {
  const mode = getConnectorServiceMode();
  const compare = args.compare ?? ((a, b) => a === b);
  const redact = args.redact ?? defaultRedact;

  if (mode === 'off') return args.legacy();

  if (mode === 'shadow') {
    const [legacyRes, rpcRes] = await Promise.allSettled([args.legacy(), args.rpc()]);

    // Explicit narrowing helpers — PromiseSettledResult is a union where
    // `.value` only exists when fulfilled and `.reason` only when rejected.
    const legacyFulfilled = legacyRes.status === 'fulfilled';
    const rpcFulfilled = rpcRes.status === 'fulfilled';

    if (legacyFulfilled && rpcFulfilled) {
      if (!compare(legacyRes.value, rpcRes.value)) {
        logger.warn(
          {
            method: args.method,
            event: 'shadow_mode_mismatch',
            legacy: redact(legacyRes.value),
            rpc: redact(rpcRes.value),
          },
          'connector-service shadow: result mismatch (legacy served)',
        );
      }
      return legacyRes.value;
    }

    if (legacyFulfilled && !rpcFulfilled) {
      logger.warn(
        { method: args.method, event: 'shadow_mode_rpc_failed', error: (rpcRes.reason as Error)?.message },
        'connector-service shadow: RPC threw, legacy served',
      );
      return legacyRes.value;
    }

    // legacy rejected — either rpc fulfilled or both rejected
    if (!legacyFulfilled && rpcFulfilled) {
      logger.warn(
        { method: args.method, event: 'shadow_mode_legacy_failed', legacyError: (legacyRes.reason as Error)?.message },
        'connector-service shadow: legacy threw (re-thrown), RPC would have succeeded',
      );
    } else if (!legacyFulfilled && !rpcFulfilled) {
      logger.warn(
        {
          method: args.method,
          event: 'shadow_mode_both_failed',
          legacyError: (legacyRes.reason as Error)?.message,
          rpcError: (rpcRes.reason as Error)?.message,
        },
        'connector-service shadow: both paths failed',
      );
    }
    // legacyRes is rejected here — re-throw so the caller sees the same error as before
    if (!legacyFulfilled) {
      throw legacyRes.reason;
    }
    // unreachable, but TS can't narrow through this without an explicit throw
    throw new Error('shadow-mode: impossible branch — legacy fulfilled but path not handled');
  }

  // mode === 'on'
  try {
    return await args.rpc();
  } catch (err) {
    if (isNetworkLevelConnectError(err) || isNodeNetworkError(err)) {
      logger.warn(
        { method: args.method, event: 'rpc_fallback', error: (err as Error).message },
        'connector-service unreachable; serving legacy path (fail-closed to last-known-good)',
      );
      return args.legacy();
    }
    throw err;
  }
}

export const _testUtils = { defaultRedact, isNetworkLevelConnectError, isNodeNetworkError };
