// Compile-time check: the union `ValidationError['type']` covers every type
// the graph validators emit — the members `collectGraphErrors` spreads, the
// ones it maps inline, and the prose fences beside it.
//
// Not a test file: nothing here runs. distill-patch-closure.test.ts hands this
// file to the TypeScript compiler and asserts it produces no diagnostic, which
// is what makes a `satisfies` line bite — test files are excluded from
// `tsc --noEmit` and ts-jest runs with diagnostics off, so a check written in
// a test alone would be decoration. Each `satisfies` below is one member.

import type {
  ValidationError,
  findMissingDeliveryStep,
  findMissingArtifactWrite,
  findMissingDestinationFileWrite,
  findMissingSeriesWrite,
  findMissingIdempotencyStep,
  findMissingProvenanceRead,
  findMissingExtractionStep,
  findTopicsTheFilterWouldDrop,
  findWorkSourceWiderThanBinding,
  findUnsafeCustomerFacingCopy,
  findGuessedToolOutputFields,
  findCompanionCronsThatCannotRunTheGraph,
  findMemoryStepsOutsideScope,
  findToolCallsWithoutFailureEdge,
  findConditionsWithoutElse,
  findDegenerateFixes,
  __internalValidateWorkflowSteps,
} from '../distill-service';
import type { findWorkflowStepProblems } from '../workflow-steps-executable';
import type { findUngatedAnnouncements } from '../announce-gating';
import type { findRepeatedOutwardActions } from '../action-repetition';
import type { findMissingReplyContract } from '../reply-contract';
import type {
  findMissingProseReplyContract,
  findMissingProseDelivery,
  findUnsafeProseCopy,
} from '../prose-fences';

/** The element type a validator's declared return type carries. */
type Elem<F> = F extends (...args: never[]) => ReadonlyArray<infer E> ? E : never;
declare function elem<F>(): Elem<F>;

// ── Members spread as they are ─────────────────────────────────────────────
// triggerDeliveryErrors and topicFilterErrors are computed before the closure
// from findUndeliverableTriggers (module-local, declared ValidationError[])
// and findTopicsTheFilterWouldDrop.
void (elem<typeof findTopicsTheFilterWouldDrop>() satisfies ValidationError);
void (elem<typeof __internalValidateWorkflowSteps>() satisfies ValidationError);
void (elem<typeof findMissingDeliveryStep>() satisfies ValidationError);
void (elem<typeof findMissingExtractionStep>() satisfies ValidationError);
void (elem<typeof findMissingIdempotencyStep>() satisfies ValidationError);
void (elem<typeof findMissingProvenanceRead>() satisfies ValidationError);
void (elem<typeof findMissingArtifactWrite>() satisfies ValidationError);
void (elem<typeof findMissingDestinationFileWrite>() satisfies ValidationError);
void (elem<typeof findMissingSeriesWrite>() satisfies ValidationError);
void (elem<typeof findDegenerateFixes>() satisfies ValidationError);
void (elem<typeof findConditionsWithoutElse>() satisfies ValidationError);
void (elem<typeof findToolCallsWithoutFailureEdge>() satisfies ValidationError);
void (elem<typeof findMemoryStepsOutsideScope>() satisfies ValidationError);
void (elem<typeof findCompanionCronsThatCannotRunTheGraph>() satisfies ValidationError);
void (elem<typeof findGuessedToolOutputFields>() satisfies ValidationError);
void (elem<typeof findUnsafeCustomerFacingCopy>() satisfies ValidationError);
void (elem<typeof findWorkSourceWiderThanBinding>() satisfies ValidationError);

// ── Members the closure maps inline ────────────────────────────────────────
// The literal the closure builds from each problem, with the problem's own
// fields threaded through so a change to either side is seen here.
void ({
  type: 'unexecutable_graph',
  stepId: elem<typeof findWorkflowStepProblems>().stepId,
  detail: elem<typeof findWorkflowStepProblems>().message,
  code: elem<typeof findWorkflowStepProblems>().code,
  field: elem<typeof findWorkflowStepProblems>().field,
} satisfies ValidationError);
void ({
  type: 'ungated_announcement',
  stepId: elem<typeof findUngatedAnnouncements>().stepId,
  detail: elem<typeof findUngatedAnnouncements>().message,
} satisfies ValidationError);
void ({
  type: 'repeated_outward_action',
  stepId: elem<typeof findRepeatedOutwardActions>().stepId,
  detail: elem<typeof findRepeatedOutwardActions>().message,
} satisfies ValidationError);
void ({
  type: 'missing_reply_contract',
  stepId: elem<typeof findMissingReplyContract>().stepId,
  detail: elem<typeof findMissingReplyContract>().message,
} satisfies ValidationError);

// ── The prose fences ───────────────────────────────────────────────────────
// Outside the closure (they run when there is no graph) and typed loosely on
// their own side; the union must still name each type they emit.
void ({
  type: 'missing_prose_reply_contract',
  stepId: elem<typeof findMissingProseReplyContract>().stepId,
  detail: elem<typeof findMissingProseReplyContract>().detail,
} satisfies ValidationError);
void ({
  type: 'missing_prose_delivery',
  stepId: elem<typeof findMissingProseDelivery>().stepId,
  detail: elem<typeof findMissingProseDelivery>().detail,
} satisfies ValidationError);
void ({
  type: 'unsafe_prose_copy',
  stepId: elem<typeof findUnsafeProseCopy>().stepId,
  detail: elem<typeof findUnsafeProseCopy>().detail,
} satisfies ValidationError);

export {};
