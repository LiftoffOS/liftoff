/**
 * Wait for a condition to become true, rather than guessing how long it takes.
 *
 * WHY THIS EXISTS. Two suites asserted that a fake HTTP server was holding no
 * requests open after a client had aborted — the property that says the client
 * released its sockets instead of abandoning them. Both did it this way:
 *
 *     await new Promise((r) => setTimeout(r, 50));
 *     expect(server.held()).toBe(0);
 *
 * A socket teardown is asynchronous, and `res.on('close')` fires when the event
 * loop gets to it. 50 ms is enough on an idle machine and is not enough on a
 * loaded one, so the assertion read a count that had not settled yet. Measured
 * on `origin/main` with nothing else changed: the entitlements deadline test
 * failed THREE RUNS IN FOUR, and the memory bounds test failed one in three.
 *
 * A test that fails most of the time is worse than no test. It cannot fail
 * usefully — nobody can tell the run where it caught something from the four
 * where it did not — so the habit it teaches is to re-run until green, and the
 * real regression it was written to catch goes through with everything else.
 *
 * The fix is not a longer sleep, which is the same bug with a bigger number and
 * a slower suite. It is to wait for the CONDITION and bound the wait: a client
 * that genuinely leaked its socket never settles, so the count never reaches
 * zero, the bound expires and the test fails for the reason it was written for.
 */

/** Poll `predicate` until it holds, or throw when `timeoutMs` expires.
 *
 *  The timeout is the failure path, not the happy path: a settled condition
 *  returns on the first tick that sees it, so a passing test pays one interval
 *  rather than a fixed sleep. */
export async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 5_000,
  intervalMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms: ${message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** The specific case both callers want: a fake server is holding nothing open.
 *
 *  Named rather than inlined so the failure says what was actually wrong —
 *  "still holding 1 request open" is a leaked socket, which is the defect these
 *  suites exist to catch, and it should not read as a generic timeout. */
export async function waitForNoHeldRequests(
  held: () => number,
  what: string,
  timeoutMs = 5_000,
): Promise<void> {
  await waitFor(
    () => held() === 0,
    `${what} is still holding ${held()} request(s) open — the client did not release its socket`,
    timeoutMs,
  );
}
