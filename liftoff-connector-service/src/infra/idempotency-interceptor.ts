// Connect-RPC interceptor that applies Phase 0t idempotency semantics
// to designated mutating RPCs (`Execute`, `ExecuteBatch`).
//
// The proto already carries an `idempotency_key` field on Execute and
// ExecuteBatch requests. When the field is non-empty, this interceptor:
//
//   - Computes `request_hash` over what the request asks for (tracing
//     metadata excluded, keys ordered).
//   - CLAIMS the key: the row is the claim, inserted before execution, so
//     two concurrent misses cannot both run.
//   - Claim already answered + same hash: returns the cached response.
//   - Claim already answered + different hash: throws ConnectError(
//     InvalidArgument, `idempotency_key_conflict`).
//   - Claim held by another caller, not yet answered: throws ConnectError(
//     Aborted, `idempotency_key_in_flight`).
//   - Owned: delegates to the inner handler, then records the result on the
//     claim; a throw gives the claim back.
//
// Response body is serialized as JSON via Protobuf `toJson`, which
// gives a stable representation suitable for `JSON.parse` on replay.

import { Code, ConnectError, type Interceptor } from '@connectrpc/connect';
import {
  claimIdempotency,
  completeIdempotency,
  hashSemanticRequest,
  releaseIdempotency,
} from './idempotency.js';

export interface IdempotencyInterceptorOptions {
  /** RPC names the interceptor applies to. Other RPCs are passed through. */
  appliesTo?: string[];
  /** Extract (tenantId, userId) from the Connect-RPC HandlerContext. */
  extractTenant: (ctx: unknown) => { tenantId: string | null; userId: string | null };
}

const DEFAULT_APPLIES_TO = ['Execute', 'ExecuteBatch'];

export function idempotencyInterceptor(options: IdempotencyInterceptorOptions): Interceptor {
  const appliesTo = new Set(options.appliesTo ?? DEFAULT_APPLIES_TO);

  return (next) => async (req) => {
    // Only unary-request shapes carry `idempotency_key`.
    if (req.stream) return next(req);
    if (!appliesTo.has(req.method.name)) return next(req);

    const message = req.message as { idempotencyKey?: string } & Record<string, unknown>;
    const key = message?.idempotencyKey;
    if (!key || typeof key !== 'string') return next(req);

    const { tenantId, userId } = options.extractTenant(req);
    if (!tenantId) return next(req);

    // What the request asks for, not how it was carried: a caller mints a
    // fresh trace id per attempt, so hashing the whole message turned every
    // retry into a conflict and the key never replayed anything.
    const requestHash = hashSemanticRequest(message);
    const identity = { tenantId, userId, rpcName: req.method.name, key, requestHash };
    const claim = await claimIdempotency(identity);

    if (claim.kind === 'conflict') {
      throw new ConnectError('idempotency_key_conflict', Code.InvalidArgument);
    }
    if (claim.kind === 'in_flight') {
      // Another caller holds this key and has not finished. Running it too
      // is the double execution the key exists to prevent; the caller can
      // ask again once the first attempt has stored its response.
      throw new ConnectError('idempotency_key_in_flight', Code.Aborted);
    }
    if (claim.kind === 'match') {
      // Connect-RPC's UnaryResponse requires `message: Message<T>`;
      // we stored a JSON-parsed response body. Cast to the interceptor
      // return type — the shape matches at runtime.
      return {
        stream: false,
        service: req.service,
        method: req.method,
        header: new Headers(),
        trailer: new Headers(),
        message: claim.responseBody,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;
    }

    // Owned: this caller executes. A throw gives the claim back so a retry
    // can run; a response is recorded on the claim so a retry replays.
    let response;
    try {
      response = await next(req);
    } catch (err) {
      try {
        await releaseIdempotency(identity);
      } catch {
        /* best effort — the claim ages out */
      }
      throw err;
    }
    if (!response.stream) {
      try {
        await completeIdempotency({ ...identity, responseStatus: 200, responseBody: response.message });
      } catch {
        /* best effort */
      }
    } else {
      try {
        await releaseIdempotency(identity);
      } catch {
        /* best effort */
      }
    }
    return response;
  };
}
