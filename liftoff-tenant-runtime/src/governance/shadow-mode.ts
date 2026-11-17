// Shadow-mode helper for the governance-engine migration.
//
// Mirrors src/connectors/shadow-mode.ts for the GOVERNANCE_SERVICE_ENABLED
// flag. Critical semantic difference from the connector variant: in 'on'
// mode, an RPC failure must fail-closed (re-throw) — governance is a safety
// system, and the plan states the legacy in-process path will be STRIPPED
// post-cutover. There is no "last-known-good" legacy fallback for
// governance in on-mode.
//
// Flag semantics:
//   off    — call legacy only.
//   shadow — call both in parallel; return legacy's result; log mismatch
//            (uses `compare` if provided, else JSON.stringify equality).
//            If RPC throws, log and return legacy. If legacy throws, re-throw.
//   on     — call RPC only. If RPC throws for any reason, re-throw.

import { getGovernanceServiceMode } from './governance-service-flag';
import { logger as defaultLogger, type Logger } from '../infrastructure/logging';

export interface GovernanceShadowArgs<T> {
  operation: string;
  legacy: () => Promise<T>;
  rpc: () => Promise<T>;
  compare?: (legacyResult: T, rpcResult: T) => boolean;
  log?: Logger;
}

function defaultCompare<T>(a: T, b: T): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

export async function withGovernanceShadowAndFallback<T>(
  args: GovernanceShadowArgs<T>,
): Promise<T> {
  const mode = getGovernanceServiceMode();
  const compare = args.compare ?? defaultCompare;
  const log = args.log ?? defaultLogger;

  if (mode === 'off') return args.legacy();

  if (mode === 'shadow') {
    const [legacyRes, rpcRes] = await Promise.allSettled([args.legacy(), args.rpc()]);

    const legacyFulfilled = legacyRes.status === 'fulfilled';
    const rpcFulfilled = rpcRes.status === 'fulfilled';

    if (legacyFulfilled && rpcFulfilled) {
      if (!compare(legacyRes.value, rpcRes.value)) {
        log.warn(
          {
            operation: args.operation,
            event: 'governance_shadow_mismatch',
          },
          'governance-engine shadow: result mismatch (legacy served)',
        );
      }
      return legacyRes.value;
    }

    if (legacyFulfilled && !rpcFulfilled) {
      log.warn(
        {
          operation: args.operation,
          event: 'governance_shadow_rpc_failed',
          error: (rpcRes.reason as Error)?.message,
        },
        'governance-engine shadow: RPC threw, legacy served',
      );
      return legacyRes.value;
    }

    if (!legacyFulfilled && rpcFulfilled) {
      log.warn(
        {
          operation: args.operation,
          event: 'governance_shadow_legacy_failed',
          legacyError: (legacyRes.reason as Error)?.message,
        },
        'governance-engine shadow: legacy threw (re-thrown), RPC would have succeeded',
      );
    } else if (!legacyFulfilled && !rpcFulfilled) {
      log.warn(
        {
          operation: args.operation,
          event: 'governance_shadow_both_failed',
          legacyError: (legacyRes.reason as Error)?.message,
          rpcError: (rpcRes.reason as Error)?.message,
        },
        'governance-engine shadow: both paths failed',
      );
    }
    // legacy rejected — re-throw so the caller sees the same error as before.
    // (The 'legacy fulfilled' branches above all returned.)
    if (!legacyFulfilled) {
      throw legacyRes.reason;
    }
    // unreachable — TS can't narrow through this without an explicit throw.
    throw new Error(
      'governance shadow-mode: impossible branch — legacy fulfilled but path not handled',
    );
  }

  // mode === 'on'
  //
  // FAIL-CLOSED: governance is a safety system. If the RPC throws we do NOT
  // fall back to legacy — the plan calls for the legacy in-process path to
  // be STRIPPED post-cutover, so "fail open to legacy" is not an option here.
  // Mismatches from this path therefore surface as tool-call failures,
  // blocking the action rather than permitting it.
  return await args.rpc();
}
