// Producer-side counterpart to tool-error-envelope.ts: extract the structured
// tool-error contract from a *thrown* connector failure, regardless of the
// concrete shape it arrived in. Two shapes carry the authoritative contract:
//
//  - `ToolExecutionError` (./types) — native / connector-service throws expose
//    the full contract on `.contract`.
//  - `NormalizedToolError` (@liftoffos/composio-overlays `defaultComposioErrorMap`)
//    — the composio-overlay dispatch path throws an `Error` subclass carrying
//    `.code`/`.retryable`/`.retryAfterMs`, mapped precisely from the vendor's
//    HTTP status. This is the COMMON path for composio-managed tools
//    (Gmail/GitHub/Slack/…).
//
//  - `AdmissionDeniedError` (../admission/types) — the platform admission gate
//    refusing the call. Not a connector failure at all, which is exactly why it
//    needs to be extracted here: left to the message heuristic it classified as
//    `internal_error` and the model was told to treat a policy decision as an
//    outage.
//
// Returns `undefined` for raw infra Errors, so callers fall back to a
// message-heuristic classification. Unifying both shapes here keeps the
// model-facing TOOL_ERROR envelope AND the /activity audit code anchored to the
// code the origin computed — connector-types explicitly documents that composio
// failures must NOT be re-run through `classifyError`.

import { ToolExecutionError } from './types';
import { isToolErrorCode, type ToolErrorCode } from '@liftoffos/connector-types';
import { AdmissionDeniedError, ADMISSION_DENIED_CODE, admissionDeniedRecovery } from '../admission/types';

export interface ExtractedToolErrorContract {
  code: ToolErrorCode;
  retryable?: boolean;
  retryAfterMs?: number;
  /** Present only on ToolExecutionError; NormalizedToolError leaves it to the
   *  code-derived default (recoveryFor). */
  recovery?: string;
  message: string;
}

export function extractToolErrorContract(error: unknown): ExtractedToolErrorContract | undefined {
  // Checked before the generic `.code` branch below purely for the richer
  // contract: the branch there would accept `admission_denied` as a valid code
  // but would not attach the reason-first recovery text this one builds.
  if (error instanceof AdmissionDeniedError) {
    return {
      code: ADMISSION_DENIED_CODE,
      retryable: false,
      recovery: admissionDeniedRecovery(error.reason),
      message: error.message,
    };
  }
  if (error instanceof ToolExecutionError) {
    const c = error.contract;
    return {
      code: c.code,
      retryable: c.retryable,
      retryAfterMs: c.retryAfterMs,
      recovery: c.recovery,
      message: c.message,
    };
  }
  // NormalizedToolError is an Error subclass carrying a valid ToolErrorCode.
  if (error instanceof Error && isToolErrorCode((error as { code?: unknown }).code)) {
    const e = error as Error & { code: ToolErrorCode; retryable?: boolean; retryAfterMs?: number };
    return {
      code: e.code,
      retryable: e.retryable,
      retryAfterMs: e.retryAfterMs,
      message: e.message,
    };
  }
  return undefined;
}
