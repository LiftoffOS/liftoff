// The vendor call for the loop: src/typesafe/client.ts's `ask`, with the
// loop's own bounds. One keep-alive client per process, the pinned model, the
// SDK at `retry: { maxRetries: 0 }`, `ask`'s own loop re-sending only on a
// connect or TLS failure or a 429 with the reference's backoff (0.5 s × 2ⁿ,
// two retries), a 503, 529, timeout or interrupted body ending the call, a
// per-request timeout of 25 s, and the task's remaining wall clock as the
// outer deadline. Each call's usage is posted synchronously before its answer
// is used: the loop does not dispatch a click, type or scroll, and does not
// accept DONE, until the row for the decision that chose it is acknowledged.
// A post that fails after its retries makes `ask` return null, which the loop
// treats as `unavailable`.

import type { Questions } from '@typesafe-ai/sdk';
import { ask, DEFAULT_ATTEMPT_TIMEOUT_MS, type AskResult } from '../../../typesafe/client';
import type { QuestionSet } from '../../../typesafe/questions';
import type { TaskClock } from '../stagehand-agent';

export interface LoopCallContext {
  tenantId: string;
  invocationId?: string;
  runtimeAgentId?: string;
  clock: TaskClock;
}

export const REQUEST_TIMEOUT_MS = DEFAULT_ATTEMPT_TIMEOUT_MS;
export const REQUEST_RETRIES = 2;

/** Test seam: the loop's calls go through here so browser tests replay
 *  recorded answers and never touch the vendor. */
export type LoopAsk = <Q extends Questions>(set: QuestionSet<Q>, state: unknown, ctx: LoopCallContext) => Promise<AskResult<Q> | null>;

let loopAsk: LoopAsk = async (set, state, ctx) => ask(set, state as never, {
  deadlineMs: Math.max(0, ctx.clock.deadlineAt - Date.now()),
  attemptTimeoutMs: REQUEST_TIMEOUT_MS,
  maxRetries: REQUEST_RETRIES,
  tenantId: ctx.tenantId,
  ...(ctx.invocationId ? { invocationId: ctx.invocationId } : {}),
  ...(ctx.runtimeAgentId ? { runtimeAgentId: ctx.runtimeAgentId } : {}),
});

export function _setLoopAskForTesting(impl: LoopAsk | null): void {
  loopAsk = impl ?? (async (set, state, ctx) => ask(set, state as never, {
    deadlineMs: Math.max(0, ctx.clock.deadlineAt - Date.now()),
    attemptTimeoutMs: REQUEST_TIMEOUT_MS,
    maxRetries: REQUEST_RETRIES,
    tenantId: ctx.tenantId,
    ...(ctx.invocationId ? { invocationId: ctx.invocationId } : {}),
    ...(ctx.runtimeAgentId ? { runtimeAgentId: ctx.runtimeAgentId } : {}),
  }));
}

export function askForLoop<Q extends Questions>(set: QuestionSet<Q>, state: unknown, ctx: LoopCallContext): Promise<AskResult<Q> | null> {
  return loopAsk(set, state, ctx);
}
