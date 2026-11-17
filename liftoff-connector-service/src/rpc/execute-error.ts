// Single seam for building a structured error ExecuteResponse. Every origin
// that produces a `success: false` connector result MUST go through here so the
// {error_code, retryable, retry_after_ms, recovery} contract is always
// populated and can never silently regress to an unclassified string. See the
// CI fence in Phase 7 that forbids constructing a failed ExecuteResponse
// outside this helper.

import { create } from '@bufbuild/protobuf';
import {
  ExecuteResponseSchema,
  type ExecuteResponse,
} from '@liftoffos/proto-gen/liftoff/connector/v1/connector_service_pb.js';
import type { ToolErrorContract } from '@liftoffos/connector-types';

export function errorResponse(e: ToolErrorContract, vendorLatencyMs?: bigint): ExecuteResponse {
  return create(ExecuteResponseSchema, {
    success: false,
    error: e.message,
    errorCode: e.code,
    retryable: e.retryable,
    retryAfterMs: BigInt(e.retryAfterMs ?? 0),
    recovery: e.recovery,
    ...(vendorLatencyMs !== undefined ? { vendorLatencyMs } : {}),
  });
}
