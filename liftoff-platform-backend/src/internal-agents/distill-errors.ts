// Typed distillation outcomes the stream router turns into error codes.
//
// In its own module, away from distill-service.ts, for the same reason
// DistillationStructuralError lives in trigger-config-analyzer.ts: the router
// tests mock the service wholesale, and an `instanceof` against a class that
// the mock did not export is a TypeError, not a false.

/**
 * The graph never converged, and the hire cannot ship without one.
 *
 * A distillation used to end this state with "completed successfully": the
 * last attempt's steps were dropped and the artifact went out prose-only, so
 * a scheduled sweep with a declared idempotency check, a document to write
 * and a series to compare was created with none of them enforced, and the
 * completion screen looked exactly like a hire that had all three. The
 * downgrade is now an outcome the caller sees: the stream router turns this
 * into `errorCode: 'graph_not_converged'`. Conversational hires with no
 * structural obligation may still ship prose-only, and a redistill keeps its
 * incumbent graph instead — see the terminal decision in the retry loop.
 */
export class DistillationGraphNotConvergedError extends Error {
  constructor(
    public readonly reasons: string[],
    public readonly stepCount: number,
    attempts: number,
  ) {
    super(`workflow graph did not converge after ${attempts} attempts (${reasons.join(', ')})`);
    this.name = 'DistillationGraphNotConvergedError';
  }
}
