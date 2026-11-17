/**
 * A subprocess engine gets told the work is still running, and a turn is
 * bounded by silence rather than by a stopwatch.
 *
 * Users run this engine locally against the same models and it finishes. What
 * it meets here and does not meet there is our integration, and three numbers
 * in it did not fit together:
 *
 *   a single `tools/call`                 180,000 ms  (MCP_DISPATCH_TIMEOUT_MS)
 *   what we TELL the engine a call may take 690,000 ms  (liftoffMcpServerTimeoutMs)
 *   the whole turn those calls live inside  180,000 ms  (OPENCODE_TURN_TIMEOUT_MS)
 *
 * One call was permitted to outlive its own turn fourfold, and the turn was
 * killed on wall clock whatever it was doing. A live sweep died at 183 seconds
 * with `message.part.delta` as its last event: the model was mid-sentence.
 *
 * The engine calls tools with `resetTimeoutOnProgress: true` — it is built to
 * wait longer when a server says "still working" — and this server said
 * nothing, because a buffered JSON response has nowhere to put a notification.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const PROXY = readFileSync(join(__dirname, '..', 'tool-gateway-http-mcp.ts'), 'utf8');
const OPENCODE = readFileSync(join(__dirname, '..', 'opencode', 'index.ts'), 'utf8');

describe('the proxy can say "still working"', () => {
  it('answers over SSE, not a buffered JSON body', () => {
    // A progress notification reaches the client only on the request's own
    // stream. With enableJsonResponse the transport holds every message and
    // answers once at the end, so no notification can ever be sent.
    // The OPTION, not any mention of it: the comment beside it names the mode
    // it replaced, and a naive substring match reads that as the setting.
    const options = PROXY.split('\n').filter((l) => /^\s*enableJsonResponse:/.test(l));
    expect(options).toHaveLength(1);
    expect(options[0]).toContain('false');
  });

  it('sends progress while a call runs', () => {
    expect(PROXY).toContain("method: 'notifications/progress'");
    expect(PROXY).toContain('setInterval(');
  });

  it('only when the client asked to be told', () => {
    // The spec is explicit: a server reports progress for a token it was
    // given, and for no other. An unsolicited notification is a protocol
    // violation, not a courtesy.
    expect(PROXY).toContain('progressToken');
    expect(PROXY).toMatch(/progressToken === undefined \? undefined :/);
  });

  it('stops the heartbeat when the call ends, however it ends', () => {
    // In a finally: a throwing dispatch that left an interval behind would
    // report progress for a call that is over, forever.
    const handler = PROXY.slice(PROXY.indexOf('CallToolRequestSchema'));
    const fin = handler.indexOf('} finally {');
    const clear = handler.indexOf('clearInterval(');
    expect(fin).toBeGreaterThan(-1);
    expect(clear).toBeGreaterThan(fin);
  });
});

describe('a turn is bounded by silence, not by a stopwatch', () => {
  it('has an idle bound', () => {
    expect(OPENCODE).toContain('OPENCODE_TURN_IDLE_TIMEOUT_MS');
    expect(OPENCODE).toContain('idleExpired');
  });

  it('derives the absolute ceiling from the longest call it can contain', () => {
    // WHERE the derivation lives, not its exact spelling — the arithmetic
    // itself is asserted numerically in engine-bounds-nest.test.ts, which does
    // not break when the expression is hoisted into a helper. An earlier
    // version of this pinned the inline text and failed on precisely that.
    const fn = OPENCODE.slice(OPENCODE.indexOf('export function turnDeadlineMs('));
    expect(fn.slice(0, 300)).toContain('liftoffMcpServerTimeoutMs()');
  });

  it('no longer carries the flat three-minute turn ceiling', () => {
    expect(OPENCODE).not.toContain("OPENCODE_TURN_TIMEOUT_MS) || 180_000");
  });

  it('says which bound ended the turn', () => {
    // "timed out" was true of both and distinguished neither, and the one run
    // that hit it left a 65-character reason as the only evidence.
    expect(OPENCODE).toContain("bound: idleExpired ? 'idle' : 'absolute'");
    expect(OPENCODE).toContain('went quiet for');
  });
});
