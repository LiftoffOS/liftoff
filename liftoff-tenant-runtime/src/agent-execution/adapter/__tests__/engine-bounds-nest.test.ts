/**
 * The four bounds on an engine turn nest, largest outermost.
 *
 * They were set one at a time, each with a sound argument for itself and none
 * against the others, and the stack came out inverted:
 *
 *   a single tools/call                       180,000 ms
 *   what we TELL the engine a call may take   690,000 ms
 *   the turn those calls live inside          180,000 ms   <- shorter than a call
 *   the HTTP request carrying the turn        300,000 ms   <- undici's default, unset
 *
 * Each failure moved outward as the inner bound was fixed. The flat turn
 * ceiling cut a sweep off mid-sentence at 183 s; raising it surfaced undici's
 * 300 s default, which nobody had written down, and the next run died at 302.4 s
 * with `TypeError: fetch failed` — engine healthy, 27 tool calls served, a
 * document written, the socket giving up on its own schedule.
 *
 * So this asserts the ORDER rather than any number. A future change to one of
 * them fails here rather than in a live run five minutes in.
 */
import {
  liftoffMcpServerTimeoutMs,
  turnDeadlineMs,
  turnIdleTimeoutMs,
} from '../opencode/index';
import { longestDispatchTimeoutMs } from '../dispatch-timeout';

describe('the bounds on a turn nest', () => {
  const KEYS = [
    'OPENCODE_TURN_TIMEOUT_MS',
    'OPENCODE_TURN_IDLE_TIMEOUT_MS',
    'MCP_DISPATCH_TIMEOUT_MS',
  ] as const;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => { for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('a turn outlives the longest call it may contain', () => {
    // The defect this is for: a turn of 180 s containing calls we permit to
    // take 690 s. A call that cannot finish inside its own turn is a call that
    // can only ever be abandoned.
    expect(turnDeadlineMs()).toBeGreaterThan(liftoffMcpServerTimeoutMs());
  });

  it('the advertised per-call timeout covers what the bridge will actually wait', () => {
    // We tell the engine one number for every tool on the server, so it has to
    // cover the slowest, or the engine abandons a call the bridge is serving.
    expect(liftoffMcpServerTimeoutMs()).toBeGreaterThanOrEqual(longestDispatchTimeoutMs());
  });

  it('the idle bound is shorter than the absolute one', () => {
    // Otherwise the absolute ceiling always fires first and silence — the
    // failure that is actually detectable — is never what ends a turn.
    expect(turnIdleTimeoutMs()).toBeLessThan(turnDeadlineMs());
  });

  it('the turn ceiling clears undici default of 300s, which is why this broke', () => {
    // Not a bound we set: Node's fetch abandons a request after 300 s
    // (undici/lib/dispatcher/client.js, headersTimeout and bodyTimeout both
    // 300e3). While the turn died at 180 s it could never be reached. The
    // transport is now given a timeout derived from the turn, and this pins the
    // fact that the turn is the longer of the two.
    expect(turnDeadlineMs()).toBeGreaterThan(300_000);
  });

  it('an operator override is honoured', () => {
    // The lever stays: a short turn is useful for testing, and clamping it
    // would surprise whoever set it. Asserted only that it is obeyed — an
    // override that breaks the nesting above is the operator's decision, and
    // pinning that shape here would read as a sanctioned configuration.
    process.env.OPENCODE_TURN_TIMEOUT_MS = '60000';
    expect(turnDeadlineMs()).toBe(60_000);
  });
});
