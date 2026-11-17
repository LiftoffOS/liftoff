// A deadline for one outbound call, body read included.
//
// After an instance-level network reset, pooled keep-alive / HTTP/2 connections
// can go dead yet still be handed out, and a request on one waits for its
// caller's own timer. A call with no timer waits forever. This is the timer.
//
// Two things a bare `AbortSignal.timeout` passed to `fetch` does not give:
//
//   - The WHOLE call is bounded, not only the part the signal reaches: auth
//     header minting before the request, and the body read after it, run under
//     the same clock. A clearTimeout placed before `await response.json()` is
//     the classic way to bound the headers and leave the body unbounded.
//   - The failure is TYPED (DeadlineExceededError, naming the call and the
//     budget), so a caller can tell "it timed out" from "it failed" without
//     matching on an AbortError message.
//
// The work is aborted through the signal, and its promise is detached rather
// than left to reject unhandled if it settles after the deadline.

export class DeadlineExceededError extends Error {
  override readonly name = 'DeadlineExceededError';
  constructor(
    /** What was being waited on, e.g. "tool-gateway execute". */
    readonly label: string,
    readonly timeoutMs: number,
  ) {
    super(`${label} timed out after ${timeoutMs}ms`);
  }
}

export function isDeadlineExceeded(err: unknown): err is DeadlineExceededError {
  return err instanceof DeadlineExceededError;
}

/**
 * Run `work` under a deadline of `timeoutMs`.
 *
 * `work` receives a signal that aborts at the deadline; pass it to every
 * fetch / SDK call inside so the socket is released, not merely abandoned.
 * Rejects with DeadlineExceededError at the deadline even if `work` ignores the
 * signal. Settles with `work`'s own outcome otherwise.
 */
export async function withDeadline<T>(
  label: string,
  timeoutMs: number,
  work: (_signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const err = new DeadlineExceededError(label, timeoutMs);
      controller.abort(err);
      reject(err);
    }, timeoutMs);
    // A pending deadline must not keep a process (or a test worker) alive.
    timer.unref?.();
  });
  let running: Promise<T>;
  try {
    running = work(controller.signal);
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
  try {
    return await Promise.race([running, expired]);
  } finally {
    clearTimeout(timer);
    // Whichever lost the race: never an unhandled rejection.
    running.catch(() => undefined);
    expired.catch(() => undefined);
  }
}
